import { useEffect, useState, type ReactNode } from "react";
import { api, errText, type GameId, type HardwareInfo, type MonitorInfo, type PerfResult, type Settings, type Status } from "../lib/api";
import { Settings2 } from "lucide-react";
import { GameSwitch } from "../components/GameSwitch";
import { Button, Field, Range, Spinner, Toggle } from "../components/ui";
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

/** One text file with versions, hardware, encoder test and recent logs, for bug reports. */
function DiagnosticsField() {
  const [state, setState] = useState<{ busy: boolean; ok?: string; err?: string }>({ busy: false });
  const run = async () => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const name = `KillCam-诊断-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.txt`;
    const path = await saveDialog({ defaultPath: name, filters: [{ name: "文本", extensions: ["txt"] }] });
    if (!path) return;
    setState({ busy: true });
    try {
      await api.exportDiagnostics(path);
      setState({ busy: false, ok: "已导出" });
      api.reveal(path).catch(() => {});
    } catch (e) {
      setState({ busy: false, err: errText(e) });
    }
  };
  return (
    <Field label="诊断信息" hint="遇到问题时导出，发到 GitHub Issues 或发给作者。里面有显卡、编码器检测和最近的录制日志，不含 API Key">
      <div className="row">
        <Button kind="ghost" small onClick={run} disabled={state.busy}>
          {state.busy ? <Spinner /> : "导出诊断信息"}
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

const SECTIONS = [
  ["ingame", "启动"],
  ["video", "画质"],
  ["screen", "屏幕"],
  ["audio", "声音"],
  ["hotkeys", "快捷键"],
  ["storage", "存储"],
  ["perf", "性能测试"],
  ["advanced", "高级"],
] as const;

type Tab = "general" | GameId;

export default function SettingsPage(props: { game: GameId; settings: Settings; onSaved: (s: Settings) => void; status: Status | null }) {
  // opens on the game being played / looked at, like the library and stats
  const [tab, setTab] = useState<Tab>(props.game);
  useEffect(() => {
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
      setMsg(errs.length ? { ok: false, text: `已保存，但有问题：${errs.join("；")}` } : { ok: true, text: recording ? "已保存，下次开始录制时生效" : "已保存" });
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    } finally {
      setSaving(false);
    }
  };

  const loadMonitors = () => {
    setMonitors(null);
    api.listMonitors().then(setMonitors).catch(() => setMonitors([]));
  };

  return (
    <div className="page settings">
      <header className="page-head">
        <h1>设置</h1>
        <GameSwitch<"general"> value={tab} onChange={setTab} extra={[{ value: "general", label: "通用", icon: <Settings2 size={14} /> }]} />
        {tab === "general" && (
          <nav className="toc">
            {SECTIONS.map(([id, label]) => (
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
            <Field label="自动录制" hint="打开 PUBG 时自动开始，关掉游戏结束。一次录制里打的每一局会分开成单独的对局">
              <Toggle checked={draft.gameSettings.pubg.enabled} onChange={(v) => setGameSettings(set, "pubg", { enabled: v })} label={draft.gameSettings.pubg.enabled ? "开启" : "关闭"} />
            </Field>
            <CaptureModeField settings={draft} set={set} game="pubg" />
            <ScreenDetectField settings={draft} set={set} detector={props.status?.detector} />
          </Card>
          <Card id="pubg-account" title="PUBG 账号" note="也可以从左下角的账号按钮修改">
            <PubgSection settings={draft} set={set} />
          </Card>
          <Card id="pubg-events" title="高光规则" note="只影响之后处理的对局">
            <EventsSection settings={draft} set={set} game="pubg" />
          </Card>
        </>
      )}

      {tab === "lol" && (
        <>
          <Card id="lol" title="英雄联盟">
            <Field label="自动录制" hint="进入对局（读条界面）时自动开始，回到客户端结束，一局一个录像">
              <Toggle checked={draft.gameSettings.lol.enabled} onChange={(v) => setGameSettings(set, "lol", { enabled: v })} label={draft.gameSettings.lol.enabled ? "开启" : "关闭"} />
            </Field>
            <CaptureModeField settings={draft} set={set} game="lol" />
            <Field label="支持的客户端">
              <ul className="support-list">
                <li>
                  <b>支持</b>：Riot 客户端的服务器，比如北美、欧洲、韩国、日本、东南亚、大洋洲、拉美
                </li>
                <li>
                  <b>暂不支持</b>：国服（WeGame / 腾讯客户端）
                </li>
                <li>回放和观战别人的对局不会录</li>
              </ul>
            </Field>
            <p className="muted small">
              击杀、多杀、大小龙、胜负都来自英雄联盟游戏本身提供的实时数据，不用读屏，也不用 API Key；伤害、金币等结算数据在打完后从客户端读取。
            </p>
          </Card>
          <Card id="lol-events" title="高光规则" note="只影响之后处理的对局">
            <EventsSection settings={draft} set={set} game="lol" />
          </Card>
        </>
      )}

      {tab === "general" && (
      <>
      <Card id="ingame" title="启动和游戏时">
        <Field label="开机自动启动" hint="开机后安静地待在右下角托盘里，打开游戏就自动开始录">
          <Toggle checked={draft.launchAtLogin} onChange={(v) => set((s) => ({ ...s, launchAtLogin: v }))} label={draft.launchAtLogin ? "开启" : "关闭"} />
        </Field>
        <Field label="迷你录制窗口" hint="打开游戏时自动最小化 KillCam，换成一个小窗口显示录制状态；关掉游戏后小窗口消失，KillCam 回来">
          <Toggle checked={draft.miniWindow} onChange={(v) => set((s) => ({ ...s, miniWindow: v }))} label={draft.miniWindow ? "开启" : "关闭"} />
        </Field>
        <p className="muted small">小窗口可以拖到任意位置，会记住。它不会被录进视频里。游戏要用「无边框窗口」模式，小窗口才能盖在游戏上面；用独占全屏的话，可以把它拖到别的显示器上。</p>
      </Card>

      <Card id="video" title="画质">
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

      <Card id="screen" title="屏幕" note={draft.video.monitorWidth ? `当前：屏幕 ${draft.video.monitorIndex + 1}（${draft.video.monitorWidth}×${draft.video.monitorHeight}）` : undefined}>
        {monitors === undefined ? (
          <Button kind="ghost" small onClick={loadMonitors}>
            识别显示器
          </Button>
        ) : (
          <MonitorPicker settings={draft} set={set} monitors={monitors} onRefresh={loadMonitors} />
        )}
        <p className="muted small">换了显示器分辨率之后，在这里重新识别一次。</p>
      </Card>

      <Card id="audio" title="声音">
        <AudioSection settings={draft} set={set} gameRunning={!!props.status?.gameRunning} />
      </Card>


      <Card id="hotkeys" title="快捷键">
        <HotkeySection settings={draft} set={set} />
        <Field label="标记提示音" hint="按标记键时「叮咚」一声确认标上了；没在录制时会响一声低音。游戏声音选「只录 PUBG」时不会被录进视频">
          <Toggle checked={draft.markerSound} onChange={(v) => set((s) => ({ ...s, markerSound: v }))} label={draft.markerSound ? "开启" : "关闭"} />
        </Field>
      </Card>

      <Card id="storage" title="存储">
        <StorageSection settings={draft} set={set} hardware={hw} />
      </Card>

      <Card id="perf" title="性能测试" note={dirty ? "用的是下面还没保存的设置" : undefined}>
        {recording ? <p className="muted">正在录制，停止后才能测试。</p> : <PerfStep
            settings={draft}
            gpuScale={scaleWorks(hw, draft.video.encoder)}
            result={perf}
            onResult={setPerf}
            goBack={() => document.getElementById("video")?.scrollIntoView()}
            onApply={(patch) => set((s) => ({ ...s, video: { ...s.video, ...patch } }))}
          />}
      </Card>

      <Card id="advanced" title="高级">
        <Field label="FFmpeg 位置" hint="留空会自动在 PATH 和 KillCam 目录里找">
          <input
            className="input mono"
            value={draft.ffmpegPath ?? ""}
            placeholder="例如 D:\tools\ffmpeg\bin\ffmpeg.exe"
            onChange={(e) => set((s) => ({ ...s, ffmpegPath: e.target.value || null }))}
          />
        </Field>
        <Field label="高光时间校准" hint="如果标记总是比画面早或晚，在这里修正">
          <Range
            value={draft.telemetryOffsetMs / 1000}
            min={-5}
            max={5}
            step={0.25}
            onChange={(v) => set((s) => ({ ...s, telemetryOffsetMs: Math.round(v * 1000) }))}
            format={(v) => (v === 0 ? "不调整" : v > 0 ? `标记往后 ${v}s` : `标记往前 ${-v}s`)}
          />
        </Field>
        <Field label="重新引导">
          <Button
            kind="ghost"
            small
            onClick={async () => {
              const s = { ...draft, onboarded: false };
              await api.saveSettings(s);
              props.onSaved(s);
            }}
          >
            重新走一遍初次设置
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
              撤销修改
            </Button>
            <Button kind="primary" onClick={save} disabled={saving}>
              {saving ? <Spinner /> : "保存设置"}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
