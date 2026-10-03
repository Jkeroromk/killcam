import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Cpu, HardDrive, MonitorPlay, Gamepad2, AlertTriangle, Play } from "lucide-react";
import {
  api,
  errText,
  fileUrl,
  on,
  type GameInfo,
  type HardwareInfo,
  type MonitorInfo,
  type PerfProgress,
  type PerfResult,
  type Settings,
} from "../lib/api";
import { bytes } from "../lib/format";
import { Button, Spinner } from "../components/ui";
import {
  AudioSection,
  EventsSection,
  HotkeySection,
  MonitorPicker,
  PubgSection,
  StorageSection,
  VideoSection,
  outputSize,
  presetsFor,
  scaleWorks,
  type SetSettings,
} from "../components/sections";

const STEPS = [
  { key: "welcome", title: "欢迎" },
  { key: "hardware", title: "硬件与存储" },
  { key: "screen", title: "屏幕和游戏" },
  { key: "video", title: "画质" },
  { key: "perf", title: "性能测试" },
  { key: "audio", title: "声音" },
  { key: "events", title: "高光规则" },
  { key: "pubg", title: "PUBG 账号" },
  { key: "hotkeys", title: "快捷键" },
  { key: "done", title: "完成" },
] as const;

type StepKey = (typeof STEPS)[number]["key"];

