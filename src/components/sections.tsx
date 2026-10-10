import { useEffect, useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Eye, EyeOff, FolderOpen, Check, AlertTriangle, RefreshCw } from "lucide-react";
import {
  api,
  errText,
  fileUrl,
  on,
  type AudioDevice,
  type EventKind,
  type EventRule,
  type GameId,
  type GameSettings,
  type HardwareInfo,
  type Levels,
  type MonitorInfo,
  type Settings,
} from "../lib/api";
import { kindLabel, bytes } from "../lib/format";
import { GAMES } from "../lib/games";
import { label, plural, t } from "../lib/i18n";
import { Button, Field, HotkeyInput, KindDot, Meter, Range, Segmented, Spinner, Toggle } from "./ui";

export type SetSettings = (fn: (s: Settings) => Settings) => void;

const even = (n: number) => n - (n % 2);

export const SOFTWARE_ENCODER = "libx264";

/** The software encoder records at most 720p / 30 fps (same caps as the backend). */
export function effectiveVideo(v: Settings["video"]): Settings["video"] {
  if (v.encoder !== SOFTWARE_ENCODER) return v;
  return { ...v, height: v.height === 0 || v.height > 720 ? 720 : v.height, fps: v.fps === 0 || v.fps > 30 ? 30 : v.fps };
}

/** Can the recording be scaled down: on the GPU, or on the CPU when the encoder is fed from there. */
export function scaleWorks(hw: HardwareInfo | null | undefined, encoder: string): boolean {
  if (!hw) return true;
  return hw.gpuScaleWorks || !!hw.encoders.find((e) => e.id === encoder)?.cpuFeed || encoder === SOFTWARE_ENCODER;
}

export function outputSize(video: Settings["video"], gpuScale = true): { w: number; h: number } | null {
  const v = effectiveVideo(video);
  const { monitorWidth: sw, monitorHeight: sh } = v;
  if (!sw || !sh) return null;
  let cw = sw;
  if (v.aspect === "16:9" && sw * 9 > sh * 16) cw = even(Math.floor((sh * 16) / 9));
  if (!gpuScale && v.encoder !== SOFTWARE_ENCODER) return { w: cw, h: sh };
  const th = v.height === 0 || v.height >= sh ? sh : v.height;
  return { w: even(Math.round((cw * th) / sh)), h: even(th) };
}

// functions, not constants: the labels follow the current language
export const PRESETS = () =>
  ({
    performance: { height: 720, fps: 60, bitrateMbps: 10, label: t("流畅", "Smooth"), hint: t("720p · 60 帧", "720p · 60 fps") },
    balanced: { height: 1080, fps: 60, bitrateMbps: 20, label: t("均衡", "Balanced"), hint: t("1080p · 60 帧", "1080p · 60 fps") },
    quality: { height: 0, fps: 60, bitrateMbps: 40, label: t("画质", "Quality"), hint: t("原生分辨率 · 60 帧", "Native · 60 fps") },
  }) as const;

/** When GPU scaling is unavailable everything is recorded at native size; presets only change bitrate. */
export const NATIVE_PRESETS = () =>
  ({
    performance: { height: 0, fps: 60, bitrateMbps: 16, label: t("省空间", "Compact"), hint: t("原生 · 16 Mbps", "Native · 16 Mbps") },
    balanced: { height: 0, fps: 60, bitrateMbps: 28, label: t("均衡", "Balanced"), hint: t("原生 · 28 Mbps", "Native · 28 Mbps") },
    quality: { height: 0, fps: 60, bitrateMbps: 45, label: t("画质", "Quality"), hint: t("原生 · 45 Mbps", "Native · 45 Mbps") },
  }) as const;

export function presetsFor(hw: HardwareInfo | null, encoder: string) {
  return scaleWorks(hw, encoder) ? PRESETS() : NATIVE_PRESETS();
}

// ---------------------------------------------------------------------------

