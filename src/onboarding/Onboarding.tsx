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
  CaptureModeField,
  EventsSection,
  ScreenDetectField,
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
import { lang, t, type LangSetting } from "../lib/i18n";

// titles are functions: the language can change while onboarding is open
const STEPS = [
  { key: "welcome", title: () => t("欢迎", "Welcome") },
  { key: "hardware", title: () => t("硬件与存储", "Hardware & storage") },
  { key: "screen", title: () => t("屏幕和游戏", "Screen & game") },
  { key: "video", title: () => t("画质", "Quality") },
  { key: "perf", title: () => t("性能测试", "Performance test") },
  { key: "audio", title: () => t("声音", "Audio") },
  { key: "events", title: () => t("高光规则", "Highlight rules") },
  { key: "pubg", title: () => t("PUBG 账号", "PUBG account") },
  { key: "hotkeys", title: () => t("快捷键", "Hotkeys") },
  { key: "done", title: () => t("完成", "Done") },
] as const;

type StepKey = (typeof STEPS)[number]["key"];

export default function Onboarding(props: {
  initial: Settings;
  onDone: (s: Settings) => void;
  /** the user picked a language: App switches the UI now (and re-mounts this with the new settings) */
  onLanguage: (l: LangSetting) => void;
}) {
  // the draft starts from what App passes in; after a language switch that already carries the new language
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

  // saved in the draft (written with the rest when onboarding finishes) and applied right away
  const pickLanguage = (l: "zh" | "en") => {
    set((s) => ({ ...s, language: l }));
    props.onLanguage(l);
  };

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
                {s.title()}
              </button>
            </li>
          ))}
        </ol>
      </aside>

      <main className="ob-main">
        <div className="ob-body" key={key}>
          {key === "welcome" && <Welcome onLanguage={pickLanguage} />}
          {key === "hardware" && <HardwareStep hw={hardware} err={hwError} settings={settings} set={set} />}
          {key === "screen" && (
            <Step
              title={t("录哪块屏幕", "Which screen to record")}
              lead={t("点一下 PUBG 所在的那块屏幕。缩略图是刚刚实时抓的画面。", "Click the screen PUBG runs on. The thumbnails were just captured live.")}
            >
              <MonitorPicker settings={settings} set={set} monitors={monitors} onRefresh={loadMonitors} />
              <GameCard game={game} settings={settings} />
            </Step>
          )}
          {key === "video" && (
            <Step
              title={t("画质", "Quality")}
              lead={t(
                "分辨率高低不影响游戏帧数——缩放和编码都在显卡里完成。主要影响的是文件大小。",
                "Resolution doesn't affect your game FPS: scaling and encoding both run on the GPU. It mostly affects file size.",
              )}
            >
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
            <Step
              title={t("声音", "Audio")}
              lead={t(
                "游戏和麦克风分成两条音轨录，后期可以单独调音量。对着麦克风说句话，看看电平条有没有动。",
                "Game audio and mic go on separate tracks, so you can set their volume later. Say something into the mic and check that the level bar moves.",
              )}
            >
              <AudioSection settings={settings} set={set} gameRunning={!!game?.running} />
            </Step>
          )}
          {key === "events" && (
            <Step
              title={t("高光规则", "Highlight rules")}
              lead={t(
                "每种事件要不要剪、往前留几秒、往后留几秒。之后在设置里随时能改。",
                "For each event: whether to clip it, and how many seconds to keep before and after. You can change this in Settings anytime.",
              )}
            >
              <div className="stack">
                <CaptureModeField settings={settings} set={set} game="pubg" />
                <ScreenDetectField settings={settings} set={set} />
                <EventsSection settings={settings} set={set} game="pubg" />
                <p className="muted small">
                  {t(
                    "上面是 PUBG 的规则；英雄联盟的在「设置 → 英雄联盟」里单独调。",
                    "These are the PUBG rules. League of Legends has its own under Settings → League of Legends.",
                  )}
                </p>
              </div>
            </Step>
          )}
          {key === "pubg" && (
            <Step
              title={t("连接 PUBG 账号", "Connect your PUBG account")}
              lead={t(
                "每局结束几分钟后，KillCam 会从 PUBG 官方数据里读出你的每一次击倒、击杀和淘汰，精确到毫秒，还带武器和距离。不填也能用，只是只有手动标记。",
                "A few minutes after each match, KillCam reads every knock, kill and elimination from PUBG's official data, to the millisecond, with weapon and distance. You can skip this, but then you only get markers.",
              )}
            >
              <PubgSection settings={settings} set={set} />
            </Step>
          )}
          {key === "hotkeys" && (
            <Step title={t("快捷键", "Hotkeys")} lead={t("游戏里遇到想留下的瞬间，按一下就行。", "When something worth keeping happens in-game, just press a key.")}>
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
              {t("上一步", "Back")}
            </Button>
          )}
          {key === "pubg" && !(settings.pubg.playerName && settings.pubg.apiKey) ? (
            <Button kind="ghost" onClick={next}>
              {t("跳过", "Skip")}
            </Button>
          ) : null}
          <Button kind="primary" onClick={next} disabled={!canNext || saving}>
            {key === "welcome" ? t("开始设置", "Start setup") : key === "done" ? t("开始使用", "Start using KillCam") : t("下一步", "Next")}
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

