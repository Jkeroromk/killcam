import { useEffect, useState, type ReactNode } from "react";
import { api, fileUrl, on, type GameId } from "../lib/api";
import { gameName } from "../lib/format";

// icons come from the games installed on this PC; read them once per run
let iconCache: Partial<Record<GameId, string>> | null = null;
let iconLoad: Promise<Partial<Record<GameId, string>>> | null = null;

function loadIcons(force = false) {
  if (force) iconLoad = null;
  if (!iconLoad) {
    iconLoad = api
      .gameIcons()
      .then((m) => (iconCache = m))
      .catch(() => (iconCache = {}));
  }
  return iconLoad;
}

export function useGameIcons() {
  const [icons, setIcons] = useState(iconCache ?? {});
  useEffect(() => {
    let live = true;
    loadIcons().then((m) => live && setIcons(m));
    // a game just started: its icon may have been saved now
    const un = on<null>("game-icons", () => loadIcons(true).then((m) => live && setIcons(m)));
    return () => {
      live = false;
      un();
    };
  }, []);
  return icons;
}

/** The game's own icon, or its name as a text badge when it isn't installed. */
export function GameLogo(props: { game: GameId; size?: number }) {
  const icons = useGameIcons();
  const [broken, setBroken] = useState(false);
  const size = props.size ?? 22;
  const src = icons[props.game];
  if (src && !broken) {
    return <img className="game-logo" src={fileUrl(src)} alt="" width={size} height={size} onError={() => setBroken(true)} />;
  }
  return (
    <span className="game-logo game-logo-text" style={{ width: size, height: size }}>
      {props.game === "lol" ? "LoL" : "PUBG"}
    </span>
  );
}

export const GAMES: GameId[] = ["pubg", "lol"];

/** Pick a game by its icon; `extra` options (e.g. general settings) come first. */
export function GameSwitch<T extends string>(props: {
  value: GameId | T;
  onChange: (v: GameId | T) => void;
  extra?: { value: T; label: string; icon: ReactNode }[];
}) {
  return (
    <div className="game-switch" role="tablist">
      {props.extra?.map((x) => (
        <button
          key={x.value}
          type="button"
          role="tab"
          aria-selected={props.value === x.value}
          className={"game-tab" + (props.value === x.value ? " is-on" : "")}
          onClick={() => props.onChange(x.value)}
        >
          <span className="game-logo game-logo-icon">{x.icon}</span>
          {x.label}
        </button>
      ))}
      {GAMES.map((g) => (
        <button
          key={g}
          type="button"
          role="tab"
          aria-selected={props.value === g}
          className={"game-tab" + (props.value === g ? " is-on" : "")}
          onClick={() => props.onChange(g)}
        >
          <GameLogo game={g} />
          {gameName(g)}
        </button>
      ))}
    </div>
  );
}