export function MonitorPicker(props: { settings: Settings; set: SetSettings; monitors: MonitorInfo[] | null; onRefresh?: () => void }) {
  const { settings, set, monitors } = props;
  if (!monitors) {
    return (
      <div className="loading-row">
        <Spinner /> {t("正在识别显示器…", "Detecting displays…")}
      </div>
    );
  }
  if (monitors.length === 0) {
    return <p className="warn-text">{t("没有识别到可录制的显示器。确认 FFmpeg 版本支持 ddagrab。", "No display found to record. Make sure your FFmpeg build supports ddagrab.")}</p>;
  }
  return (
    <div className="monitors">
      {monitors.map((m) => {
        const on = m.index === settings.video.monitorIndex;
        return (
          <button
            type="button"
            key={m.index}
            className={"monitor" + (on ? " is-on" : "")}
            onClick={() =>
              set((s) => ({ ...s, video: { ...s.video, monitorIndex: m.index, monitorWidth: m.width, monitorHeight: m.height } }))
            }
          >
            <img src={fileUrl(m.thumbnail) + `?t=${Date.now()}`} alt="" />
            <span className="monitor-meta">
              <b>{t(`屏幕 ${m.index + 1}`, `Screen ${m.index + 1}`)}</b>
              <span>
                {m.width}×{m.height}
              </span>
            </span>
            {on && <Check className="monitor-check" size={16} />}
          </button>
        );
      })}
      {props.onRefresh && (
        <Button small kind="ghost" onClick={props.onRefresh}>
          <RefreshCw size={14} /> {t("重新识别", "Detect again")}
        </Button>
      )}
    </div>
  );
}