export default function Onboarding(props: { initial: Settings; onDone: (s: Settings) => void }) {
  const [settings, setSettingsState] = useState<Settings>(props.initial);
  const [step, setStep] = useState(0);
  const [hardware, setHardware] = useState<HardwareInfo | null>(null);
  const [hwError, setHwError] = useState<string | null>(null);
  const [monitors, setMonitors] = useState<MonitorInfo[] | null>(null);
  const [game, setGame] = useState<GameInfo | null>(null);
  const [perf, setPerf] = useState<PerfResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const set: SetSettings = (fn) => setSettingsState((s) => fn(s));
  const key: StepKey = STEPS[step].key;

  // hardware + default folder once
  useEffect(() => {
    api
      .detectHardware(true)
      .then((h) => {
        setHardware(h);
        // NVENC first, then any other hardware encoder; the CPU encoder is listed last
        const enc = h.encoders.find((e) => e.available && e.id === "h264_nvenc") ?? h.encoders.find((e) => e.available);
        set((s) => {
          const encoder = h.encoders.some((e) => e.available && e.id === s.video.encoder) ? s.video.encoder : (enc?.id ?? s.video.encoder);
          let video = { ...s.video, encoder };
          if (!scaleWorks(h, encoder) && video.preset !== "custom") {
            const p = presetsFor(h, encoder)[video.preset];
            video = { ...video, height: p.height, fps: p.fps, bitrateMbps: p.bitrateMbps };
          }
          return { ...s, video };
        });
      })
      .catch((e) => setHwError(errText(e)));
    if (!props.initial.libraryDir) {
      api.defaultLibraryDir().then((d) => set((s) => (s.libraryDir ? s : { ...s, libraryDir: d })));
    }
  }, []);

  const loadMonitors = () => {
    setMonitors(null);
    api
      .listMonitors()
      .then((m) => {
        setMonitors(m);
        if (m.length) {
          set((s) => {
            const cur = m.find((x) => x.index === s.video.monitorIndex) ?? m[0];
            return { ...s, video: { ...s.video, monitorIndex: cur.index, monitorWidth: cur.width, monitorHeight: cur.height } };
          });
        }
      })
      .catch(() => setMonitors([]));
  };

  useEffect(() => {
    if (key === "screen") {
      if (!monitors) loadMonitors();
      const tick = () => api.gameInfo().then(setGame).catch(() => {});
      tick();
      const t = setInterval(tick, 3000);
      return () => clearInterval(t);
    }
  }, [key]);

  const persist = async (s: Settings) => {
    setSaving(true);
    setSaveError(null);
    try {
      await api.saveSettings(s);
    } catch (e) {
      setSaveError(errText(e));
      throw e;
    } finally {
      setSaving(false);
    }
  };

  const next = async () => {
    try {
      await persist(settings);
    } catch {
      return;
    }
    if (step === STEPS.length - 1) {
      const done = { ...settings, onboarded: true };
      try {
        await persist(done);
      } catch {
        return;
      }
      props.onDone(done);
      return;
    }
    setStep(step + 1);
  };

  const canNext = (() => {
    switch (key) {
      case "hardware":
        return !!hardware?.ffmpeg?.hasDdagrab && !!settings.libraryDir && hardware.encoders.some((e) => e.available);
      case "screen":
        return !!monitors && monitors.length > 0 && settings.video.monitorWidth > 0;
      default:
        return true;
    }
  })();

  return (
    <div className="ob">
      <aside className="ob-rail">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          <span className="brand-name">KillCam</span>
        </div>
        <ol className="ob-steps">
          {STEPS.map((s, i) => (
            <li key={s.key} className={i === step ? "is-current" : i < step ? "is-done" : ""}>
              <button type="button" disabled={i > step} onClick={() => setStep(i)}>
                <span className="ob-num">{i < step ? <Check size={12} /> : i + 1}</span>
                {s.title}
              </button>
            </li>
          ))}
        </ol>
      </aside>

      <main className="ob-main">
        <div className="ob-body" key={key}>
          {key === "welcome" && <Welcome />}
          {key === "hardware" && <HardwareStep hw={hardware} err={hwError} settings={settings} set={set} />}
          {key === "screen" && (
            <Step title="录哪块屏幕" lead="点一下 PUBG 所在的那块屏幕。缩略图是刚刚实时抓的画面。">
              <MonitorPicker settings={settings} set={set} monitors={monitors} onRefresh={loadMonitors} />
              <GameCard game={game} settings={settings} />
            </Step>
          )}
          {key === "video" && (
            <Step title="画质" lead="分辨率高低不影响游戏帧数——缩放和编码都在显卡里完成。主要影响的是文件大小。">
              <VideoSection settings={settings} set={set} hardware={hardware} />
            </Step>
          )}
          {key === "perf" && <PerfStep
              settings={settings}
              gpuScale={scaleWorks(hardware, settings.video.encoder)}
              result={perf}
              onResult={setPerf}
              goBack={() => setStep(3)}
              onApply={(patch) => set((s) => ({ ...s, video: { ...s.video, ...patch } }))}
            />}
          {key === "audio" && (
            <Step title="声音" lead="游戏和麦克风分成两条音轨录，后期可以单独调音量。对着麦克风说句话，看看电平条有没有动。">
              <AudioSection settings={settings} set={set} gameRunning={!!game?.running} />
            </Step>
          )}
          {key === "events" && (
            <Step title="高光规则" lead="每种事件要不要剪、往前留几秒、往后留几秒。之后在设置里随时能改。">
              <EventsSection settings={settings} set={set} />
            </Step>
          )}
          {key === "pubg" && (
            <Step
              title="连接 PUBG 账号"
              lead="每局结束几分钟后，KillCam 会从 PUBG 官方数据里读出你的每一次击倒、击杀和淘汰，精确到毫秒，还带武器和距离。不填也能用，只是只有手动标记。"
            >
              <PubgSection settings={settings} set={set} />
            </Step>
          )}
          {key === "hotkeys" && (
            <Step title="快捷键" lead="游戏里遇到想留下的瞬间，按一下就行。">
              <HotkeySection settings={settings} set={set} />
            </Step>
          )}
          {key === "done" && <DoneStep settings={settings} perf={perf} gpuScale={scaleWorks(hardware, settings.video.encoder)} />}
        </div>

        <footer className="ob-foot">
          {saveError && <span className="warn-text">{saveError}</span>}
          <span className="grow" />
          {step > 0 && (
            <Button kind="ghost" onClick={() => setStep(step - 1)}>
              上一步
            </Button>
          )}
          {key === "pubg" && !(settings.pubg.playerName && settings.pubg.apiKey) ? (
            <Button kind="ghost" onClick={next}>
              跳过
            </Button>
          ) : null}
          <Button kind="primary" onClick={next} disabled={!canNext || saving}>
            {key === "welcome" ? "开始设置" : key === "done" ? "开始使用" : "下一步"}
          </Button>
        </footer>
      </main>
    </div>
  );
}