function Welcome(props: { onLanguage: (l: "zh" | "en") => void }) {
  const cur = lang();
  return (
    <section className="ob-step ob-welcome">
      {/* each name in its own language, so it can be found whatever the UI shows */}
      <div className="ob-lang" role="group" aria-label={t("语言", "Language")}>
        {(
          [
            ["zh", "中文"],
            ["en", "English"],
          ] as const
        ).map(([l, name]) => (
          <button
            key={l}
            type="button"
            lang={l === "zh" ? "zh-CN" : "en"}
            aria-pressed={cur === l}
            className={"btn btn-ghost btn-sm" + (cur === l ? " is-on" : "")}
            onClick={() => cur !== l && props.onLanguage(l)}
          >
            {name}
          </button>
        ))}
      </div>
      <div className="welcome-tape" aria-hidden>
        {[8, 14, 15, 31, 33, 34, 52, 71, 73, 90].map((p, i) => (
          <span key={i} className={i === 9 ? "k-win" : i % 3 === 1 ? "k-knock" : "k-kill"} style={{ left: `${p}%` }} />
        ))}
      </div>
      <h1 className="display">{t("每一枪都留下来", "Keep every shot")}</h1>
      <p className="lead">
        {t(
          "KillCam 在你玩 PUBG 时用显卡在后台录制，结束后自动把击倒、击杀和吃鸡找出来，排在整局时间轴上。",
          "KillCam records in the background on your GPU while you play PUBG. Afterwards it finds your knocks, kills and Chicken Dinners and lays them out on the match timeline.",
        )}
      </p>
      <ul className="welcome-points">
        <li>{t("画面全程不离开显卡，录制不吃游戏帧数", "Video never leaves the GPU, so recording doesn't cost you FPS")}</li>
        <li>{t("用 PUBG 官方数据定位高光，不会漏队友补枪、不会重复", "Highlights come from PUBG's official data: none missed when a teammate finishes, no duplicates")}</li>
        <li>{t("没有广告，没有账号，录像只存在你自己的硬盘上", "No ads, no account. Recordings stay on your own drive")}</li>
      </ul>
      <p className="muted">{t("接下来几步大约三分钟，中间会做一次 12 秒的录制测试。", "Setup takes about three minutes, including a 12-second test recording.")}</p>
    </section>
  );
}

function HardwareStep(props: { hw: HardwareInfo | null; err: string | null; settings: Settings; set: SetSettings }) {
  const { hw } = props;
  return (
    <Step
      title={t("硬件与存储", "Hardware & storage")}
      lead={t("先确认显卡能做硬件编码，再选一块空间大的硬盘放录像。", "First check that your GPU can do hardware encoding, then pick a drive with plenty of space for recordings.")}
    >
      {!hw && !props.err && (
        <div className="loading-row">
          <Spinner /> {t("正在检测显卡和编码器…", "Detecting GPU and encoders…")}
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
                {hw.encoders.filter((e) => e.available).map((e) => e.label).join(t("、", ", ")) || t("没有可用的编码器", "No encoder available")}
              </span>
            </div>
            {hw.encoders.some((e) => e.available) ? <Check className="ok" size={18} /> : <AlertTriangle className="bad" size={18} />}
          </div>
          <div className="check">
            <MonitorPlay size={18} />
            <div>
              <b>FFmpeg {hw.ffmpeg ? hw.ffmpeg.version.replace(/^ffmpeg version /, "").split(" ")[0] : t("未找到", "not found")}</b>
              <span>
                {hw.ffmpeg
                  ? t(
                      `显卡抓屏 ${hw.ffmpeg.hasDdagrab ? "支持" : "不支持"} · 显卡缩放 ${hw.ffmpeg.hasScaleD3d11 ? "支持" : "不支持（会按原生分辨率录）"}`,
                      `GPU capture: ${hw.ffmpeg.hasDdagrab ? "yes" : "no"} · GPU scaling: ${hw.ffmpeg.hasScaleD3d11 ? "yes" : "no (records at native resolution)"}`,
                    )
                  : hw.ffmpegError}
              </span>
            </div>
            {hw.ffmpeg?.hasDdagrab ? <Check className="ok" size={18} /> : <AlertTriangle className="bad" size={18} />}
          </div>
          {!hw.ffmpeg && (
            <p className="warn-text">
              {t(
                "从 gyan.dev 下载 ffmpeg-git-full，把 ffmpeg.exe 放进 PATH 或 KillCam 同目录，然后重新打开 KillCam。",
                "Download ffmpeg-git-full from gyan.dev, put ffmpeg.exe on your PATH or next to KillCam, then reopen KillCam.",
              )}
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
              <HardDrive size={14} /> {d.mount} {t(`${bytes(d.free)} 可用`, `${bytes(d.free)} free`)}
            </span>
          ))}
        </div>
      )}
    </Step>
  );
}