export function VideoSection(props: { settings: Settings; set: SetSettings; hardware: HardwareInfo | null; onRedetect?: () => void }) {
  const { settings, set, hardware } = props;
  const v = settings.video;
  const scale = scaleWorks(hardware, v.encoder);
  const P = presetsFor(hardware, v.encoder);
  const out = outputSize(v, scale);
  const sw = v.encoder === SOFTWARE_ENCODER;
  const current = hardware?.encoders.find((e) => e.id === v.encoder);
  const ultrawide = v.monitorWidth * 9 > v.monitorHeight * 16 + 10;
  const encoders = hardware?.encoders.filter((e) => e.available) ?? [];
  const setV = (patch: Partial<Settings["video"]>) => set((s) => ({ ...s, video: { ...s.video, ...patch } }));

  return (
    <div className="stack">
      <Field
        label={t("画质预设", "Quality preset")}
        hint={
          out
            ? t(
                `输出 ${out.w}×${out.h} · ${effectiveVideo(v).fps} 帧 · 约 ${v.bitrateMbps} Mbps`,
                `Output ${out.w}×${out.h} · ${effectiveVideo(v).fps} fps · ~${v.bitrateMbps} Mbps`,
              )
            : undefined
        }
      >
        <Segmented
          wide
          value={v.preset}
          onChange={(p) => {
            if (p === "custom") setV({ preset: p });
            else setV({ preset: p, height: P[p].height, fps: P[p].fps, bitrateMbps: P[p].bitrateMbps });
          }}
          options={[
            ...(["performance", "balanced", "quality"] as const).map((k) => ({
              value: k,
              label: P[k].label,
              hint: P[k].hint,
            })),
            { value: "custom" as const, label: t("自定义", "Custom"), hint: t("自己调", "Set your own") },
          ]}
        />
      </Field>

      {!scale && (
        <p className="muted small">
          {t(
            "这台电脑的 FFmpeg 显卡缩放用不了，所以按原生分辨率录（同样全程在显卡里，不掉帧），导出时再选 1080p / 720p。预设只改变码率。",
            "FFmpeg GPU scaling doesn't work on this PC, so recording is at native resolution (still fully on the GPU, no dropped frames). Pick 1080p / 720p when exporting. Presets only change the bitrate.",
          )}
        </p>
      )}

      {ultrawide && (
        <Field label={t("画面比例", "Aspect ratio")} hint={t("裁成 16:9 由显卡完成，不增加负担", "Cropping to 16:9 is done on the GPU at no extra cost")}>
          <Segmented
            value={v.aspect}
            onChange={(a) => setV({ aspect: a })}
            options={[
              { value: "native", label: t("保留超宽", "Keep ultrawide"), hint: t("完整画面，适合 B 站 / YouTube", "Full frame, good for YouTube") },
              { value: "16:9", label: t("裁成 16:9", "Crop to 16:9"), hint: t("取中间，手机和 Discord 不留黑边", "Center crop, no black bars on phones and Discord") },
            ]}
          />
        </Field>
      )}

      {v.preset === "custom" && (
        <div className="grid-2">
          {scale && <Field label={t("输出高度", "Output height")}>
            <Segmented
              value={v.height}
              onChange={(h) => setV({ height: h })}
              options={[
                { value: 720, label: "720p" },
                { value: 1080, label: "1080p" },
                { value: 1440, label: "1440p" },
                { value: 0, label: t("原生", "Native") },
              ]}
            />
          </Field>}
          <Field label={t("帧率", "Frame rate")}>
            <Segmented
              value={v.fps}
              onChange={(f) => setV({ fps: f })}
              options={[
                { value: 30, label: "30" },
                { value: 60, label: "60" },
                { value: 120, label: "120" },
              ]}
            />
          </Field>
          <Field label={t("码率上限", "Max bitrate")}>
            <Range value={v.bitrateMbps} min={6} max={80} step={2} onChange={(b) => setV({ bitrateMbps: b })} format={(b) => `${b} Mbps`} />
          </Field>
        </div>
      )}

      <Field
        label={t("编码器", "Encoder")}
        hint={
          sw
            ? t("CPU 软件编码：任何电脑都能录，但比较占 CPU，所以最高 720p · 30 帧", "CPU software encoding: works on any PC but uses a lot of CPU, so it's capped at 720p · 30 fps")
            : current?.cpuFeed
              ? t("显卡编码；这台电脑的显卡驱动要先由 CPU 转一下格式，会多占一点 CPU", "GPU encoding; this PC's driver needs the CPU to convert the format first, so it uses a bit more CPU")
              : t("用显卡的硬件编码器，几乎不占 CPU", "Uses the GPU's hardware encoder, almost no CPU")
        }
      >
        {!hardware ? (
          <p className="muted small">
            <Spinner /> {t("正在检测显卡编码器…", "Detecting GPU encoders…")}
          </p>
        ) : encoders.length === 0 ? (
          <p className="warn-text">
            {t("没有检测到可用的编码器，可能是 FFmpeg 没装好，或者显卡驱动太旧。", "No usable encoder found. FFmpeg may not be installed correctly, or the GPU driver is too old. ")}
            {props.onRedetect && (
              <button type="button" className="linkbtn" onClick={props.onRedetect}>
                {t("重新检测", "Detect again")}
              </button>
            )}
          </p>
        ) : (
          <Segmented
            value={v.encoder}
            onChange={(e) => setV({ encoder: e })}
            options={encoders.map((e) => ({
              value: e.id,
              label: e.label,
              hint:
                e.id === SOFTWARE_ENCODER
                  ? t("保底，占 CPU", "Fallback, uses CPU")
                  : e.id.startsWith("h264")
                    ? t("兼容性最好", "Best compatibility")
                    : e.id.startsWith("av1")
                      ? t("体积最小，部分播放器不支持", "Smallest files, some players can't play it")
                      : t("体积更小", "Smaller files"),
            }))}
          />
        )}
      </Field>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function AudioSection(props: { settings: Settings; set: SetSettings; gameRunning: boolean }) {
  const { settings, set } = props;
  const a = settings.audio;
  const [devices, setDevices] = useState<AudioDevice[] | null>(null);
  const [outputs, setOutputs] = useState<AudioDevice[] | null>(null);
  const [levels, setLevels] = useState<Levels>({ game: 0, mic: 0, gameError: null, micError: null });
  const [err, setErr] = useState<string | null>(null);
  const setA = (patch: Partial<Settings["audio"]>) => set((s) => ({ ...s, audio: { ...s.audio, ...patch } }));

  useEffect(() => {
    api
      .listAudioDevices()
      .then((d) => {
        setDevices(d.inputs);
        setOutputs(d.outputs);
      })
      .catch((e) => setErr(errText(e)));
  }, []);

  useEffect(() => {
    const un = on<Levels>("audio-levels", (l) =>
      setLevels((prev) => ({
        ...l,
        game: Math.max(l.game, prev.game * 0.82),
        mic: Math.max(l.mic, prev.mic * 0.82),
      })),
    );
    api.startAudioMonitor(a).catch((e) => setErr(errText(e)));
    return () => {
      un();
      api.stopAudioMonitor().catch(() => {});
    };
  }, [a.gameSource, a.systemDeviceId, a.micEnabled, a.micDeviceId, a.gameVolume, a.micVolume]);

  const outName = (id: string | null) =>
    (id ? outputs?.find((d) => d.id === id)?.name : outputs?.find((d) => d.isDefault)?.name) ?? t("默认输出设备", "Default output device");
  const gameMeterLabel =
    a.gameSource === "process" && !props.gameRunning
      ? t("PUBG 没开，先用默认输出设备的声音测试电平", "PUBG isn't running; testing levels with the default output device")
      : a.gameSource === "system"
        ? outName(a.systemDeviceId)
        : "PUBG";
  const systemDefault = (list: AudioDevice[]) => {
    const name = list.find((d) => d.isDefault)?.name ?? t("无", "none");
    return t(`系统默认（${name}）`, `System default (${name})`);
  };

  return (
    <div className="stack">
      <Field label={t("游戏声音", "Game audio")} hint={t("单独一条音轨，后期可以分开调", "Its own track, adjustable separately later")}>
        <Segmented
          value={a.gameSource}
          onChange={(g) => setA({ gameSource: g })}
          options={[
            { value: "process", label: t("只录 PUBG", "PUBG only"), hint: t("不会录进 Discord、音乐", "Leaves out Discord and music") },
            { value: "system", label: t("录一个输出设备", "An output device"), hint: t("这个设备上播放的所有声音", "Everything played on that device") },
            { value: "off", label: t("不录", "Off") },
          ]}
        />
      </Field>
      {a.gameSource === "system" && (
        <Field
          label={t("输出设备", "Output device")}
          hint={t("用 VoiceMeeter 的话，选游戏声音实际进入的那个虚拟输入，比如 VoiceMeeter Input", "With VoiceMeeter, pick the virtual input your game audio actually goes to, e.g. VoiceMeeter Input")}
        >
          {outputs ? (
            <select className="select" value={a.systemDeviceId ?? ""} onChange={(e) => setA({ systemDeviceId: e.target.value || null })}>
              <option value="">{systemDefault(outputs)}</option>
              {outputs.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          ) : (
            <Spinner />
          )}
        </Field>
      )}
      {a.gameSource !== "off" && (
        <div className="audio-row">
          <Meter label={gameMeterLabel} value={levels.game} error={levels.gameError} />
          <Range value={Math.round(a.gameVolume * 100)} min={0} max={200} step={5} onChange={(v) => setA({ gameVolume: v / 100 })} format={(v) => `${v}%`} />
        </div>
      )}

      <Field label={t("麦克风", "Mic")} hint={t("另一条音轨", "A separate track")}>
        <Toggle checked={a.micEnabled} onChange={(v) => setA({ micEnabled: v })} label={a.micEnabled ? t("录制麦克风", "Record mic") : t("不录麦克风", "Don't record mic")} />
      </Field>
      {a.micEnabled && (
        <>
          <Field label={t("输入设备", "Input device")}>
            {devices ? (
              <select
                className="select"
                value={a.micDeviceId ?? ""}
                onChange={(e) => setA({ micDeviceId: e.target.value || null })}
              >
                <option value="">{systemDefault(devices)}</option>
                {devices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            ) : (
              <Spinner />
            )}
          </Field>
          <div className="audio-row">
            <Meter label={t("麦克风", "Mic")} value={levels.mic} error={levels.micError} />
            <Range value={Math.round(a.micVolume * 100)} min={0} max={200} step={5} onChange={(v) => setA({ micVolume: v / 100 })} format={(v) => `${v}%`} />
          </div>
        </>
      )}
      {err && <p className="warn-text">{err}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Seconds(props: { value: number; onChange: (v: number) => void; max: number }) {
  return (
    <span className="secs">
      <button type="button" onClick={() => props.onChange(Math.max(0, props.value - 1))} aria-label={t("减少", "Decrease")}>
        −
      </button>
      <span>{props.value}s</span>
      <button type="button" onClick={() => props.onChange(Math.min(props.max, props.value + 1))} aria-label={t("增加", "Increase")}>
        +
      </button>
    </span>
  );
}

/** Change one game's settings. */
export function setGameSettings(set: SetSettings, game: GameId, patch: Partial<GameSettings>) {
  set((s) => ({ ...s, gameSettings: { ...s.gameSettings, [game]: { ...s.gameSettings[game], ...patch } } }));
}

/** One game: keep the whole match or only the highlights. */
export function CaptureModeField(props: { settings: Settings; set: SetSettings; game: GameId }) {
  const gs = props.settings.gameSettings[props.game];
  // what half an hour of video takes at the chosen bitrate
  const gb = (props.settings.video.bitrateMbps * 1800) / 8 / 1000;
  return (
    <Field label={t("保存方式", "What to keep")}>
      <Segmented
        value={gs.captureMode}
        onChange={(m) => setGameSettings(props.set, props.game, { captureMode: m })}
        options={[
          {
            value: "full",
            label: t("整局录像 + 高光标记", "Full recording + highlight markers"),
            hint: t(`按现在的画质每 30 分钟约 ${gb.toFixed(1)} GB`, `About ${gb.toFixed(1)} GB per 30 min at current quality`),
          },
          {
            value: "highlights",
            label: t("只留高光片段", "Highlights only"),
            hint: t("整局在处理完后删除，省空间", "The full recording is deleted after processing to save space"),
          },
        ]}
      />
    </Field>
  );
}

/** PUBG: reading kill / knock / win prompts off the screen. */
export function ScreenDetectField(props: { settings: Settings; set: SetSettings; detector?: string }) {
  return (
    <Field
      label={t("实时读屏识别", "Live screen reading")}
      hint={
        props.detector === "uncalibrated"
          ? t(
              "还在校准：先正常打一局，每次击倒 / 击杀 / 被淘汰后按一下标记键，用这局的录像做识别样本",
              "Still calibrating: play one match normally and press the mark key after every knock / kill / death; that recording becomes the detection sample",
            )
          : t("当场认出你的击杀、击倒、吃鸡和观战画面并打标记，不需要 PUBG 账号", "Spots your kills, knocks, Chicken Dinners and spectating as they happen and marks them. No PUBG account needed")
      }
    >
      <Toggle
        checked={props.settings.screenDetect}
        onChange={(v) => props.set((s) => ({ ...s, screenDetect: v }))}
        label={props.settings.screenDetect ? t("开启", "On") : t("关闭", "Off")}
      />
    </Field>
  );
}

/** One game's highlight rules: which moments get a clip, and how much before / after. */
export function EventsSection(props: { settings: Settings; set: SetSettings; game: GameId }) {
  const { settings, set, game } = props;
  const rules = settings.gameSettings[game].rules;
  const setRule = (k: EventKind, patch: Partial<EventRule>) =>
    set((s) => {
      const gs = s.gameSettings[game];
      return { ...s, gameSettings: { ...s.gameSettings, [game]: { ...gs, rules: { ...gs.rules, [k]: { ...gs.rules[k], ...patch } } } } };
    });
  return (
    <div className="stack">
      <div className="rules">
        <div className="rules-head">
          <span>{t("事件", "Event")}</span>
          <span>{t("事件前", "Before")}</span>
          <span>{t("事件后", "After")}</span>
        </div>
        {GAMES[game].rules.map(({ kind, label: ruleLabel, note }) => {
          const r = rules[kind];
          return (
            <div className={"rule" + (r.enabled || kind === "manual" ? "" : " is-off")} key={kind}>
              <span className="rule-name">
                {kind === "manual" ? (
                  <span className="always" title={t("按了快捷键就一定保存", "Always saved when you press the hotkey")}>
                    {t("总是", "Always")}
                  </span>
                ) : (
                  <Toggle checked={r.enabled} onChange={(v) => setRule(kind, { enabled: v })} />
                )}
                <KindDot kind={kind} />
                <b>{label(ruleLabel ?? kindLabel(kind, game))}</b>
                <small>{note}</small>
              </span>
              <Seconds value={r.pre} max={60} onChange={(v) => setRule(kind, { pre: v })} />
              <Seconds value={r.post} max={30} onChange={(v) => setRule(kind, { post: v })} />
            </div>
          );
        })}
      </div>
      <p className="muted small">
        {props.game === "lol"
          ? t("相邻的高光会自动合并成一段，比如一波团战里的连续击杀和抢龙会变成一个片段。", "Nearby highlights are merged into one clip, e.g. back-to-back kills and a dragon steal in one teamfight.")
          : t("相邻的高光会自动合并成一段，比如 10 秒内连续击倒和击杀会变成一个片段。", "Nearby highlights are merged into one clip, e.g. a knock and a kill within 10 seconds.")}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function PubgSection(props: { settings: Settings; set: SetSettings }) {
  const { settings, set } = props;
  const p = settings.pubg;
  const [show, setShow] = useState(false);
  const [state, setState] = useState<{ busy: boolean; ok?: string; err?: string }>({ busy: false });
  const setP = (patch: Partial<Settings["pubg"]>) => set((s) => ({ ...s, pubg: { ...s.pubg, ...patch } }));
  const verify = async () => {
    setState({ busy: true });
    try {
      const r = await api.verifyPubg(p.playerName, p.apiKey, p.shard);
      setP({ accountId: r.accountId });
      setState({
        busy: false,
        ok: t(
          `找到了，最近 ${r.recentMatches} 场对局可读取`,
          `Found. ${r.recentMatches} recent ${plural(r.recentMatches, "match", "matches")} available`,
        ),
      });
    } catch (e) {
      setState({ busy: false, err: errText(e) });
    }
  };
  return (
    <div className="stack">
      <ol className="howto">
        <li>
          {t("打开", "Open")}{" "}
          <button type="button" className="link" onClick={() => api.openUrl("https://developer.pubg.com/")}>
            developer.pubg.com
          </button>
          {t("，用 Steam 或邮箱登录", " and sign in with Steam or email")}
        </li>
        <li>
          {t("点", "Click")} <b>Get Your Own API Key</b>
          {t("，随便建一个 App，复制生成的 Key", ", create any app and copy the key it gives you")}
        </li>
        <li>{t("把 Key 和你的游戏 ID 填在下面", "Enter the key and your in-game name below")}</li>
      </ol>
      <div className="grid-2">
        <Field label={t("游戏 ID", "In-game name")} hint={t("区分大小写", "Case-sensitive")}>
          <input className="input" value={p.playerName} placeholder={t("例如 Jkeroro", "e.g. Jkeroro")} onChange={(e) => setP({ playerName: e.target.value, accountId: null })} />
        </Field>
        <Field label={t("平台", "Platform")}>
          <Segmented
            value={p.shard}
            onChange={(v) => setP({ shard: v })}
            options={[
              { value: "steam", label: "Steam" },
              { value: "kakao", label: "Kakao" },
            ]}
          />
        </Field>
      </div>
      <Field label="API Key">
        <div className="input-row">
          <input
            className="input mono"
            type={show ? "text" : "password"}
            value={p.apiKey}
            placeholder="eyJ0eXAiOi…"
            onChange={(e) => setP({ apiKey: e.target.value.trim() })}
          />
          <Button kind="ghost" small onClick={() => setShow(!show)} title={show ? t("隐藏", "Hide") : t("显示", "Show")}>
            {show ? <EyeOff size={16} /> : <Eye size={16} />}
          </Button>
          <Button kind="primary" small onClick={verify} disabled={state.busy || !p.playerName || !p.apiKey}>
            {state.busy ? <Spinner /> : t("验证", "Verify")}
          </Button>
        </div>
      </Field>
      {state.ok && (
        <p className="ok-text">
          <Check size={14} /> {state.ok}
        </p>
      )}
      {state.err && (
        <p className="warn-text">
          <AlertTriangle size={14} /> {state.err}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

export function HotkeySection(props: { settings: Settings; set: SetSettings }) {
  const { settings, set } = props;
  const setH = (patch: Partial<Settings["hotkeys"]>) => set((s) => ({ ...s, hotkeys: { ...s.hotkeys, ...patch } }));
  return (
    <div className="stack">
      <Field label={t("标记高光", "Mark highlight")} hint={t("游戏里按一下，前后各录一段，按默认 20 秒 + 5 秒", "Press in game to keep the moment: 20 s before + 5 s after by default")}>
        <HotkeyInput value={settings.hotkeys.highlight} onChange={(v) => setH({ highlight: v })} />
      </Field>
      <Field label={t("开始 / 停止录制", "Start / stop recording")} hint={t("不开自动录制时用", "For when auto-record is off")}>
        <HotkeyInput value={settings.hotkeys.toggleRecord} onChange={(v) => setH({ toggleRecord: v })} />
      </Field>
      <p className="muted small">
        {t(
          "点一下按钮再按键盘设置，Backspace 清除。PUBG 里 Alt 是自由视角，尽量别用 Alt 组合。Stream Deck 可以直接绑定这里的按键。",
          "Click a button, then press keys to set it; Backspace clears. Alt is free look in PUBG, so avoid Alt combos. Stream Deck can bind these keys directly.",
        )}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function StorageSection(props: { settings: Settings; set: SetSettings; hardware: HardwareInfo | null }) {
  const { settings, set, hardware } = props;
  const disk = useMemo(() => {
    const dir = settings.libraryDir.toUpperCase();
    return hardware?.disks
      .filter((d) => dir.startsWith(d.mount.toUpperCase()))
      .sort((a, b) => b.mount.length - a.mount.length)[0];
  }, [settings.libraryDir, hardware]);
  const pick = async () => {
    const dir = await openDialog({ directory: true, multiple: false, defaultPath: settings.libraryDir || undefined });
    if (typeof dir === "string") set((s) => ({ ...s, libraryDir: dir }));
  };
  const maxGb = disk ? Math.max(20, Math.floor(disk.total / 1024 ** 3)) : 2000;
  return (
    <div className="stack">
      <Field
        label={t("录像保存位置", "Recording folder")}
        hint={disk ? t(`${disk.mount} 剩余 ${bytes(disk.free)}`, `${bytes(disk.free)} free on ${disk.mount}`) : undefined}
      >
        <div className="input-row">
          <input className="input mono" value={settings.libraryDir} onChange={(e) => set((s) => ({ ...s, libraryDir: e.target.value }))} />
          <Button kind="ghost" small onClick={pick}>
            <FolderOpen size={16} /> {t("选择", "Select")}
          </Button>
        </div>
      </Field>
      {disk?.isSystem && (
        <p className="warn-text">{t("放在系统盘会和系统抢读写，有别的硬盘的话建议换一块。", "On the system drive, recording competes with Windows for disk access. Use another drive if you have one.")}</p>
      )}
      <Field label={t("最多占用", "Max space")} hint={t("超过后自动删除最旧的录像，收藏的不会删", "Past this, the oldest recordings are deleted; favorites are kept")}>
        <Range
          value={settings.storageLimitGb}
          min={20}
          max={Math.min(maxGb, 4000)}
          step={10}
          onChange={(v) => set((s) => ({ ...s, storageLimitGb: v }))}
          format={(v) => `${v} GB`}
        />
      </Field>
      <Field label={t("自动录制", "Auto-record")}>
        <Toggle
          checked={settings.autoRecord}
          onChange={(v) => set((s) => ({ ...s, autoRecord: v }))}
          label={settings.autoRecord ? t("打开游戏时自动开始，关游戏自动结束", "Starts when a game opens, stops when it closes") : t("手动开始录制", "Start recording manually")}
        />
      </Field>
    </div>
  );
}
