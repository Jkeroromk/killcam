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
  type HardwareInfo,
  type Levels,
  type MonitorInfo,
  type Settings,
} from "../lib/api";
import { KIND_LABEL, bytes } from "../lib/format";
import { Button, Field, HotkeyInput, KindDot, Meter, Range, Segmented, Spinner, Toggle } from "./ui";

export type SetSettings = (fn: (s: Settings) => Settings) => void;

const even = (n: number) => n - (n % 2);

export function outputSize(v: Settings["video"], gpuScale = true): { w: number; h: number } | null {
  const { monitorWidth: sw, monitorHeight: sh } = v;
  if (!sw || !sh) return null;
  let cw = sw;
  if (v.aspect === "16:9" && sw * 9 > sh * 16) cw = even(Math.floor((sh * 16) / 9));
  if (!gpuScale) return { w: cw, h: sh };
  const th = v.height === 0 || v.height >= sh ? sh : v.height;
  return { w: even(Math.round((cw * th) / sh)), h: even(th) };
}

export const PRESETS = {
  performance: { height: 720, fps: 60, bitrateMbps: 10, label: "流畅", hint: "720p · 60 帧" },
  balanced: { height: 1080, fps: 60, bitrateMbps: 20, label: "均衡", hint: "1080p · 60 帧" },
  quality: { height: 0, fps: 60, bitrateMbps: 40, label: "画质", hint: "原生分辨率 · 60 帧" },
} as const;

/** When GPU scaling is unavailable everything is recorded at native size; presets only change bitrate. */
export const NATIVE_PRESETS = {
  performance: { height: 0, fps: 60, bitrateMbps: 16, label: "省空间", hint: "原生 · 16 Mbps" },
  balanced: { height: 0, fps: 60, bitrateMbps: 28, label: "均衡", hint: "原生 · 28 Mbps" },
  quality: { height: 0, fps: 60, bitrateMbps: 45, label: "画质", hint: "原生 · 45 Mbps" },
} as const;

export function presetsFor(hw: HardwareInfo | null) {
  return hw && !hw.gpuScaleWorks ? NATIVE_PRESETS : PRESETS;
}

// ---------------------------------------------------------------------------

export function MonitorPicker(props: { settings: Settings; set: SetSettings; monitors: MonitorInfo[] | null; onRefresh?: () => void }) {
  const { settings, set, monitors } = props;
  if (!monitors) {
    return (
      <div className="loading-row">
        <Spinner /> 正在识别显示器…
      </div>
    );
  }
  if (monitors.length === 0) {
    return <p className="warn-text">没有识别到可录制的显示器。确认 FFmpeg 版本支持 ddagrab。</p>;
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
              <b>屏幕 {m.index + 1}</b>
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
          <RefreshCw size={14} /> 重新识别
        </Button>
      )}
    </div>
  );
}