function GameCard(props: { game: GameInfo | null; settings: Settings }) {
  const g = props.game;
  const modeName = (m: number | null) =>
    m === 0 ? t("全屏", "Fullscreen") : m === 1 ? t("无边框窗口", "Borderless") : m === 2 ? t("窗口", "Windowed") : t("未知", "Unknown");
  return (
    <div className="gamecard">
      <Gamepad2 size={20} />
      <div>
        <b>{g?.running ? t("PUBG 正在运行", "PUBG is running") : t("PUBG 没有运行", "PUBG isn't running")}</b>
        {g?.configFound ? (
          <span>
            {t("显示模式", "Display mode:")} {modeName(g.fullscreenMode)}
            {g.resolution ? ` · ${g.resolution}` : ""}
            {g.frameLimit ? ` · ${t("帧率上限", "FPS cap")} ${g.frameLimit}` : ""}
          </span>
        ) : (
          <span>{t("没找到 PUBG 的设置文件，不影响录制", "PUBG's settings file wasn't found. Recording still works")}</span>
        )}
        <span className="muted">
          {t(
            "全屏和无边框都能录。如果测试录出来是黑屏，把 PUBG 改成无边框窗口再试。",
            "Fullscreen and borderless both work. If the test recording comes out black, switch PUBG to borderless and try again.",
          )}
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
    return { patch: { preset: "balanced", height: 1080, fps: v.fps, bitrateMbps: 20 }, text: t("降到 1080p（帧率不变）", "drop to 1080p (same frame rate)") };
  }
  if (canScale && h > 720) {
    return { patch: { preset: "performance", height: 720, fps: v.fps, bitrateMbps: 10 }, text: t("降到 720p（帧率不变）", "drop to 720p (same frame rate)") };
  }
  if (v.fps > 30) {
    return { patch: { preset: "custom", fps: 30, bitrateMbps: Math.max(6, Math.round(v.bitrateMbps * 0.6)) }, text: t("降到 30 帧", "drop to 30 fps") };
  }
  return null;
}

