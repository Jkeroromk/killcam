import type { EventKind, MatchRecord } from "./api";

export const KIND_LABEL: Record<EventKind, string> = {
  kill: "击杀",
  knock: "击倒",
  death: "阵亡",
  knocked: "被击倒",
  win: "吃鸡",
  manual: "手动标记",
  assist: "助攻",
  objective: "资源",
};

/** The label of a kind in a given game (a League win isn't a chicken dinner). */
export function kindLabel(kind: EventKind, game?: string | null): string {
  if (kind === "win" && game === "lol") return "胜利";
  return KIND_LABEL[kind];
}

export const KIND_ORDER: EventKind[] = ["kill", "knock", "win", "manual", "death", "knocked", "assist", "objective"];

export const isLol = (m: Pick<MatchRecord, "game">) => m.game === "lol";

export function gameName(id?: string | null): string {
  return id === "lol" ? "英雄联盟" : "PUBG";
}

/** Champion square icon by Data Dragon key (e.g. "MonkeyKing"). */
export function championIcon(key: string): string {
  return `https://cdn.communitydragon.org/latest/champion/${encodeURIComponent(key)}/square`;
}

export function kda(k: number, d: number, a: number): string {
  return d === 0 ? "完美" : ((k + a) / d).toFixed(1);
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
  if (sameDay) return `今天 ${hm}`;
  if (yest) return `昨天 ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

export function eventLine(e: { kind: EventKind; victim: string | null; weapon: string | null; distanceM: number | null; headshot: boolean; detail?: string | null }): string {
  const parts: string[] = [];
  if (e.kind === "objective" && e.victim) {
    return e.detail === "抢" ? `抢下 ${e.victim}` : e.victim;
  }
  if (e.kind === "death" || e.kind === "knocked") {
    if (e.victim) parts.push(`被 ${e.victim}`);
  } else if (e.victim) {
    parts.push(e.victim);
  }
  if (e.weapon) parts.push(e.weapon);
  if (e.distanceM != null && e.distanceM > 0) parts.push(`${Math.round(e.distanceM)} 米`);
  if (e.headshot) parts.push("爆头");
  if (e.detail) parts.push(e.detail);
  return parts.join("，");
}