export function VideoSection(props: { settings: Settings; set: SetSettings; hardware: HardwareInfo | null; onRedetect?: () => void }) {
  const { settings, set, hardware } = props;
  const v = settings.video;
  const scale = hardware?.gpuScaleWorks ?? true;
  const P = presetsFor(hardware);
  const out = outputSize(v, scale);
  const ultrawide = v.monitorWidth * 9 > v.monitorHeight * 16 + 10;
  const encoders = hardware?.encoders.filter((e) => e.available) ?? [];
  const setV = (patch: Partial<Settings["video"]>) => set((s) => ({ ...s, video: { ...s.video, ...patch } }));

  return (
    <div className="stack">
      <Field label="画质预设" hint={out ? `输出 ${out.w}×${out.h} · ${v.fps} 帧 · 约 ${v.bitrateMbps} Mbps` : undefined}>
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
            { value: "custom" as const, label: "自定义", hint: "自己调" },
          ]}
        />
      </Field>

      {!scale && (
        <p className="muted small">
          这台电脑的 FFmpeg 显卡缩放用不了，所以按原生分辨率录（同样全程在显卡里，不掉帧），导出时再选 1080p / 720p。预设只改变码率。
        </p>
      )}

      {ultrawide && (
        <Field label="画面比例" hint="裁成 16:9 由显卡完成，不增加负担">
          <Segmented
            value={v.aspect}
            onChange={(a) => setV({ aspect: a })}
            options={[
              { value: "native", label: "保留超宽", hint: "完整画面，适合 B 站 / YouTube" },
              { value: "16:9", label: "裁成 16:9", hint: "取中间，手机和 Discord 不留黑边" },
            ]}
          />
        </Field>
      )}

      {v.preset === "custom" && (
        <div className="grid-2">
          {scale && <Field label="输出高度">
            <Segmented
              value={v.height}
              onChange={(h) => setV({ height: h })}
              options={[
                { value: 720, label: "720p" },
                { value: 1080, label: "1080p" },
                { value: 1440, label: "1440p" },
                { value: 0, label: "原生" },
              ]}
            />
          </Field>}
          <Field label="帧率">
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
          <Field label="码率上限">
            <Range value={v.bitrateMbps} min={6} max={80} step={2} onChange={(b) => setV({ bitrateMbps: b })} format={(b) => `${b} Mbps`} />
          </Field>
        </div>
      )}

      <Field label="编码器" hint="用显卡的硬件编码器，不占 CPU">
        {!hardware ? (
          <p className="muted small">
            <Spinner /> 正在检测显卡编码器…
          </p>
        ) : encoders.length === 0 ? (
          <p className="warn-text">
            没有检测到可用的硬件编码器。
            {props.onRedetect && (
              <button type="button" className="linkbtn" onClick={props.onRedetect}>
                重新检测
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
              hint: e.id.startsWith("h264") ? "兼容性最好" : e.id.startsWith("av1") ? "体积最小，部分播放器不支持" : "体积更小",
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
    (id ? outputs?.find((d) => d.id === id)?.name : outputs?.find((d) => d.isDefault)?.name) ?? "默认输出设备";
  const gameMeterLabel =
    a.gameSource === "process" && !props.gameRunning
      ? "PUBG 没开，先用默认输出设备的声音测试电平"
      : a.gameSource === "system"
        ? outName(a.systemDeviceId)
        : "PUBG";

  return (
    <div className="stack">
      <Field label="游戏声音" hint="单独一条音轨，后期可以分开调">
        <Segmented
          value={a.gameSource}
          onChange={(g) => setA({ gameSource: g })}
          options={[
            { value: "process", label: "只录 PUBG", hint: "不会录进 Discord、音乐" },
            { value: "system", label: "录一个输出设备", hint: "这个设备上播放的所有声音" },
            { value: "off", label: "不录" },
          ]}
        />
      </Field>
      {a.gameSource === "system" && (
        <Field label="输出设备" hint="用 VoiceMeeter 的话，选游戏声音实际进入的那个虚拟输入，比如 VoiceMeeter Input">
          {outputs ? (
            <select className="select" value={a.systemDeviceId ?? ""} onChange={(e) => setA({ systemDeviceId: e.target.value || null })}>
              <option value="">系统默认（{outputs.find((d) => d.isDefault)?.name ?? "无"}）</option>
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

      <Field label="麦克风" hint="另一条音轨">
        <Toggle checked={a.micEnabled} onChange={(v) => setA({ micEnabled: v })} label={a.micEnabled ? "录制麦克风" : "不录麦克风"} />
      </Field>
      {a.micEnabled && (
        <>
          <Field label="输入设备">
            {devices ? (
              <select
                className="select"
                value={a.micDeviceId ?? ""}
                onChange={(e) => setA({ micDeviceId: e.target.value || null })}
              >
                <option value="">系统默认（{devices.find((d) => d.isDefault)?.name ?? "无"}）</option>
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
            <Meter label="麦克风" value={levels.mic} error={levels.micError} />
            <Range value={Math.round(a.micVolume * 100)} min={0} max={200} step={5} onChange={(v) => setA({ micVolume: v / 100 })} format={(v) => `${v}%`} />
          </div>
        </>
      )}
      {err && <p className="warn-text">{err}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------

const RULE_KINDS: { kind: EventKind; note: string }[] = [
  { kind: "kill", note: "你拿到的击杀" },
  { kind: "knock", note: "你打倒的人" },
  { kind: "win", note: "大吉大利，今晚吃鸡" },
  { kind: "death", note: "你被淘汰的那一下" },
  { kind: "knocked", note: "你被打倒" },
  { kind: "manual", note: "按快捷键手动标记" },
];

function Seconds(props: { value: number; onChange: (v: number) => void; max: number }) {
  return (
    <span className="secs">
      <button type="button" onClick={() => props.onChange(Math.max(0, props.value - 1))} aria-label="减少">
        −
      </button>
      <span>{props.value}s</span>
      <button type="button" onClick={() => props.onChange(Math.min(props.max, props.value + 1))} aria-label="增加">
        +
      </button>
    </span>
  );
}

export function EventsSection(props: { settings: Settings; set: SetSettings; detector?: string }) {
  const { settings, set } = props;
  const setRule = (k: EventKind, patch: Partial<Settings["events"][EventKind]>) =>
    set((s) => ({ ...s, events: { ...s.events, [k]: { ...s.events[k], ...patch } } }));
  return (
    <div className="stack">
      <Field label="保存方式">
        <Segmented
          value={settings.captureMode}
          onChange={(m) => set((s) => ({ ...s, captureMode: m }))}
          options={[
            { value: "full", label: "整局录像 + 高光标记", hint: "每局约 3–5 GB，回看最完整" },
            { value: "highlights", label: "只留高光片段", hint: "整局在处理完后删除，省空间" },
          ]}
        />
      </Field>
      <Field
        label="实时读屏识别"
        hint={
          props.detector === "uncalibrated"
            ? "还在校准：先正常打一局，每次击倒 / 击杀 / 被淘汰后按一下标记键，用这局的录像做识别样本"
            : "当场认出你的击杀、击倒和吃鸡提示并打标记，不需要 PUBG 账号。被击倒和被淘汰还在收集样本"
        }
      >
        <Toggle
          checked={settings.screenDetect}
          onChange={(v) => set((s) => ({ ...s, screenDetect: v }))}
          label={settings.screenDetect ? "开启" : "关闭"}
        />
      </Field>
      <div className="rules">
        <div className="rules-head">
          <span>事件</span>
          <span>事件前</span>
          <span>事件后</span>
        </div>
        {RULE_KINDS.map(({ kind, note }) => {
          const r = settings.events[kind];
          return (
            <div className={"rule" + (r.enabled || kind === "manual" ? "" : " is-off")} key={kind}>
              <span className="rule-name">
                {kind === "manual" ? (
                  <span className="always" title="按了快捷键就一定保存">总是</span>
                ) : (
                  <Toggle checked={r.enabled} onChange={(v) => setRule(kind, { enabled: v })} />
                )}
                <KindDot kind={kind} />
                <b>{KIND_LABEL[kind]}</b>
                <small>{note}</small>
              </span>
              <Seconds value={r.pre} max={60} onChange={(v) => setRule(kind, { pre: v })} />
              <Seconds value={r.post} max={30} onChange={(v) => setRule(kind, { post: v })} />
            </div>
          );
        })}
      </div>
      <p className="muted small">相邻的高光会自动合并成一段，比如 10 秒内连续击倒和击杀会变成一个片段。</p>
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
      setState({ busy: false, ok: `找到了，最近 ${r.recentMatches} 场对局可读取` });
    } catch (e) {
      setState({ busy: false, err: errText(e) });
    }
  };
  return (
    <div className="stack">
      <ol className="howto">
        <li>
          打开{" "}
          <button type="button" className="link" onClick={() => api.openUrl("https://developer.pubg.com/")}>
            developer.pubg.com
          </button>
          ，用 Steam 或邮箱登录
        </li>
        <li>
          点 <b>Get Your Own API Key</b>，随便建一个 App，复制生成的 Key
        </li>
        <li>把 Key 和你的游戏 ID 填在下面</li>
      </ol>
      <div className="grid-2">
        <Field label="游戏 ID" hint="区分大小写">
          <input className="input" value={p.playerName} placeholder="例如 Jkeroro" onChange={(e) => setP({ playerName: e.target.value, accountId: null })} />
        </Field>
        <Field label="平台">
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
          <Button kind="ghost" small onClick={() => setShow(!show)} title={show ? "隐藏" : "显示"}>
            {show ? <EyeOff size={16} /> : <Eye size={16} />}
          </Button>
          <Button kind="primary" small onClick={verify} disabled={state.busy || !p.playerName || !p.apiKey}>
            {state.busy ? <Spinner /> : "验证"}
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
      <Field label="标记高光" hint="游戏里按一下，前后各录一段，按默认 20 秒 + 5 秒">
        <HotkeyInput value={settings.hotkeys.highlight} onChange={(v) => setH({ highlight: v })} />
      </Field>
      <Field label="开始 / 停止录制" hint="不开自动录制时用">
        <HotkeyInput value={settings.hotkeys.toggleRecord} onChange={(v) => setH({ toggleRecord: v })} />
      </Field>
      <p className="muted small">
        点一下按钮再按键盘设置，Backspace 清除。PUBG 里 Alt 是自由视角，尽量别用 Alt 组合。Stream Deck 可以直接绑定这里的按键。
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
      <Field label="录像保存位置" hint={disk ? `${disk.mount} 剩余 ${bytes(disk.free)}` : undefined}>
        <div className="input-row">
          <input className="input mono" value={settings.libraryDir} onChange={(e) => set((s) => ({ ...s, libraryDir: e.target.value }))} />
          <Button kind="ghost" small onClick={pick}>
            <FolderOpen size={16} /> 选择
          </Button>
        </div>
      </Field>
      {disk?.isSystem && <p className="warn-text">放在系统盘会和系统抢读写，有别的硬盘的话建议换一块。</p>}
      <Field label="最多占用" hint="超过后自动删除最旧的录像，收藏的不会删">
        <Range
          value={settings.storageLimitGb}
          min={20}
          max={Math.min(maxGb, 4000)}
          step={10}
          onChange={(v) => set((s) => ({ ...s, storageLimitGb: v }))}
          format={(v) => `${v} GB`}
        />
      </Field>
      <Field label="自动录制">
        <Toggle
          checked={settings.autoRecord}
          onChange={(v) => set((s) => ({ ...s, autoRecord: v }))}
          label={settings.autoRecord ? "打开 PUBG 时自动开始，关游戏自动结束" : "手动开始录制"}
        />
      </Field>
    </div>
  );
}
