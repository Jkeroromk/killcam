import { useEffect, useState } from "react";
import { BarChart3, Crosshair, Film, Settings2 } from "lucide-react";
import { api, on, type GameId, type Settings, type Status } from "./lib/api";
import { clock, gameName } from "./lib/format";
import Onboarding from "./onboarding/Onboarding";
import Dashboard from "./pages/Dashboard";
import Library from "./pages/Library";
import MatchView from "./pages/MatchView";
import SettingsPage from "./pages/SettingsPage";
import StatsPage from "./pages/StatsPage";
import { Spinner } from "./components/ui";
import { UpdateCard } from "./components/UpdateCard";
import { AccountButton } from "./components/AccountButton";

type Page = { name: "home" } | { name: "library" } | { name: "match"; id: string } | { name: "stats" } | { name: "settings" };

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [page, setPage] = useState<Page>({ name: "home" });
  const [libVersion, setLibVersion] = useState(0);
  // the game the library, stats and settings show; follows the game being played
  const [game, setGameState] = useState<GameId>(() => {
    try {
      return localStorage.getItem("kc.game") === "lol" ? "lol" : "pubg";
    } catch {
      return "pubg";
    }
  });
  const setGame = (g: GameId) => {
    setGameState(g);
    try {
      localStorage.setItem("kc.game", g);
    } catch {
      /* not kept */
    }
  };
  const playing = status?.gameRunning ? status.game : null;
  useEffect(() => {
    if (playing === "pubg" || playing === "lol") setGame(playing);
  }, [playing]);

  useEffect(() => {
    api.getSettings().then(setSettings);
    api.getStatus().then(setStatus);
    const u1 = on<Status>("status", setStatus);
    const u2 = on<number>("library-changed", () => setLibVersion((v) => v + 1));
    // the backend changed a setting by itself (e.g. switched to a working encoder)
    const u3 = on<null>("settings-changed", () => api.getSettings().then(setSettings));
    return () => {
      u1();
      u2();
      u3();
    };
  }, []);

  if (!settings) {
    return (
      <div className="boot">
        <Spinner />
      </div>
    );
  }

  if (!settings.onboarded) {
    return <Onboarding initial={settings} onDone={(s) => setSettings(s)} />;
  }

  const nav = (name: "home" | "library" | "stats" | "settings") => setPage({ name } as Page);
  const current = page.name === "match" ? "library" : page.name;

  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          <span className="brand-name">KillCam</span>
        </div>
        <nav className="rail-nav">
          <button type="button" className={current === "home" ? "is-on" : ""} onClick={() => nav("home")}>
            <Crosshair size={18} /> 总览
          </button>
          <button type="button" className={current === "library" ? "is-on" : ""} onClick={() => nav("library")}>
            <Film size={18} /> 录像库
          </button>
          <button type="button" className={current === "stats" ? "is-on" : ""} onClick={() => nav("stats")}>
            <BarChart3 size={18} /> 数据
          </button>
          <button type="button" className={current === "settings" ? "is-on" : ""} onClick={() => nav("settings")}>
            <Settings2 size={18} /> 设置
          </button>
        </nav>
        <div className="rail-foot">
          <AccountButton settings={settings} onSaved={setSettings} />
          <UpdateCard status={status} />
          {status?.recording ? (
            <div className="rec-pill is-rec">
              <span className="rec-dot" /> 录制中 {clock(status.elapsedS)}
            </div>
          ) : status?.processing ? (
            <div className="rec-pill">
              <Spinner /> {status.processing}
            </div>
          ) : (
            <div className="rec-pill">{status?.gameRunning ? `${gameName(status.game)} 运行中` : "等待游戏启动"}</div>
          )}
        </div>
      </aside>
      <main className="content">
        {page.name === "home" && (
          <Dashboard status={status} settings={settings} libVersion={libVersion} openMatch={(id) => setPage({ name: "match", id })} openLibrary={(g) => {
            if (g) setGame(g);
            nav("library");
          }} />
        )}
        {page.name === "library" && <Library game={game} setGame={setGame} libVersion={libVersion} openMatch={(id) => setPage({ name: "match", id })} />}
        {page.name === "match" && <MatchView id={page.id} back={() => nav("library")} libVersion={libVersion} />}
        {page.name === "stats" && <StatsPage game={game} setGame={setGame} libVersion={libVersion} openMatch={(id) => setPage({ name: "match", id })} />}
        {page.name === "settings" && <SettingsPage game={game} settings={settings} onSaved={setSettings} status={status} />}
      </main>
    </div>
  );
}
