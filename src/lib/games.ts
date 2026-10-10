import type { EventKind, GameId } from "./api";
import { t } from "./i18n";

export interface RuleKind {
  kind: EventKind;
  /** overrides the kind's usual label (e.g. a win is 吃鸡 in PUBG) */
  label?: string;
  note: string;
}

export interface GameDef {
  id: GameId;
  name: string;
  /** text badge when no icon is available */
  short: string;
  /** icon shipped with KillCam (otherwise the installed game's own icon is used) */
  logo?: string;
  /** what the highlight rules offer, in order */
  rules: RuleKind[];
  /** event kinds in the match timeline legend */
  legend: EventKind[];
  /** what a win is called */
  win: string;
}

/**
 * Every supported game. Pages, switches and rule lists are built from this.
 * Text fields are getters so they follow the current UI language.
 */
export const GAMES: Record<GameId, GameDef> = {
  pubg: {
    id: "pubg",
    name: "PUBG",
    short: "PUBG",
    logo: "/games/pubg.png",
    get win() {
      return t("吃鸡", "Chicken Dinner");
    },
    legend: ["kill", "knock", "win", "manual", "death"],
    rules: [
      { kind: "kill", get note() { return t("你拿到的击杀", "Your kills"); } },
      { kind: "knock", get note() { return t("你打倒的人", "Players you knock"); } },
      { kind: "win", get label() { return t("吃鸡", "Chicken Dinner"); }, get note() { return t("大吉大利，今晚吃鸡", "Winner winner, chicken dinner"); } },
      { kind: "death", get note() { return t("你被淘汰的那一下", "The moment you're eliminated"); } },
      { kind: "knocked", get note() { return t("你被打倒", "When you get knocked"); } },
      { kind: "manual", get note() { return t("按快捷键手动标记", "Marked with the hotkey"); } },
    ],
  },
  lol: {
    id: "lol",
    get name() {
      return t("英雄联盟", "League of Legends");
    },
    short: "LoL",
    get win() {
      return t("胜利", "Victory");
    },
    legend: ["kill", "assist", "objective", "win", "manual", "death"],
    rules: [
      { kind: "kill", get note() { return t("你拿到的击杀，双杀到五杀会合成一段", "Your kills; double to penta kills become one clip"); } },
      { kind: "objective", get note() { return t("你拿下或参与的小龙、先锋、大龙，你推掉的塔和水晶", "Drakes, Herald and Baron you take or help with; turrets and inhibitors you destroy"); } },
      { kind: "assist", get note() { return t("你参与的击杀", "Kills you help with"); } },
      { kind: "win", get label() { return t("胜利", "Victory"); }, get note() { return t("推掉对面水晶", "Destroy the enemy Nexus"); } },
      { kind: "death", get note() { return t("你被击杀的那一下", "The moment you die"); } },
      { kind: "manual", get note() { return t("按快捷键手动标记", "Marked with the hotkey"); } },
    ],
  },
};

export const GAME_IDS = Object.keys(GAMES) as GameId[];

export function gameDef(id?: string | null): GameDef {
  return GAMES[(id ?? "pubg") as GameId] ?? GAMES.pubg;
}
