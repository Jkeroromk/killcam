import type { EventKind, MatchRecord } from "./api";
import { gameDef } from "./games";
import { label, t } from "./i18n";

export const KIND_LABEL_ZH: Record<EventKind, string> = {
  kill: "击杀",
  knock: "击倒",
  death: "阵亡",
  knocked: "被击倒",
  win: "吃鸡",
  manual: "手动标记",
  assist: "助攻",
  objective: "资源",
};

export const KIND_LABEL_EN: Record<EventKind, string> = {
  kill: "Kill",
  knock: "Knock",
  death: "Death",
  knocked: "Knocked",
  win: "Chicken Dinner",
  manual: "Marker",
  assist: "Assist",
  objective: "Objective",
};

/**
 * Kind names in the current UI language. Each key is a getter, so
 * `KIND_LABEL[kind]` read at render time follows a language switch.
 */
export const KIND_LABEL = {} as Record<EventKind, string>;
for (const k of Object.keys(KIND_LABEL_ZH) as EventKind[]) {
  Object.defineProperty(KIND_LABEL, k, { enumerable: true, get: () => t(KIND_LABEL_ZH[k], KIND_LABEL_EN[k]) });
}

/** The label of a kind in a given game (a League win isn't a chicken dinner). */
export function kindLabel(kind: EventKind, game?: string | null): string {
  if (kind === "win") return gameDef(game).win;
  return t(KIND_LABEL_ZH[kind], KIND_LABEL_EN[kind]);
}

export const KIND_ORDER: EventKind[] = ["kill", "knock", "win", "manual", "death", "knocked", "assist", "objective"];

export const isLol = (m: Pick<MatchRecord, "game">) => m.game === "lol";

export function gameName(id?: string | null): string {
  return gameDef(id).name;
}

export function kda(k: number, d: number, a: number): string {
  return d === 0 ? t("完美", "Perfect") : ((k + a) / d).toFixed(1);
}

export function clock(s: number): string {
  if (!isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const mm = String(m).padStart(h ? 2 : 1, "0");
  const ss = String(sec).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function bytes(n: number): string {
  if (!n) return "0 MB";
  const gb = n / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(gb >= 100 ? 0 : 1)} GB`;
  return `${(n / 1024 ** 2).toFixed(0)} MB`;
}

export function when(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yest = new Date(now.getTime() - 86400000).toDateString() === d.toDateString();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (sameDay) return t(`今天 ${hm}`, `Today ${hm}`);
  if (yest) return t(`昨天 ${hm}`, `Yesterday ${hm}`);
  return t(`${d.getMonth() + 1}月${d.getDate()}日 ${hm}`, `${MONTHS_EN[d.getMonth()]} ${d.getDate()} ${hm}`);
}

const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function eventLine(e: { kind: EventKind; victim: string | null; weapon: string | null; distanceM: number | null; headshot: boolean; detail?: string | null }): string {
  const parts: string[] = [];
  if (e.kind === "objective" && e.victim) {
    const obj = label(e.victim);
    return e.detail === "抢" ? t(`抢下 ${obj}`, `Stole ${obj}`) : obj;
  }
  if (e.kind === "death" || e.kind === "knocked") {
    if (e.victim) parts.push(t(`被 ${e.victim}`, `by ${e.victim}`));
  } else if (e.victim) {
    parts.push(e.victim);
  }
  if (e.weapon) parts.push(label(e.weapon));
  if (e.distanceM != null && e.distanceM > 0) parts.push(t(`${Math.round(e.distanceM)} 米`, `${Math.round(e.distanceM)} m`));
  if (e.headshot) parts.push(t("爆头", "Headshot"));
  // "双杀 · 团灭"
  if (e.detail) parts.push(e.detail.split(" · ").map(label).join(" · "));
  return parts.join(t("，", ", "));
}

/** Versions read as 1.1, 1.2…: the installer needs three parts (1.1.0), people don't. */
export function shortVersion(v?: string | null): string {
  return v ? v.replace(/^(\d+\.\d+)\.0$/, "$1") : "–";
}
