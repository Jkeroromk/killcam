import { useEffect, useState, type MouseEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AlertTriangle, Bookmark, Circle, Crosshair, Eye, Maximize2, Skull, Square, X } from "lucide-react";
import { api, on, type Status } from "../lib/api";
import { bytes, clock } from "../lib/format";
import { Spinner } from "../components/ui";
import { resolveLang, setLang, t } from "../lib/i18n";

/** The small always-on-top window shown while PUBG runs. */
export default function Mini() {
  const [status, setStatus] = useState<Status | null>(null);
  const [hotkey, setHotkey] = useState("F9");
  const [autoRecord, setAutoRecord] = useState(true);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [, setLangState] = useState("");

  useEffect(() => {
    api.getStatus().then(setStatus);
    const read = () =>
      api.getSettings().then((s) => {
        setHotkey(s.hotkeys.highlight || "F9");
        setAutoRecord(s.autoRecord);
        const l = resolveLang(s.language);
        setLang(l);
        setLangState(l);
      });
    read();
    const u3 = on<null>("settings-changed", read);
    const u1 = on<Status>("status", setStatus);
    const u2 = on<number>("marker", () => {
      setFlash(true);
      setTimeout(() => setFlash(false), 700);
    });
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      u1();
      u2();
      u3();
      clearInterval(tick);
    };
  }, []);

  const drag = (e: MouseEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    getCurrentWindow()
      .startDragging()
      .catch(() => {});
  };

  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await f();
    } catch {
      /* the main window shows the error */
    } finally {
      setBusy(false);
    }
  };

  const s = status;
  const rec = !!s?.recording;
  const elapsed = rec && s?.startedAtMs ? (now - s.startedAtMs) / 1000 : 0;
  // counts and time are per game: they start over when the next game starts
  const round = rec && s?.roundStartedMs ? Math.max(0, (now - s.roundStartedMs) / 1000) : null;
  const reading = s?.detector === "active";
  const lol = rec && s?.game === "lol";
  // the screen reader restarts itself after display-mode changes; only show real problems
  const problem = s?.lastError || s?.warnings[0] || null;

  return (
    <div className={"mini" + (rec ? " is-rec" : "") + (flash ? " is-flash" : "")} onMouseDown={drag}>
      <div className="mini-top">
        {rec ? (
          <>
            <span className="rec-dot" />
            <b>{round != null ? t("本局", "This match") : t("录制中", "Recording")}</b>
            <span className="mono mini-clock" title={t(`这次一共录了 ${clock(elapsed)}`, `Recorded ${clock(elapsed)} in total`)}>
              {clock(round ?? elapsed)}
            </span>
          </>
        ) : s?.gameRunning && autoRecord && !s.lastError ? (
          <>
            <Spinner />
            <b>{t("准备录制…", "Getting ready…")}</b>
          </>
        ) : (
          <>
            <Circle size={10} className="mini-idle" />
            <b>{t("未在录制", "Not recording")}</b>
          </>
        )}
        <span className="grow" />
        {problem && (
          <span className="mini-warn" title={problem}>
            <AlertTriangle size={14} />
          </span>
        )}
        <button type="button" className="iconbtn xs" title={t("打开 KillCam", "Open KillCam")} onClick={() => api.showMainWindow()}>
          <Maximize2 size={13} />
        </button>
        <button type="button" className="iconbtn xs" title={t("关掉小窗口（把 KillCam 最小化或关到托盘时会再出现）", "Close the mini window (it comes back when KillCam is minimized or closed to the system tray)")} onClick={() => api.closeMini()}>
          <X size={14} />
        </button>
      </div>

      <div className="mini-stats">
        {lol ? (
          <span className="mini-stat" title={t("这局的击杀 / 阵亡 / 助攻（来自游戏数据）", "Kills / deaths / assists this match (from game data)")}>
            <Skull size={14} strokeWidth={2.4} />
            <b>
              {s!.liveKills ?? 0}/{s!.liveDeaths ?? 0}/{s!.liveAssists ?? 0}
            </b>
          </span>
        ) : (
          <>
            <span className="mini-stat" title={
                reading
                  ? t("这局读屏识别到的击杀", "Kills seen by screen reading this match")
                  : t("读屏没开启，结束后用 PUBG 数据补上", "Screen reading is off; filled in from PUBG data after the match")
              }>
              <Skull size={14} strokeWidth={2.4} />
              <b>{reading ? s!.liveKills : "–"}</b>
            </span>
            <span className="mini-stat" title={t("这局读屏识别到的击倒", "Knocks seen by screen reading this match")}>
              <Crosshair size={14} strokeWidth={2.4} />
              <b>{reading ? s!.liveKnocks : "–"}</b>
            </span>
          </>
        )}
        <span className="mini-stat" title={t("这局的手动标记", "Markers this match")}>
          <Bookmark size={14} strokeWidth={2.4} />
          <b>{s?.roundMarkers ?? s?.markers ?? 0}</b>
        </span>
        <span className="grow" />
        {rec && reading && s!.spectating ? (
          <span className="mini-spect" title={t(
              "正在观战队友：这段时间屏幕上的击杀、击倒算队友的，不会剪进你的高光",
              "Spectating a teammate: kills and knocks on screen now are theirs and won't be clipped into your highlights",
            )}>
            <Eye size={13} /> {t("观战中", "Spectating")}
          </span>
        ) : rec && (
          <span className="mini-meta mono">
            {s!.stats.fps > 0 ? `${Math.round(s!.stats.fps)} fps · ` : ""}
            {bytes(s!.stats.sizeBytes)}
          </span>
        )}
      </div>

      <div className="mini-actions">
        {rec ? (
          <>
            <button type="button" className="mini-btn is-main" onClick={() => api.addMarker()}>
              <Bookmark size={13} /> {t("标记高光", "Mark")} <kbd>{hotkey}</kbd>
            </button>
            <button type="button" className="mini-btn" disabled={busy} onClick={() => run(api.stopRecording)}>
              <Square size={11} fill="currentColor" /> {t("停止", "Stop")}
            </button>
          </>
        ) : (
          <button type="button" className="mini-btn is-main" disabled={busy} onClick={() => run(api.startRecording)}>
            <Circle size={11} fill="currentColor" /> {t("开始录制", "Start recording")}
          </button>
        )}
      </div>
    </div>
  );
}
