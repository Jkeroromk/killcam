import { useEffect, useState, type ReactNode } from "react";
import { api, errText, type GameId, type HardwareInfo, type MonitorInfo, type PerfResult, type Settings, type Status } from "../lib/api";
import { Settings2 } from "lucide-react";
import { GameSwitch } from "../components/GameSwitch";
import { Button, Field, Range, Segmented, Spinner, Toggle } from "../components/ui";
import {
  AudioSection,
  CaptureModeField,
  EventsSection,
  PubgSection,
  ScreenDetectField,
  setGameSettings,
  HotkeySection,
  MonitorPicker,
  scaleWorks,
  StorageSection,
  VideoSection,
  type SetSettings,
} from "../components/sections";
import { PerfStep } from "../onboarding/Onboarding";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { t, type LangSetting } from "../lib/i18n";

/** One text file with versions, hardware, encoder test and recent logs, for bug reports. */
function DiagnosticsField() {
  const [state, setState] = useState<{ busy: boolean; ok?: string; err?: string }>({ busy: false });
  const run = async () => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const name = `KillCam-${t("诊断", "diagnostics")}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.txt`;
    const path = await saveDialog({ defaultPath: name, filters: [{ name: t("文本", "Text"), extensions: ["txt"] }] });
    if (!path) return;
    setState({ busy: true });
    try {
      await api.exportDiagnostics(path);
      setState({ busy: false, ok: t("已导出", "Exported") });
      api.reveal(path).catch(() => {});
    } catch (e) {
      setState({ busy: false, err: errText(e) });
    }
  };
  return (
    <Field
      label={t("诊断信息", "Diagnostics")}
      hint={t(
        "遇到问题时导出，发到 GitHub Issues 或发给作者。里面有显卡、编码器检测和最近的录制日志，不含 API Key",
        "Export it when something goes wrong and send it to GitHub Issues or the author. It has your GPU, encoder test and recent recording logs, but not your API key",
      )}
    >
      <div className="row">
        <Button kind="ghost" small onClick={run} disabled={state.busy}>
          {state.busy ? <Spinner /> : t("导出诊断信息", "Export diagnostics")}
        </Button>
        {state.ok && <span className="ok-text small">{state.ok}</span>}
        {state.err && <span className="warn-text small">{state.err}</span>}
      </div>
    </Field>
  );
}

function Card(props: { id: string; title: string; children: ReactNode; note?: string }) {
  return (
    <section className="card" id={props.id}>
      <header>
        <h2>{props.title}</h2>
        {props.note && <span className="muted small">{props.note}</span>}
      </header>
      {props.children}
    </section>
  );
}

// a function, not a constant: the labels follow the current language
const sections = () =>
  [
    ["language", t("语言", "Language")],
    ["ingame", t("启动", "Startup")],
    ["video", t("画质", "Quality")],
    ["screen", t("屏幕", "Screen")],
    ["audio", t("声音", "Audio")],
    ["hotkeys", t("快捷键", "Hotkeys")],
    ["storage", t("存储", "Storage")],
    ["perf", t("性能测试", "Performance test")],
    ["advanced", t("高级", "Advanced")],
  ] as const;

type Tab = "general" | GameId;

// Changing the language re-mounts the whole UI (App keys the shell by
// language), which would reset the tab; this brings the user back to "general".
let reopenGeneral = false;

