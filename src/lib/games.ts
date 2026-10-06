import type { EventKind, GameId } from "./api";

export interface RuleKind {
  kind: EventKind;
  /** overrides the kind's usual label (e.g. a win is 吃鸡 in PUBG) */
  label?: string;
  note: string;
}

export interface GameDef {
  id: GameId;
  name: string;
  /** text badge when the game's own icon isn't available */
  short: string;
  /** what the highlight rules offer, in order */
  rules: RuleKind[];
  /** event kinds in the match timeline legend */
  legend: EventKind[];
  /** what a win is called */
  win: string;
}

/** Every supported game. Pages, switches and rule lists are built from this. */
export const GAMES: Record<GameId, GameDef> = {
  pubg: {
    id: "pubg",
    name: "PUBG",
    short: "PUBG",
    win: "吃鸡",
    legend: ["kill", "knock", "win", "manual", "death"],
    rules: [
      { kind: "kill", note: "你拿到的击杀" },
      { kind: "knock", note: "你打倒的人" },
      { kind: "win", label: "吃鸡", note: "大吉大利，今晚吃鸡" },
      { kind: "death", note: "你被淘汰的那一下" },
      { kind: "knocked", note: "你被打倒" },
      { kind: "manual", note: "按快捷键手动标记" },
    ],
  },
  lol: {
    id: "lol",
    name: "英雄联盟",
    short: "LoL",
    win: "胜利",
    legend: ["kill", "assist", "objective", "win", "manual", "death"],
    rules: [
      { kind: "kill", note: "你拿到的击杀，双杀到五杀会合成一段" },
      { kind: "objective", note: "你拿下或参与的小龙、先锋、大龙，你推掉的塔和水晶" },
      { kind: "assist", note: "你参与的击杀" },
      { kind: "win", label: "胜利", note: "推掉对面水晶" },
      { kind: "death", note: "你被击杀的那一下" },
      { kind: "manual", note: "按快捷键手动标记" },
    ],
  },
};

export const GAME_IDS = Object.keys(GAMES) as GameId[];

export function gameDef(id?: string | null): GameDef {
  return GAMES[(id ?? "pubg") as GameId] ?? GAMES.pubg;
}
