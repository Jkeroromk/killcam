// 一键卡点: the bin's clips laid on the timeline to fit a song.
//
// What the montages people like have in common (measured on a few popular
// PUBG ones): whole fights left uncut, the best one starting where the song
// kicks in, the music stepping back for the big fight and slamming back in,
// and hard cuts almost everywhere.
//
// Every moment is used once: clips of the same match that overlap are
// merged into one fight, so nothing plays twice.

import type { GameEvent } from "./api";
import { newKey, type EditItem, type TClip, type Trans } from "./edit";

export interface MusicInfo {
  duration: number;
  bpm: number;
  beat: number;
  beats: number[];
  downbeats: number[];
  onsets: [number, number][];
  energy: number[];
  drop: number;
}

export interface AutoOpts {
  /** seconds; 0 = the rest of the song */
  length: number;
  trans: Trans;
  pull: boolean;
}

export interface AutoCut {
  timeline: TClip[];
  musicOffset: number;
  pulls: [number, number][];
}

interface Fight {
  item: EditItem;
  events: GameEvent[];
  kills: GameEvent[];
  first: number;
  last: number;
  score: number;
  win: boolean;
}

/** what a fight is made of: no chicken dinner, no markers, only the fighting */
const MOMENTS = new Set(["kill", "knock", "objective"]);
/** seconds before a fight's first moment */
export const LEAD = 2.2;
/** after its last */
export const TAIL = 1.5;
/** moments further apart than this are cut apart, the wait in between dropped */
export const GAP = 4.5;

function score(e: GameEvent): number {
  // kills count most: a fight with more kills always comes first
  let s = e.kind === "kill" ? 10 : e.kind === "knock" ? 1.2 : e.kind === "objective" ? 2 : 0;
  if (e.headshot) s += 1.5;
  if ((e.distanceM ?? 0) >= 100) s += 1.5;
  if ((e.distanceM ?? 0) >= 250) s += 1.5;
  const d = e.detail ?? "";
  if (/双杀|三杀|四杀|五杀|团灭/.test(d)) s += 3;
  if (d.includes("抢")) s += 2;
  return s;
}

/** The bin's fights: each match's moments (once, whatever clips they're in)
 *  grouped when under 8 s apart, with the clip that has the most footage of it. */
export function fights(items: EditItem[]): Fight[] {
  const byMatch = new Map<string, EditItem[]>();
  for (const it of items) byMatch.set(it.matchId, [...(byMatch.get(it.matchId) ?? []), it]);
  const out: Fight[] = [];
  for (const its of byMatch.values()) {
    const seen = new Map<string, GameEvent>();
    for (const it of its) for (const e of it.events) if (MOMENTS.has(e.kind) && !e.credited && e.t >= it.lo && e.t <= it.hi) seen.set(e.id, e);
    const evs = [...seen.values()].sort((a, b) => a.t - b.t);
    const groups: GameEvent[][] = [];
    for (const e of evs) {
      const g = groups[groups.length - 1];
      if (g && e.t - g[g.length - 1].t <= GAP) g.push(e);
      else groups.push([e]);
    }
    for (const g of groups) {
      const first = g[0].t;
      const last = g[g.length - 1].t;
      // the clip covering most of [first - LEAD, last + TAIL]
      const cover = (it: EditItem) => Math.min(it.hi, last + TAIL) - Math.max(it.lo, first - LEAD);
      const item = [...its].sort((a, b) => cover(b) - cover(a))[0];
      if (cover(item) <= 0) continue;
      const kills = g.filter((e) => e.kind === "kill");
      // only fights with a kill in them
      if (kills.length === 0) continue;
      out.push({ item, events: g, kills, first, last, score: g.reduce((n, e) => n + score(e), 0) + Math.max(0, kills.length - 1) * 4, win: false });
    }
  }
  return out;
}

const snapUp = (t: number, grid: number[]) => grid.find((g) => g >= t - 0.02) ?? t;
const snapNear = (t: number, grid: number[]) => grid.reduce((b, g) => (Math.abs(g - t) < Math.abs(b - t) ? g : b), grid[0] ?? t);

