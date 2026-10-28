// 卡点成片: the clips in the edit cut to a song.
//
// What the montages people like have in common (measured on a few popular
// PUBG ones): a fast opening that cuts on the drum hits, then whole fights
// left uncut, the best one starting where the song kicks in, the music
// stepping back for the big fight and slamming back in, hard cuts almost
// everywhere and a transition only when the match changes.

import type { GameEvent } from "./api";
import type { EditItem } from "./edit";

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

export interface Song {
  path: string;
  name: string;
  info: MusicInfo;
}

/** hard cuts only, or which transition when the match changes */
export type TransStyle = "cut" | "whip" | "flash" | "black" | "mix";

export interface PlanOpts {
  /** seconds; 0 = the whole song */
  length: number;
  trans: TransStyle;
  /** music steps back for the big fight */
  pull: boolean;
}

export interface Shot {
  key: string;
  item: EditItem;
  /** match time */
  start: number;
  end: number;
  /** where it sits in the video */
  outStart: number;
  role: "hook" | "main";
  /** the moment put on a beat (match time), if any */
  sync: number | null;
  transIn: string;
  transOut: string;
}

export interface Plan {
  shots: Shot[];
  /** where in the song the video starts */
  musicStart: number;
  length: number;
  /** output time the song kicks in */
  drop: number;
  pulls: [number, number][];
  /** beats in output time, for drawing */
  beats: number[];
  downbeats: number[];
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

const KILLISH = new Set(["kill", "knock", "win", "objective", "manual"]);

function killScore(e: GameEvent): number {
  let s = e.kind === "kill" ? 3 : e.kind === "knock" ? 1.2 : e.kind === "win" ? 4 : e.kind === "objective" ? 2 : 0.8;
  if (e.headshot) s += 1.5;
  if ((e.distanceM ?? 0) >= 100) s += 1.5;
  if ((e.distanceM ?? 0) >= 250) s += 1.5;
  const d = e.detail ?? "";
  if (/双杀|三杀|四杀|五杀|团灭/.test(d)) s += 3;
  if (d.includes("抢")) s += 2;
  return s;
}

/** Each clip's fights: its moments grouped when they're under 8 s apart. */
export function fights(items: EditItem[]): Fight[] {
  const out: Fight[] = [];
  for (const it of items) {
    const evs = it.events.filter((e) => KILLISH.has(e.kind) && !e.credited && e.t >= it.lo && e.t <= it.hi).sort((a, b) => a.t - b.t);
    let cur: GameEvent[] = [];
    const flush = () => {
      if (cur.length === 0) return;
      const kills = cur.filter((e) => e.kind === "kill");
      const sc = cur.reduce((n, e) => n + killScore(e), 0) + Math.max(0, kills.length - 1) * 2;
      out.push({ item: it, events: cur, kills, first: cur[0].t, last: cur[cur.length - 1].t, score: sc, win: cur.some((e) => e.kind === "win") });
      cur = [];
    };
    for (const e of evs) {
      if (cur.length && e.t - cur[cur.length - 1].t > 8) flush();
      cur.push(e);
    }
    flush();
    // a clip with no moments in it still counts, quietly
    if (evs.length === 0) out.push({ item: it, events: [], kills: [], first: (it.start + it.end) / 2, last: (it.start + it.end) / 2, score: 0.3, win: false });
  }
  return out;
}

const snapUp = (t: number, grid: number[]) => grid.find((g) => g >= t - 0.02) ?? t;
const snapNear = (t: number, grid: number[]) => grid.reduce((b, g) => (Math.abs(g - t) < Math.abs(b - t) ? g : b), grid[0] ?? t);

let seq = 0;
const key = () => `s${(seq++).toString(36)}`;

/** The edit's clips arranged on the song. */
export function plan(items: EditItem[], song: MusicInfo, o: PlanOpts): Plan | null {
  if (items.length === 0 || song.beats.length < 8) return null;
  const beat = song.beat;
  const songLen = song.duration;
  const all = fights(items).sort((a, b) => b.score - a.score);
  if (all.length === 0) return null;
  const best = all[0];

  // where in the song: a short opening (8-16 beats) before the drop, the
  // song's own intro skipped; how long: as asked, or to the song's end
  const hookLen = Math.min(Math.max((o.length || 60) * 0.2, 8 * beat), 16 * beat);
  const want = song.drop - hookLen;
  let musicStart = song.downbeats.filter((d) => d <= want).pop() ?? song.downbeats[0] ?? 0;
  let length = o.length > 0 ? Math.min(o.length, songLen - musicStart) : songLen - musicStart;
  if (o.length > 0 && musicStart + o.length > songLen) {
    musicStart = Math.max(0, song.downbeats.filter((d) => d <= songLen - o.length).pop() ?? 0);
    length = Math.min(o.length, songLen - musicStart);
  }
  const beats = song.beats.map((b) => b - musicStart).filter((b) => b >= -0.001 && b <= length + 0.001);
  const downs = song.downbeats.map((b) => b - musicStart).filter((b) => b >= -0.001 && b <= length + 0.001);
  // end on a bar
  const lastDown = downs.filter((d) => d <= length).pop();
  if (lastDown && length - lastDown < 4 * beat) length = Math.max(lastDown, Math.min(length, 8));
  const drop = Math.max(0, song.drop - musicStart);

  const shots: Shot[] = [];
  // the best fight: its first kill on the drop, a few beats of lead-in before it
  const bestKill = (best.kills[0] ?? best.events[0])?.t ?? best.first;
  const leadBeats = Math.max(2, Math.ceil(2.5 / beat));
  let leadIn = leadBeats * beat;
  // not before the footage starts
  leadIn = Math.min(leadIn, Math.max(beat, Math.floor((bestKill - best.item.lo) / beat) * beat));
  const dropShotStart = Math.max(0, drop - leadIn);

  // which fights the main part has room for (roughly)
  const maxTake = Math.max(8, Math.min(20, length * 0.3));
  const take = (f: Fight) => Math.min(maxTake, f.last - f.first + 4.5);
  const rest = all.filter((f) => f !== best).sort((a, b) => (a.win !== b.win ? (a.win ? 1 : -1) : a.item.createdAtMs - b.item.createdAtMs || a.first - b.first));
  const inMain = new Set<Fight>([best]);
  let room = length - drop - take(best);
  for (const f of [...rest].sort((a, b) => b.score - a.score)) {
    if (room <= 2) break;
    inMain.add(f);
    room -= take(f);
  }

  // the opening: quick cuts on the beat, one kill each, before the drop shot;
  // from the fights that won't get their own take first, so little repeats
  const hookEnd = dropShotStart;
  const hookMoments: { item: EditItem; e: GameEvent; s: number }[] = [];
  for (const f of all) {
    f.events.forEach((e, i) => {
      if (e.kind === "win") return;
      // a fight that plays later keeps its opening kill for then
      if (inMain.has(f) && i === 0) return;
      hookMoments.push({ item: f.item, e, s: killScore(e) + (inMain.has(f) ? 0 : 3) });
    });
  }
  hookMoments.sort((a, b) => b.s - a.s);
  const hookBeats = beats.filter((b) => b < hookEnd - 0.05);
  // two beats a shot (one when the song is slow)
  const per = beat >= 0.55 ? 1 : 2;
  const slots = Math.floor(hookBeats.length / per);
  const used = new Set<string>();
  const picks: typeof hookMoments = [];
  for (const m of hookMoments) {
    if (picks.length >= slots) break;
    const id = `${m.item.key}:${Math.round(m.e.t)}`;
    if (used.has(id)) continue;
    used.add(id);
    picks.push(m);
  }
  if (picks.length > 0) {
    // the beats left over go to the first shot, so the video starts at 0
    const lens = picks.map(() => per);
    lens[0] += hookBeats.length - per * picks.length;
    let at = 0;
    picks.forEach((m, i) => {
      const n = lens[i];
      const dur = (i === picks.length - 1 ? hookEnd - at : n * beat);
      // the kill on the shot's last-but-one beat: a beat of aftermath
      const killAt = Math.max(0, dur - beat);
      let start = m.e.t - killAt;
      let end = start + dur;
      if (start < m.item.lo) {
        end += m.item.lo - start;
        start = m.item.lo;
      }
      if (end > m.item.hi) {
        start = Math.max(m.item.lo, start - (end - m.item.hi));
        end = m.item.hi;
      }
      shots.push({ key: key(), item: m.item, start, end, outStart: at, role: "hook", sync: m.e.t, transIn: "", transOut: "" });
      at += end - start;
    });
  } else if (hookEnd > 0.3) {
    // nothing to tease with: the drop shot just starts earlier
  }

  // the fights, whole: the best one on the drop, the rest in the order they
  // happened, a chicken dinner last
  const order = [best, ...rest.filter((f) => inMain.has(f))];
  let cursor = shots.length ? shots[shots.length - 1].outStart + (shots[shots.length - 1].end - shots[shots.length - 1].start) : 0;
  for (const f of order) {
    if (cursor >= length - beat) break;
    const k = (f.kills[0] ?? f.events[0])?.t ?? f.first;
    let start: number;
    let syncOut: number;
    if (f === best) {
      // lead-in grows to fill to the drop if the opening came up short
      start = k - (drop - cursor);
      syncOut = drop;
    } else {
      // the first kill on the first beat at least 2.5 s in
      const want = cursor + 2.5;
      syncOut = snapUp(want, beats);
      start = k - (syncOut - cursor);
    }
    if (start < f.item.lo) {
      // not enough lead-in: move the cut later instead
      const short = f.item.lo - start;
      start = f.item.lo;
      const p = shots[shots.length - 1];
      if (p) {
        // the shot before plays a little longer (as far as its footage goes)
        const grow = Math.min(short, p.item.hi - p.end);
        p.end += grow;
        cursor += grow;
      }
    }
    let end = Math.min(f.item.hi, Math.max(f.last + 2, k + 2), start + maxTake);
    // end on a beat
    const outEnd = snapNear(cursor + (end - start), beats.filter((b) => b > cursor + 1));
    end = Math.min(f.item.hi, start + (outEnd - cursor));
    if (cursor + (end - start) > length) end = start + (length - cursor);
    if (end - start < 0.6) continue;
    shots.push({ key: key(), item: f.item, start, end, outStart: cursor, role: "main", sync: k, transIn: "", transOut: "" });
    cursor += end - start;
  }
  if (shots.length === 0) return null;
  // shorter than the song section: end there
  length = Math.min(length, cursor);

  // transitions: only where the match changes in the main part
  const style = o.trans;
  for (let i = 1; i < shots.length; i++) {
    const a = shots[i - 1];
    const b = shots[i];
    let t = "";
    if (b.role === "main" && a.role === "hook") t = style === "cut" ? "" : "flash";
    else if (b.role === "main" && a.item.matchId !== b.item.matchId) {
      t = style === "mix" ? (i === shots.length - 1 ? "black" : "whip") : style === "cut" ? "" : style;
    }
    if (t === "black") {
      a.transOut = "black";
      b.transIn = "black";
    } else if (t === "whip") {
      a.transOut = "whip";
      b.transIn = "whip";
    } else if (t === "flash") {
      b.transIn = "flash";
    }
  }
  shots[shots.length - 1].transOut = "black";

  // the big fight later on: music out, back in on its last kill
  const pulls: [number, number][] = [];
  if (o.pull) {
    const cands = shots
      .filter((s) => s.role === "main" && s.outStart > drop + 4)
      .map((s) => {
        const evs = s.item.events.filter((e) => KILLISH.has(e.kind) && e.kind !== "win" && !e.credited && e.t >= s.start && e.t <= s.end);
        return { s, evs };
      })
      .filter((c) => c.evs.filter((e) => e.kind === "kill").length >= 2);
    const pick = cands.sort((a, b) => b.evs.length - a.evs.length)[0];
    if (pick) {
      const out = (t: number) => pick.s.outStart + (t - pick.s.start);
      const kills = pick.evs.filter((e) => e.kind === "kill");
      const a = snapNear(out(pick.evs[0].t) - beat, beats);
      const b = snapNear(out(kills[kills.length - 1].t), beats);
      if (b - a >= 2) pulls.push([a, b]);
    }
  }

  return { shots, musicStart, length, drop, pulls, beats, downbeats: downs };
}