/** "drop to 720p" -> "Drop to 720p" (English advice starts a button label) */
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

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
    <Step
      title={t("性能测试", "Performance test")}
      lead={t(
        "用刚才的设置真实录 12 秒，看录制能不能稳住帧率。最好先把 PUBG 开着（训练场就行），测试开始后切回游戏动一动。",
        "Records 12 seconds with these settings to see if recording holds its frame rate. Best with PUBG open (Training Ground is fine): once the test starts, switch to the game and move around.",
      )}
    >
      <div className={"perf-game" + (gameRunning ? " is-on" : "")}>
        <Gamepad2 size={16} />{" "}
        {gameRunning
          ? t("检测到 PUBG，测试会同时录游戏声音", "PUBG detected. The test also records game audio")
          : t("PUBG 没开：也能测，但测不出游戏满载时的情况", "PUBG isn't open: you can still test, but not under full game load")}
      </div>

      {!running && !r && (
        <div className="perf-start">
          <Button kind="primary" onClick={() => run()}>
            <Play size={16} /> {t("开始 12 秒测试", "Start 12-second test")}
          </Button>
          <span className="muted">
            {out ? `${out.w}×${out.h}` : t("原生分辨率", "Native resolution")} · {props.settings.video.fps} {t("帧", "fps")} ·{" "}
            {props.settings.video.encoder}
          </span>
        </div>
      )}

      {running && (
        <div className="perf-live">
          <div className="perf-bar">
            <div style={{ width: `${Math.min(100, ((prog?.elapsed ?? 0) / 12) * 100)}%` }} />
          </div>
          <div className="perf-nums">
            <Num label={t("录制帧率", "Recording FPS")} value={prog ? prog.fps.toFixed(0) : "–"} />

            <Num label={t("录制进程 CPU", "Recorder CPU")} value={prog ? `${prog.cpu.toFixed(1)}%` : "–"} />
          </div>
          <p className="muted">{t("正在录制… 现在切回游戏动一动。", "Recording… switch to the game and move around now.")}</p>
        </div>
      )}

      {err && <p className="warn-text">{err}</p>}

      {r && (
        <div className={"perf-result" + (r.ok ? " is-ok" : " is-bad")}>
          <h2>{r.ok ? t("稳住了，可以放心录", "Steady. You're good to record") : t("录制跟不上", "Recording can't keep up")}</h2>
          <div className="perf-nums">
            <Num label={t("平均帧率", "Average FPS")} value={`${r.avgFps.toFixed(1)}`} sub={t(`目标 ${r.targetFps}`, `Target ${r.targetFps}`)} />
            <Num label={t("丢帧", "Dropped frames")} value={`${r.dropFrames}`} sub={t(`共 ${r.frames} 帧`, `of ${r.frames}`)} />
            <Num label={t("录制进程 CPU", "Recorder CPU")} value={`${r.cpuPercent.toFixed(1)}%`} sub={t("整台电脑的占比", "Share of the whole PC")} />
            <Num label={t("每分钟", "Per minute")} value={`${r.mbPerMinute.toFixed(0)} MB`} sub={`${r.bitrateMbps.toFixed(1)} Mbps`} />
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
                      ? t(`这台电脑现在的设置跟不上，建议${a.text}再测一次。`, `These settings are too much for this PC. Suggestion: ${a.text}, then test again.`)
                      : t(
                          "已经是最低一档了还跟不上：关掉其他占资源的程序，或更新显卡驱动后再试。",
                          "Already at the lowest setting and still can't keep up. Close other heavy programs or update your GPU driver, then try again.",
                        )
                    : t(
                        `录制占了整台电脑 ${r.cpuPercent.toFixed(0)}% 的 CPU，打游戏时可能会卡，建议${a!.text}。`,
                        `Recording used ${r.cpuPercent.toFixed(0)}% of this PC's CPU, which may cause stutter in-game. Suggestion: ${a!.text}.`,
                      )}
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
                    {t(`${a.text}并重测`, `${cap(a.text)} and retest`)}
                  </Button>
                )}
                <Button kind="ghost" small onClick={props.goBack}>
                  {t("自己调画质", "Adjust quality myself")}
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
            {t("再测一次", "Test again")}
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
  const unset = t("未设置", "Not set");
  const rows: [string, string][] = [
    [t("录制", "Recording"), `${out ? `${out.w}×${out.h}` : t("原生", "Native")} · ${s.video.fps} ${t("帧", "fps")} · ${s.video.encoder}`],
    [
      t("声音", "Audio"),
      `${
        s.audio.gameSource === "process"
          ? t("只录 PUBG", "PUBG only")
          : s.audio.gameSource === "system"
            ? t("录一个输出设备", "One output device")
            : t("不录游戏声", "No game audio")
      }${s.audio.micEnabled ? t(" + 麦克风", " + mic") : ""}`,
    ],
    [
      t("保存", "Saving"),
      `${s.gameSettings.pubg.captureMode === "full" ? t("整局录像 + 高光标记", "Full recording + highlight markers") : t("只留高光片段", "Highlights only")} · ${s.libraryDir} · ${t(`最多 ${s.storageLimitGb} GB`, `up to ${s.storageLimitGb} GB`)}`,
    ],
    [
      t("高光来源", "Highlights from"),
      s.pubg.playerName && s.pubg.apiKey
        ? t(`PUBG 官方数据（${s.pubg.playerName}）+ 快捷键`, `Official data (${s.pubg.playerName}) + hotkey`)
        : t("只有快捷键标记", "Hotkey markers only"),
    ],
    [t("快捷键", "Hotkeys"), t(`标记 ${s.hotkeys.highlight || unset} · 开始/停止 ${s.hotkeys.toggleRecord || unset}`, `Mark ${s.hotkeys.highlight || unset} · Start/stop ${s.hotkeys.toggleRecord || unset}`)],
    [t("自动录制", "Auto-record"), s.autoRecord ? t("打开 PUBG 自动开始", "Starts when PUBG opens") : t("手动", "Manual")],
  ];
  return (
    <Step
      title={t("都设好了", "All set")}
      lead={t(
        "KillCam 会待在系统托盘里。打开 PUBG 它就开始录，每局结束几分钟后高光会出现在录像库。",
        "KillCam stays in the system tray. Open PUBG and it starts recording; highlights show up in the Library a few minutes after each match.",
      )}
    >
      <dl className="summary">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {props.perf && !props.perf.ok && (
        <p className="warn-text">
          {t("性能测试没有通过，录制可能会掉帧。可以之后在设置里降低画质。", "The performance test didn't pass, so recording may drop frames. You can lower the quality in Settings later.")}
        </p>
      )}
    </Step>
  );
}
