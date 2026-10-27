import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Bookmark, Circle, Square, X, RefreshCw, Video, Gamepad2, Clock } from "lucide-react";
import { api, errText, type MatchRecord, type Settings, type Status, type StorageInfo } from "../lib/api";
import { bytes, clock, gameName } from "../lib/format";
import { Button, Spinner } from "../components/ui";
import { MatchCard } from "./Library";
import { GameLogo } from "../components/GameSwitch";
import { GAME_IDS, GAMES } from "../lib/games";
import { isLol } from "../lib/format";
import type { GameId } from "../lib/api";
import { plural, t } from "../lib/i18n";

const CARD_MIN_W = 300;
const CARD_GAP = 18;

/** How many recent cards fit: as many columns as the width allows, and how many
 *  rows in all fit on screen without scrolling (at least one per game). */
function useRecentGrid(ref: { current: HTMLElement | null }, games: number) {
  const [grid, setGrid] = useState({ cols: 3, rows: games || 1 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const cols = Math.max(1, Math.floor((el.clientWidth + CARD_GAP) / (CARD_MIN_W + CARD_GAP)));
      const view = el.closest(".content") as HTMLElement | null;
      const page = el.closest(".page") as HTMLElement | null;
      const card = el.querySelector(".mcard") as HTMLElement | null;
      let rows = Math.max(1, games);
      if (view && page && card && games > 0) {
        const cardH = card.getBoundingClientRect().height;
        // everything on the page that isn't a card row stays as it is; the
        // rest of the window is room for card rows
        const grids = Array.from(el.querySelectorAll(".cards")) as HTMLElement[];
        const cardsH = grids.reduce((s, g) => s + g.getBoundingClientRect().height, 0);
        const other = page.getBoundingClientRect().height - cardsH;
        const room = view.clientHeight - other;
        // R rows over `games` grids: R card heights + (R - games) gaps
        const fit = Math.floor((room + games * CARD_GAP) / (cardH + CARD_GAP));
        rows = Math.max(games, Math.min(games * 3, fit));
      }
      setGrid((g) => (g.cols === cols && g.rows === rows ? g : { cols, rows }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [ref, games]);
  return grid;
}

export default function Dashboard(props: {
  status: Status | null;
  settings: Settings;
  libVersion: number;
  openMatch: (id: string) => void;
  openLibrary: (game?: GameId) => void;
}) {
  const s = props.status;
  const [recent, setRecent] = useState<MatchRecord[] | null>(null);
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const recentRef = useRef<HTMLElement | null>(null);
  const gamesShown = recent ? GAME_IDS.filter((g) => recent.some((m) => (g === "lol") === isLol(m))).length : 0;
  const grid = useRecentGrid(recentRef, gamesShown);
  // every game gets a row; rows left over go to the games with the most
  // recordings, and only when they can fill a whole row
  const rowsFor: Partial<Record<GameId, number>> = {};
  if (recent) {
    const count = (g: GameId) => recent.filter((m) => (g === "lol") === isLol(m)).length;
    const shown = GAME_IDS.filter((g) => count(g) > 0);
    shown.forEach((g) => (rowsFor[g] = 1));
    let extra = grid.rows - shown.length;
    while (extra > 0) {
      const next = shown
        .filter((g) => count(g) >= (rowsFor[g]! + 1) * grid.cols)
        .sort((a, b) => count(b) - rowsFor[b]! * grid.cols - (count(a) - rowsFor[a]! * grid.cols))[0];
      if (!next) break;
      rowsFor[next] = (rowsFor[next] ?? 1) + 1;
      extra--;
    }
  }

  useEffect(() => {
    api.listMatches().then(setRecent).catch(() => setRecent([]));
    api.storageInfo().then(setStorage).catch(() => {});
  }, [props.libVersion]);

  const toggle = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (s?.recording) await api.stopRecording();
      else await api.startRecording();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const st = s?.stats;
  const fpsOk = !st || !s?.recording || st.reports < 4 || st.fps >= props.settings.video.fps * 0.95;
  const speedOk = !st || !s?.recording || st.reports < 4 || st.speed >= 0.95;

  return (
    <div className="page page-wide">
      <section className={"status" + (s?.recording ? " is-rec" : "")}>
        <div className="status-main">
          <div className="status-icon">{s?.recording ? <Video size={22} /> : s?.gameRunning ? <Gamepad2 size={22} /> : <Clock size={22} />}</div>
          <div>
            <div className="status-title">
              {s?.recording ? (
                <>
                  <span className="rec-dot big" />
                  {s.autoSession ? t(`正在录制 ${gameName(s.game)}`, `Recording ${gameName(s.game)}`) : t("正在录制", "Recording")}
                  <span className="status-clock">{clock(s.elapsedS)}</span>
                </>
              ) : s?.gameRunning ? (
                t(`${gameName(s.game)} 正在运行`, `${gameName(s.game)} is running`)
              ) : (
                t("等待游戏启动", "Waiting for a game")
              )}
            </div>
            <div className="status-sub">
              {s?.recording
                ? s.game === "lol"
                  ? t(
                      `读取游戏数据中 · ${s.liveKills ?? 0}/${s.liveDeaths ?? 0}/${s.liveAssists ?? 0}`,
                      `Reading game data · ${s.liveKills ?? 0}/${s.liveDeaths ?? 0}/${s.liveAssists ?? 0}`,
                    )
                  : s.detector === "active"
                  ? t(`读屏识别中 · 已识别 ${s.detections} 个事件`, `Screen reading · ${s.detections} ${plural(s.detections, "event", "events")} found`)
                  : t("全程显卡录制，不占游戏帧数", "Recorded on the GPU, no FPS cost")
                : props.settings.autoRecord
                  ? t("打开 PUBG 或英雄联盟会自动开始录制，关掉游戏自动结束", "Recording starts when you open PUBG or LoL and stops when you close it")
                  : t("自动录制已关闭，需要手动开始", "Auto-recording is off; start it manually")}
            </div>
          </div>
        </div>
        <div className="status-actions">
          <Button kind="ghost" onClick={() => api.addMarker()} disabled={!s?.recording}>
            <Bookmark size={16} /> {t("标记", "Mark")}
            {props.settings.hotkeys.highlight && <kbd>{props.settings.hotkeys.highlight}</kbd>}
          </Button>
          <Button kind={s?.recording ? "danger" : "primary"} onClick={toggle} disabled={busy}>
            {busy ? <Spinner /> : s?.recording ? <Square size={15} /> : <Circle size={15} />}
            {s?.recording ? t("停止录制", "Stop recording") : t("开始录制", "Start recording")}
          </Button>
        </div>
        {s?.recording && st && (
          <div className="status-stats">
            <Stat label={t("录制帧率", "Frame rate")} value={st.fps.toFixed(0)} bad={!fpsOk} />
            <Stat label={t("编码速度", "Encode speed")} value={`${st.speed.toFixed(2)}×`} bad={!speedOk} />
            <Stat label={t("分辨率", "Resolution")} value={s.width ? `${s.width}×${s.height}` : "–"} />
            <Stat label={t("已写入", "Written")} value={bytes(st.sizeBytes)} />
            <Stat label={t("手动标记", "Markers")} value={String(s.markers)} />
            {s.detector === "active" && <Stat label={t("读屏识别", "Screen reading")} value={String(s.detections)} />}
          </div>
        )}
      </section>

      {(err || s?.lastError || (s?.warnings.length ?? 0) > 0 || (s?.notices.length ?? 0) > 0) && (
        <section className="notices">
          {err && <p className="warn-text">{err}</p>}
          {s?.lastError && <pre className="log">{s.lastError}</pre>}
          {s?.warnings.map((w) => (
            <p className="warn-text" key={w}>
              {w}
            </p>
          ))}
          {s?.notices.map((w) => (
            <p className="muted" key={w}>
              {w}
            </p>
          ))}
          <Button small kind="ghost" onClick={() => api.clearNotices()}>
            <X size={14} /> {t("清除", "Clear")}
          </Button>
        </section>
      )}

      {s?.waitingMinutes != null && !s.processing && (
        <section className="processing is-wait">
          <span>
            {t(
              `高光已经按读屏先剪好了，可以直接看。PUBG 官方数据到了会自动补上地图、排名和击杀详情（最多还要 ${s.waitingMinutes} 分钟）。`,
              `Highlights are already cut from screen reading and ready to watch. Map, place and kill details are added when PUBG's official data arrives (up to ${s.waitingMinutes} more ${plural(s.waitingMinutes, "minute", "minutes")}).`,
            )}
          </span>
          <span className="grow" />
          <Button small kind="ghost" onClick={() => api.syncNow(true)}>
            {t("不用官方数据了", "Skip official data")}
          </Button>
        </section>
      )}

      {s?.processing && (
        <section className="processing">
          <Spinner /> {s.processing}
        </section>
      )}

      <section className="block" ref={recentRef}>
        <header className="block-head">
          <h2>{t("最近的对局", "Recent matches")}</h2>
          <span className="grow" />
          <Button small kind="ghost" onClick={() => api.syncNow(false)} title={t("立即从 PUBG 拉取最新对局", "Fetch the latest matches from PUBG now")}>
            <RefreshCw size={14} /> {t("立即同步", "Sync now")}
          </Button>
        </header>
        {!recent ? (
          <Spinner />
        ) : recent.length === 0 ? (
          <p className="empty">
            {t(
              "还没有录像。打开 PUBG 或英雄联盟打一局，结束后这里就会出现带高光标记的录像。",
              "No recordings yet. Play a game of PUBG or LoL and it shows up here with its highlights marked.",
            )}
          </p>
        ) : (
          // one row per game, newest first within each
          GAME_IDS.map((g) => {
            const mine = recent.filter((m) => (g === "lol") === isLol(m));
            if (mine.length === 0) return null;
            return (
              <div key={g} className="recent-game">
                <div className="recent-head">
                  <GameLogo game={g} size={20} />
                  <b>{GAMES[g].name}</b>
                  <span className="muted small">{t(`${mine.length} 局`, `${mine.length} ${plural(mine.length, "game", "games")}`)}</span>
                  <span className="grow" />
                  <Button small kind="ghost" onClick={() => props.openLibrary(g)}>
                    {t(`全部 ${GAMES[g].name} 录像`, `All ${GAMES[g].name} recordings`)}
                  </Button>
                </div>
                <div className="cards" style={{ gridTemplateColumns: `repeat(${grid.cols}, minmax(0, 1fr))` }}>
                  {mine.slice(0, grid.cols * (rowsFor[g] ?? 1)).map((m) => (
                    <MatchCard key={m.id} m={m} onOpen={() => props.openMatch(m.id)} />
                  ))}
                </div>
              </div>
            );
          })
        )}
      </section>

      {storage && (
        <section className="storage">
          <div className="storage-bar">
            <div style={{ width: `${Math.min(100, (storage.usedBytes / (storage.limitGb * 1024 ** 3)) * 100)}%` }} />
          </div>
          <span>
            {t(
              `已用 ${bytes(storage.usedBytes)} / 上限 ${storage.limitGb} GB · 硬盘剩余 ${bytes(storage.freeBytes)}`,
              `${bytes(storage.usedBytes)} of ${storage.limitGb} GB used · ${bytes(storage.freeBytes)} free on disk`,
            )}
          </span>
          <button type="button" className="link" onClick={() => api.reveal(storage.libraryDir)}>
            {storage.libraryDir}
          </button>
        </section>
      )}
    </div>
  );
}

function Stat(props: { label: string; value: string; bad?: boolean }) {
  return (
    <div className={"stat" + (props.bad ? " is-bad" : "")}>
      <span className="stat-value">{props.value}</span>
      <span className="stat-label">{props.label}</span>
    </div>
  );
}