export default function SettingsPage(props: { game: GameId; settings: Settings; onSaved: (s: Settings) => void; status: Status | null }) {
  // opens on the game being played / looked at, like the library and stats
  const [tab, setTab] = useState<Tab>(reopenGeneral ? "general" : props.game);
  useEffect(() => {
    if (reopenGeneral) {
      reopenGeneral = false;
      return;
    }
    setTab(props.game);
  }, [props.game]);
  const [draft, setDraft] = useState<Settings>(props.settings);
  const [hw, setHw] = useState<HardwareInfo | null>(null);
  const [monitors, setMonitors] = useState<MonitorInfo[] | null | undefined>(undefined);
  const [perf, setPerf] = useState<PerfResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const set: SetSettings = (fn) => setDraft((s) => fn(s));
  const dirty = JSON.stringify(draft) !== JSON.stringify(props.settings);
  const recording = !!props.status?.recording;

  useEffect(() => {
    api.detectHardware().then(setHw).catch(() => {});
  }, []);

  // the account is edited from the side rail; keep this page's draft in step
  useEffect(() => {
    setDraft((d) => ({ ...d, pubg: props.settings.pubg }));
  }, [props.settings.pubg]);

  // KillCam switches the encoder by itself when the chosen one can't record this screen
  useEffect(() => {
    setDraft((d) => ({ ...d, video: { ...d.video, encoder: props.settings.video.encoder } }));
  }, [props.settings.video.encoder]);

  // ...and follows the screen when its resolution changes
  useEffect(() => {
    const { monitorWidth, monitorHeight } = props.settings.video;
    setDraft((d) => ({ ...d, video: { ...d.video, monitorWidth, monitorHeight } }));
  }, [props.settings.video.monitorWidth, props.settings.video.monitorHeight]);

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const errs = await api.saveSettings(draft);
      props.onSaved(draft);
      setMsg(
        errs.length
          ? { ok: false, text: t(`已保存，但有问题：${errs.join("；")}`, `Saved, with problems: ${errs.join("; ")}`) }
          : { ok: true, text: recording ? t("已保存，下次开始录制时生效", "Saved. Applies from the next recording") : t("已保存", "Saved") },
      );
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    } finally {
      setSaving(false);
    }
  };

  // applies right away, without the save button
  const setLanguage = async (language: LangSetting) => {
    setMsg(null);
    const next = { ...props.settings, language };
    reopenGeneral = true;
    try {
      await api.saveSettings(next);
      props.onSaved(next);
    } catch (e) {
      reopenGeneral = false;
      setMsg({ ok: false, text: errText(e) });
    }
  };

  const loadMonitors = () => {
    setMonitors(null);
    api.listMonitors().then(setMonitors).catch(() => setMonitors([]));
  };

  return (
    <div className="page settings">
      <header className="page-head">
        <h1>{t("设置", "Settings")}</h1>
        <GameSwitch<"general"> value={tab} onChange={setTab} extra={[{ value: "general", label: t("通用", "General"), icon: <Settings2 size={14} /> }]} />
        {tab === "general" && (
          <nav className="toc">
            {sections().map(([id, label]) => (
              <a key={id} href={`#${id}`}>
                {label}
              </a>
            ))}
          </nav>
        )}
      </header>

      {tab === "pubg" && (
        <>
          <Card id="pubg" title="PUBG">
            <Field
              label={t("自动录制", "Auto-record")}
              hint={t(
                "打开 PUBG 时自动开始，关掉游戏结束。一次录制里打的每一局会分开成单独的对局",
                "Starts when PUBG opens, stops when it closes. Each match in one recording is saved as its own match",
              )}
            >
              <Toggle
                checked={draft.gameSettings.pubg.enabled}
                onChange={(v) => setGameSettings(set, "pubg", { enabled: v })}
                label={draft.gameSettings.pubg.enabled ? t("开启", "On") : t("关闭", "Off")}
              />
            </Field>
            <CaptureModeField settings={draft} set={set} game="pubg" />
            <ScreenDetectField settings={draft} set={set} detector={props.status?.detector} />
          </Card>
          <Card id="pubg-account" title={t("PUBG 账号", "PUBG account")} note={t("也可以从左下角的账号按钮修改", "Also editable from the account button at the bottom left")}>
            <PubgSection settings={draft} set={set} />
          </Card>
          <Card id="pubg-events" title={t("高光规则", "Highlight rules")} note={t("只影响之后处理的对局", "Only affects matches processed from now on")}>
            <EventsSection settings={draft} set={set} game="pubg" />
          </Card>
        </>
      )}

      {tab === "lol" && (
        <>
          <Card id="lol" title={t("英雄联盟", "League of Legends")}>
            <Field
              label={t("自动录制", "Auto-record")}
              hint={t("进入对局（读条界面）时自动开始，回到客户端结束，一局一个录像", "Starts on the loading screen, stops back in the client. One recording per game")}
            >
              <Toggle
                checked={draft.gameSettings.lol.enabled}
                onChange={(v) => setGameSettings(set, "lol", { enabled: v })}
                label={draft.gameSettings.lol.enabled ? t("开启", "On") : t("关闭", "Off")}
              />
            </Field>
            <CaptureModeField settings={draft} set={set} game="lol" />
            <Field label={t("支持的客户端", "Supported clients")}>
              <ul className="support-list">
                <li>
                  <b>{t("支持", "Supported")}</b>
                  {t("：Riot 客户端的服务器，比如北美、欧洲、韩国、日本、东南亚、大洋洲、拉美", ": servers on the Riot client, such as NA, EU, KR, JP, SEA, OCE and LATAM")}
                </li>
                <li>
                  <b>{t("暂不支持", "Not supported yet")}</b>
                  {t("：国服（WeGame / 腾讯客户端）", ": China servers (WeGame / Tencent client)")}
                </li>
                <li>{t("回放和观战别人的对局不会录", "Replays and spectated games aren't recorded")}</li>
              </ul>
            </Field>
            <p className="muted small">
              {t(
                "击杀、多杀、大小龙、胜负都来自英雄联盟游戏本身提供的实时数据，不用读屏，也不用 API Key；伤害、金币等结算数据在打完后从客户端读取。",
                "Kills, multikills, dragons, Baron and the result come from League's own live game data, with no screen reading or API key. Damage, gold and other end-of-game stats are read from the client after the game.",
              )}
            </p>
          </Card>
          <Card id="lol-events" title={t("高光规则", "Highlight rules")} note={t("只影响之后处理的对局", "Only affects matches processed from now on")}>
            <EventsSection settings={draft} set={set} game="lol" />
          </Card>
        </>
      )}

      {tab === "general" && (
      <>
      <Card id="language" title={t("语言", "Language")}>
        <Field label={t("界面语言", "Language")} hint={t("跟随系统时，中文 Windows 显示中文，其他显示英文", "\"System\" shows Chinese on Chinese Windows and English otherwise")}>
          <Segmented<LangSetting>
            value={props.settings.language ?? "auto"}
            onChange={setLanguage}
            options={[
              { value: "auto", label: t("跟随系统", "System") },
              { value: "zh", label: "中文" },
              { value: "en", label: "English" },
            ]}
          />
        </Field>
      </Card>

      <Card id="ingame" title={t("启动和游戏时", "Startup and in game")}>
        <Field label={t("开机自动启动", "Launch at startup")} hint={t("开机后安静地待在右下角托盘里，打开游戏就自动开始录", "Waits quietly in the system tray after boot and starts recording when a game opens")}>
          <Toggle checked={draft.launchAtLogin} onChange={(v) => set((s) => ({ ...s, launchAtLogin: v }))} label={draft.launchAtLogin ? t("开启", "On") : t("关闭", "Off")} />
        </Field>
        <Field
          label={t("迷你录制窗口", "Mini recording window")}
          hint={t(
            "打开游戏时自动最小化 KillCam，换成一个小窗口显示录制状态；关掉游戏后小窗口消失，KillCam 回来",
            "Minimizes KillCam when a game opens and shows recording status in a small window; when the game closes, the window goes away and KillCam comes back",
          )}
        >
          <Toggle checked={draft.miniWindow} onChange={(v) => set((s) => ({ ...s, miniWindow: v }))} label={draft.miniWindow ? t("开启", "On") : t("关闭", "Off")} />
        </Field>
        <p className="muted small">
          {t(
            "小窗口可以拖到任意位置，会记住。它不会被录进视频里。游戏要用「无边框窗口」模式，小窗口才能盖在游戏上面；用独占全屏的话，可以把它拖到别的显示器上。",
            "Drag the mini window anywhere; it remembers its spot and is never captured in the video. To keep it on top of the game, use borderless windowed mode; with exclusive fullscreen, drag it to another display.",
          )}
        </p>
      </Card>

      <Card id="video" title={t("画质", "Quality")}>
        <VideoSection
          settings={draft}
          set={set}
          hardware={hw}
          onRedetect={() => {
            setHw(null);
            api.detectHardware(true).then(setHw).catch(() => {});
          }}
        />
      </Card>

      <Card
        id="screen"
        title={t("屏幕", "Screen")}
        note={
          draft.video.monitorWidth
            ? t(
                `当前：屏幕 ${draft.video.monitorIndex + 1}（${draft.video.monitorWidth}×${draft.video.monitorHeight}）`,
                `Current: Screen ${draft.video.monitorIndex + 1} (${draft.video.monitorWidth}×${draft.video.monitorHeight})`,
              )
            : undefined
        }
      >
        {monitors === undefined ? (
          <Button kind="ghost" small onClick={loadMonitors}>
            {t("识别显示器", "Detect displays")}
          </Button>
        ) : (
          <MonitorPicker settings={draft} set={set} monitors={monitors} onRefresh={loadMonitors} />
        )}
        <p className="muted small">{t("换了显示器分辨率之后，在这里重新识别一次。", "Detect again here after changing your display resolution.")}</p>
      </Card>

      <Card id="audio" title={t("声音", "Audio")}>
        <AudioSection settings={draft} set={set} gameRunning={!!props.status?.gameRunning} />
      </Card>


      <Card id="hotkeys" title={t("快捷键", "Hotkeys")}>
        <HotkeySection settings={draft} set={set} />
        <Field
          label={t("标记提示音", "Marker sound")}
          hint={t(
            "按标记键时「叮咚」一声确认标上了；没在录制时会响一声低音。游戏声音选「只录 PUBG」时不会被录进视频",
            "A chime confirms each mark; a low tone plays when not recording. Not captured in the video when game audio is set to \"PUBG only\"",
          )}
        >
          <Toggle checked={draft.markerSound} onChange={(v) => set((s) => ({ ...s, markerSound: v }))} label={draft.markerSound ? t("开启", "On") : t("关闭", "Off")} />
        </Field>
      </Card>

      <Card id="storage" title={t("存储", "Storage")}>
        <StorageSection settings={draft} set={set} hardware={hw} />
      </Card>

      <Card id="perf" title={t("性能测试", "Performance test")} note={dirty ? t("用的是下面还没保存的设置", "Uses the unsaved settings below") : undefined}>
        {recording ? <p className="muted">{t("正在录制，停止后才能测试。", "Recording. Stop it to run the test.")}</p> : <PerfStep
            settings={draft}
            gpuScale={scaleWorks(hw, draft.video.encoder)}
            result={perf}
            onResult={setPerf}
            goBack={() => document.getElementById("video")?.scrollIntoView()}
            onApply={(patch) => set((s) => ({ ...s, video: { ...s.video, ...patch } }))}
          />}
      </Card>

      <Card id="advanced" title={t("高级", "Advanced")}>
        <Field label={t("FFmpeg 位置", "FFmpeg location")} hint={t("留空会自动在 PATH 和 KillCam 目录里找", "Leave empty to look in PATH and the KillCam folder")}>
          <input
            className="input mono"
            value={draft.ffmpegPath ?? ""}
            placeholder={t("例如 D:\\tools\\ffmpeg\\bin\\ffmpeg.exe", "e.g. D:\\tools\\ffmpeg\\bin\\ffmpeg.exe")}
            onChange={(e) => set((s) => ({ ...s, ffmpegPath: e.target.value || null }))}
          />
        </Field>
        <Field label={t("高光时间校准", "Highlight timing")} hint={t("如果标记总是比画面早或晚，在这里修正", "If markers are always early or late, correct it here")}>
          <Range
            value={draft.telemetryOffsetMs / 1000}
            min={-5}
            max={5}
            step={0.25}
            onChange={(v) => set((s) => ({ ...s, telemetryOffsetMs: Math.round(v * 1000) }))}
            format={(v) => (v === 0 ? t("不调整", "No offset") : v > 0 ? t(`标记往后 ${v}s`, `Markers ${v}s later`) : t(`标记往前 ${-v}s`, `Markers ${-v}s earlier`))}
          />
        </Field>
        <Field label={t("重新引导", "Setup")}>
          <Button
            kind="ghost"
            small
            onClick={async () => {
              const s = { ...draft, onboarded: false };
              await api.saveSettings(s);
              props.onSaved(s);
            }}
          >
            {t("重新走一遍初次设置", "Run first-time setup again")}
          </Button>
        </Field>
        <DiagnosticsField />
      </Card>
      </>
      )}

      <div className={"savebar" + (dirty || msg ? " is-shown" : "")}>
        {msg && <span className={msg.ok ? "ok-text" : "warn-text"}>{msg.text}</span>}
        <span className="grow" />
        {dirty && (
          <>
            <Button kind="ghost" onClick={() => setDraft(props.settings)}>
              {t("撤销修改", "Discard changes")}
            </Button>
            <Button kind="primary" onClick={save} disabled={saving}>
              {saving ? <Spinner /> : t("保存设置", "Save settings")}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