function Step(props: { title: string; lead: string; children: ReactNode }) {
  return (
    <section className="ob-step">
      <h1>{props.title}</h1>
      <p className="lead">{props.lead}</p>
      {props.children}
    </section>
  );
}

function Welcome() {
  return (
    <section className="ob-step ob-welcome">
      <div className="welcome-tape" aria-hidden>
        {[8, 14, 15, 31, 33, 34, 52, 71, 73, 90].map((p, i) => (
          <span key={i} className={i === 9 ? "k-win" : i % 3 === 1 ? "k-knock" : "k-kill"} style={{ left: `${p}%` }} />
        ))}
      </div>
      <h1 className="display">每一枪都留下来</h1>
      <p className="lead">
        KillCam 在你玩 PUBG 时用显卡在后台录制，结束后自动把击倒、击杀和吃鸡找出来，排在整局时间轴上。
      </p>
      <ul className="welcome-points">
        <li>画面全程不离开显卡，录制不吃游戏帧数</li>
        <li>用 PUBG 官方数据定位高光，不会漏队友补枪、不会重复</li>
        <li>没有广告，没有账号，录像只存在你自己的硬盘上</li>
      </ul>
      <p className="muted">接下来几步大约三分钟，中间会做一次 12 秒的录制测试。</p>
    </section>
  );
}

function HardwareStep(props: { hw: HardwareInfo | null; err: string | null; settings: Settings; set: SetSettings }) {
  const { hw } = props;
  return (
    <Step title="硬件与存储" lead="先确认显卡能做硬件编码，再选一块空间大的硬盘放录像。">
      {!hw && !props.err && (
        <div className="loading-row">
          <Spinner /> 正在检测显卡和编码器…
        </div>
      )}
      {props.err && <p className="warn-text">{props.err}</p>}
      {hw && (
        <div className="checks">
          <div className="check">
            <Cpu size={18} />
            <div>
              <b>{hw.gpu}</b>
              <span>
                {hw.encoders.filter((e) => e.available).map((e) => e.label).join("、") || "没有可用的编码器"}
              </span>
            </div>
            {hw.encoders.some((e) => e.available) ? <Check className="ok" size={18} /> : <AlertTriangle className="bad" size={18} />}
          </div>
          <div className="check">
            <MonitorPlay size={18} />
            <div>
              <b>FFmpeg {hw.ffmpeg ? hw.ffmpeg.version.replace(/^ffmpeg version /, "").split(" ")[0] : "未找到"}</b>
              <span>
                {hw.ffmpeg
                  ? `显卡抓屏 ${hw.ffmpeg.hasDdagrab ? "支持" : "不支持"} · 显卡缩放 ${hw.ffmpeg.hasScaleD3d11 ? "支持" : "不支持（会按原生分辨率录）"}`
                  : hw.ffmpegError}
              </span>
            </div>
            {hw.ffmpeg?.hasDdagrab ? <Check className="ok" size={18} /> : <AlertTriangle className="bad" size={18} />}
          </div>
          {!hw.ffmpeg && (
            <p className="warn-text">
              从 gyan.dev 下载 ffmpeg-git-full，把 ffmpeg.exe 放进 PATH 或 KillCam 同目录，然后重新打开 KillCam。
            </p>
          )}
        </div>
      )}
      <div className="spacer" />
      <StorageSection settings={props.settings} set={props.set} hardware={hw} />
      {hw && (
        <div className="disks">
          {hw.disks.map((d) => (
            <span key={d.mount} className="disk">
              <HardDrive size={14} /> {d.mount} {bytes(d.free)} 可用
            </span>
          ))}
        </div>
      )}
    </Step>
  );
}

function GameCard(props: { game: GameInfo | null; settings: Settings }) {
  const g = props.game;
  const modeName = (m: number | null) => (m === 0 ? "全屏" : m === 1 ? "无边框窗口" : m === 2 ? "窗口" : "未知");
  return (
    <div className="gamecard">
      <Gamepad2 size={20} />
      <div>
        <b>{g?.running ? "PUBG 正在运行" : "PUBG 没有运行"}</b>
        {g?.configFound ? (
          <span>
            显示模式 {modeName(g.fullscreenMode)}
            {g.resolution ? ` · ${g.resolution}` : ""}
            {g.frameLimit ? ` · 帧率上限 ${g.frameLimit}` : ""}
          </span>
        ) : (
          <span>没找到 PUBG 的设置文件，不影响录制</span>
        )}
        <span className="muted">
          全屏和无边框都能录。如果测试录出来是黑屏，把 PUBG 改成无边框窗口再试。
        </span>
      </div>
    </div>
  );
}