/** Lay the fights on the song: the one with the most kills has its first
 *  kill on the drop, the others in the order they happened, every fight's
 *  first kill on a beat, cuts on beats, the end on a bar. */
export function autoCut(items: EditItem[], song: MusicInfo, o: AutoOpts): AutoCut | null {
  const found = fights(items);
  if (found.length === 0 || song.beats.length < 8) return null;
  const beat = song.beat;
  const take = (f: Fight) => Math.min(f.item.hi, f.last + TAIL) - Math.max(f.item.lo, f.first - LEAD);
  const maxLen = o.length > 0 ? o.length : song.duration;
  // as many kills as fit: the fights with the most kills first, until the
  // video is full; then played in the order they happened
  const ranked = [...found].sort((a, b) => b.kills.length - a.kills.length || b.score - a.score);
  const all: Fight[] = [];
  let room = maxLen;
  for (const f of ranked) {
    const len = Math.min(take(f), Math.max(10, maxLen * 0.4));
    if (all.length > 0 && len > room + 1) continue;
    all.push(f);
    room -= len;
    if (room <= 1.5) break;
  }
  const best = all[0];
  const chrono = (a: Fight, b: Fight) => a.item.createdAtMs - b.item.createdAtMs || a.first - b.first;
  const before = all.filter((f) => f !== best && chrono(f, best) < 0).sort(chrono);
  const after = all.filter((f) => f !== best && chrono(f, best) > 0).sort(chrono);

  // how much comes before the drop: a few earlier fights, at most a third
  const pre: Fight[] = [];
  let preLen = 0;
  for (const f of [...before].reverse()) {
    if (preLen + take(f) > Math.min(song.drop, maxLen / 3)) break;
    pre.unshift(f);
    preLen += take(f);
  }
  // the earlier fights that didn't fit before the drop come after it
  after.unshift(...before.filter((f) => !pre.includes(f)));
  const bestKill = (best.kills[0] ?? best.events[0]).t;
  const bestLead = Math.min(LEAD, bestKill - best.item.lo);
  // the song starts on a bar, early enough for all that
  const want = song.drop - preLen - bestLead;
  const musicOffset = Math.max(0, song.downbeats.filter((d) => d <= want).pop() ?? 0);
  const length = Math.min(maxLen, song.duration - musicOffset);
  const beats = song.beats.map((b) => b - musicOffset).filter((b) => b >= -0.01 && b <= length + 0.01);
  const downs = song.downbeats.map((b) => b - musicOffset).filter((b) => b >= -0.01 && b <= length + 0.01);
  const drop = song.drop - musicOffset;

  const tl: TClip[] = [];
  let cursor = 0;
  const used = new Map<string, [number, number][]>();
  const free = (f: Fight, a: number, b: number): [number, number] => {
    // never the same footage twice
    for (const [x, y] of used.get(f.item.matchId) ?? []) {
      if (a < y && b > x) {
        if (a >= x) a = y;
        else b = Math.min(b, x);
      }
    }
    return [a, b];
  };
  const put = (f: Fight, start: number, end: number, trans: Trans) => {
    // never into the chicken dinner screen
    const win = f.item.events.find((e) => e.kind === "win" && e.t > f.last && e.t < end + 0.5);
    if (win) end = Math.min(end, win.t - 0.2);
    [start, end] = free(f, start, end);
    if (end - start < 0.8) return false;
    tl.push({ key: newKey(), item: f.item.key, start, end, trans });
    used.set(f.item.matchId, [...(used.get(f.item.matchId) ?? []), [start, end]]);
    cursor += end - start;
    return true;
  };
  /** where a fight's clip ends in the video: on the beat nearest its end,
   *  but never before its last kill has played out */
  const endOnBeat = (cur: number, start: number, end: number, f: Fight) => {
    const want = cur + (end - start);
    const minOut = cur + Math.min(end - start, f.last + 0.6 - start);
    const grid = beats.filter((b) => b > cur + 1);
    const near = snapNear(want, grid);
    return near >= minOut ? near : snapUp(minOut, grid);
  };
  const transFor = (f: Fight) => {
    const prev = tl[tl.length - 1];
    if (!prev) return "" as Trans;
    const prevItem = items.find((i) => i.key === prev.item);
    return prevItem && prevItem.matchId !== f.item.matchId ? o.trans : "";
  };

  // before the drop: the earlier fights, then the best one's lead-in so its
  // first kill lands on the drop
  pre.forEach((f, i) => {
    let start = Math.max(f.item.lo, f.first - LEAD);
    let end = Math.min(f.item.hi, f.last + TAIL);
    if (i === 0) start = Math.max(f.item.lo, end - (drop - bestLead - (preLen - take(f))));
    end = start + Math.max(0.8, endOnBeat(cursor, start, end, f) - cursor);
    put(f, start, Math.min(end, f.item.hi), transFor(f));
  });
  {
    const f = best;
    // starts where the song is, kill on the drop
    let start = bestKill - Math.max(0.5, drop - cursor);
    if (start < f.item.lo) start = f.item.lo;
    let end = Math.min(f.item.hi, f.last + TAIL, start + Math.max(10, length * 0.4));
    end = start + Math.max(0.8, endOnBeat(cursor, start, end, f) - cursor);
    put(f, start, Math.min(end, f.item.hi), transFor(f));
  }
  // after: each fight's first kill on the first beat at least LEAD in
  for (const f of after) {
    if (cursor >= length - 2 * beat) break;
    const k = (f.kills[0] ?? f.events[0]).t;
    const killOut = snapUp(cursor + LEAD, beats);
    let start = Math.max(f.item.lo, k - (killOut - cursor));
    let end = Math.min(f.item.hi, f.last + TAIL, start + Math.max(10, length * 0.3));
    end = start + Math.max(0.8, endOnBeat(cursor, start, end, f) - cursor);
    if (cursor + (end - start) > length) end = start + (length - cursor);
    put(f, start, Math.min(end, f.item.hi), transFor(f));
  }
  if (tl.length === 0) return null;
  // end on a bar when there's one close
  const total = cursor;
  const bar = downs.filter((d) => d <= total && total - d < 4 * beat).pop();
  if (bar && bar > 4) {
    let cut = total - bar;
    for (let i = tl.length - 1; i >= 0 && cut > 0; i--) {
      const c = tl[i];
      // not into a kill: the clip keeps its last kill and a moment after it
      const it = items.find((x) => x.key === c.item);
      const lastKill = it ? Math.max(c.start, ...it.events.filter((e) => e.kind === "kill" && e.t >= c.start && e.t <= c.end).map((e) => e.t + 0.6)) : c.start;
      const take = Math.max(0, Math.min(cut, c.end - Math.max(c.start + 0.8, lastKill)));
      c.end -= take;
      cut -= take;
    }
  }

  // the big fight later on: music out, back in on its last kill
  const pulls: [number, number][] = [];
  if (o.pull) {
    let at = 0;
    let pick: { a: number; b: number; n: number } | null = null;
    for (const c of tl) {
      const it = items.find((i) => i.key === c.item)!;
      const kills = it.events.filter((e) => e.kind === "kill" && !e.credited && e.t >= c.start && e.t <= c.end);
      const firstMoment = it.events.filter((e) => MOMENTS.has(e.kind) && e.kind !== "win" && e.t >= c.start && e.t <= c.end)[0];
      if (at > drop + 4 && kills.length >= 2 && firstMoment && (!pick || kills.length > pick.n)) {
        pick = { a: snapNear(at + (firstMoment.t - c.start) - beat, beats), b: snapNear(at + (kills[kills.length - 1].t - c.start), beats), n: kills.length };
      }
      at += c.end - c.start;
    }
    if (pick && pick.b - pick.a >= 2) pulls.push([pick.a, pick.b]);
  }
  return { timeline: tl, musicOffset, pulls };
}