type VideoPatch = Partial<Settings["video"]>;

/**
 * The next step down when the test couldn't keep up (or used a lot of CPU):
 * lower resolution first (keeps 60 fps for aiming), then 30 fps.
 */
export function perfAdvice(r: PerfResult, v: Settings["video"], canScale: boolean): { patch: VideoPatch; text: string } | null {
  const heavyCpu = r.cpuPercent >= 25;
  if (r.ok && !heavyCpu) return null;
  // what was actually recorded (0 / native in the settings means the screen height)
  const h = r.height || v.height || v.monitorHeight;
  if (canScale && h > 1080) {
    return { patch: { preset: "balanced", height: 1080, fps: v.fps, bitrateMbps: 20 }, text: "降到 1080p（帧率不变）" };
  }
  if (canScale && h > 720) {
    return { patch: { preset: "performance", height: 720, fps: v.fps, bitrateMbps: 10 }, text: "降到 720p（帧率不变）" };
  }
  if (v.fps > 30) {
    return { patch: { preset: "custom", fps: 30, bitrateMbps: Math.max(6, Math.round(v.bitrateMbps * 0.6)) }, text: "降到 30 帧" };
  }
  return null;
}

export function PerfStep(props: {
  settings: Settings;
  gpuScale?: boolean;
  result: PerfResult | null;
  onResult: (r: PerfResult | null) => void;
  goBack: () => void;
  /** apply a suggested lower setting (then the test runs again with it) */
  onApply?: (patch: VideoPatch) => void;
}) {
  const [running, setRunning] = useState(false);
  const [prog, setProg] = useState<PerfProgress | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [gameRunning, setGameRunning] = useState(false);
  const r = props.result;
  const out = outputSize(props.settings.video, props.gpuScale ?? true);
  const unRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const tick = () => api.gameInfo().then((g) => setGameRunning(g.running)).catch(() => {});
    tick();
    const t = setInterval(tick, 3000);
    return () => {
      clearInterval(t);
      unRef.current?.();
    };
  }, []);

  const run = async (patch?: VideoPatch) => {
    setRunning(true);
    setErr(null);
    props.onResult(null);
    setProg(null);
    unRef.current = on<PerfProgress>("perf-progress", setProg);
    try {
      const s = patch ? { ...props.settings, video: { ...props.settings.video, ...patch } } : props.settings;
      const res = await api.runPerfTest(s, 12);
      props.onResult(res);
    } catch (e) {
      setErr(errText(e));
    } finally {
      unRef.current?.();
      unRef.current = null;
      setRunning(false);
    }
  };

  return (
    <Step title="性能测试" lead="用刚才的设置真实录 12 秒，看录制能不能稳住帧率。最好先把 PUBG 开着（训练场就行），测试开始后切回游戏动一动。">
      <div className={"perf-game" + (gameRunning ? " is-on" : "")}>
        <Gamepad2 size={16} /> {gameRunning ? "检测到 PUBG，测试会同时录游戏声音" : "PUBG 没开：也能测，但测不出游戏满载时的情况"}
      </div>

      {!running && !r && (
        <div className="perf-start">
          <Button kind="primary" onClick={() => run()}>
            <Play size={16} /> 开始 12 秒测试
          </Button>
          <span className="muted">
            {out ? `${out.w}×${out.h}` : "原生分辨率"} · {props.settings.video.fps} 帧 · {props.settings.video.encoder}
          </span>
        </div>
      )}

      {running && (
        <div className="perf-live">
          <div className="perf-bar">
            <div style={{ width: `${Math.min(100, ((prog?.elapsed ?? 0) / 12) * 100)}%` }} />
          </div>
          <div className="perf-nums">
            <Num label="录制帧率" value={prog ? prog.fps.toFixed(0) : "–"} />

            <Num label="录制进程 CPU" value={prog ? `${prog.cpu.toFixed(1)}%` : "–"} />
          </div>
          <p className="muted">正在录制… 现在切回游戏动一动。</p>
        </div>
      )}

      {err && <p className="warn-text">{err}</p>}

      {r && (
        <div className={"perf-result" + (r.ok ? " is-ok" : " is-bad")}>
          <h2>{r.ok ? "稳住了，可以放心录" : "录制跟不上"}</h2>
          <div className="perf-nums">
            <Num label="平均帧率" value={`${r.avgFps.toFixed(1)}`} sub={`目标 ${r.targetFps}`} />
            <Num label="丢帧" value={`${r.dropFrames}`} sub={`共 ${r.frames} 帧`} />
            <Num label="录制进程 CPU" value={`${r.cpuPercent.toFixed(1)}%`} sub="整台电脑的占比" />
            <Num label="每分钟" value={`${r.mbPerMinute.toFixed(0)} MB`} sub={`${r.bitrateMbps.toFixed(1)} Mbps`} />
          </div>
          {r.videoPath && <video className="perf-video" src={fileUrl(r.videoPath)} controls />}
          {(() => {
            const a = perfAdvice(r, props.settings.video, props.gpuScale ?? true);
            if (!a && r.ok) return null;
            return (
              <div className="perf-advice">
                <p>
                  {!r.ok
                    ? a
                      ? `这台电脑现在的设置跟不上，建议${a.text}再测一次。`
                      : "已经是最低一档了还跟不上：关掉其他占资源的程序，或更新显卡驱动后再试。"
                    : `录制占了整台电脑 ${r.cpuPercent.toFixed(0)}% 的 CPU，打游戏时可能会卡，建议${a!.text}。`}
                </p>
                {a && props.onApply && (
                  <Button
                    kind={r.ok ? "ghost" : "primary"}
                    small
                    onClick={() => {
                      props.onApply!(a.patch);
                      run(a.patch);
                    }}
                  >
                    {a.text}并重测
                  </Button>
                )}
                <Button kind="ghost" small onClick={props.goBack}>
                  自己调画质
                </Button>
              </div>
            );
          })()}
          {r.warnings.length > 0 && (
            <ul className="warn-list">
              {r.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          {!r.ok && r.log && <pre className="log">{r.log}</pre>}
          <Button kind="ghost" small onClick={() => run()}>
            再测一次
          </Button>
        </div>
      )}
    </Step>
  );
}

function Num(props: { label: string; value: string; sub?: string }) {
  return (
    <div className="num">
      <span className="num-value">{props.value}</span>
      <span className="num-label">{props.label}</span>
      {props.sub && <span className="num-sub">{props.sub}</span>}
    </div>
  );
}

function DoneStep(props: { settings: Settings; perf: PerfResult | null; gpuScale: boolean }) {
  const s = props.settings;
  const out = outputSize(s.video, props.gpuScale);
  const rows: [string, string][] = [
    ["录制", `${out ? `${out.w}×${out.h}` : "原生"} · ${s.video.fps} 帧 · ${s.video.encoder}`],
    ["声音", `${s.audio.gameSource === "process" ? "只录 PUBG" : s.audio.gameSource === "system" ? "录一个输出设备" : "不录游戏声"}${s.audio.micEnabled ? " + 麦克风" : ""}`],
    ["保存", `${s.captureMode === "full" ? "整局录像 + 高光标记" : "只留高光片段"} · ${s.libraryDir} · 最多 ${s.storageLimitGb} GB`],
    ["高光来源", s.pubg.playerName && s.pubg.apiKey ? `PUBG 官方数据（${s.pubg.playerName}）+ 快捷键` : "只有快捷键标记"],
    ["快捷键", `标记 ${s.hotkeys.highlight || "未设置"} · 开始/停止 ${s.hotkeys.toggleRecord || "未设置"}`],
    ["自动录制", s.autoRecord ? "打开 PUBG 自动开始" : "手动"],
  ];
  return (
    <Step title="都设好了" lead="KillCam 会待在系统托盘里。打开 PUBG 它就开始录，每局结束几分钟后高光会出现在录像库。">
      <dl className="summary">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {props.perf && !props.perf.ok && <p className="warn-text">性能测试没有通过，录制可能会掉帧。可以之后在设置里降低画质。</p>}
    </Step>
  );
}
