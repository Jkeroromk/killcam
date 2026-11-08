// The example cut for the 一键卡点 demo: a 128 BPM song and fights from four
// matches, laid out the way the app's planner (src/lib/beatcut.ts) does it:
// a few earlier fights before the drop in the order they happened, the fight
// with the most kills landing its first kill on the drop, the rest in order
// after it, every fight whole, cuts on beats, a transition only where the
// match changes, the music stepping back for the big late fight and slamming
// back in on its last kill, and the end on a bar line. Times are seconds in
// the output video.

export const BPM = 128;
export const BEAT = 60 / BPM; // 0.46875 s
export const BAR = BEAT * 4; // 1.875 s

export type MatchKey = "a" | "b" | "c" | "d";
export type Trans = "flash" | "black";
export type TransStyle = "cut" | Trans;
export type Phase = "hook" | "drop" | "fight" | "pull" | "slam" | "win";

/** what the shot shows: a weapon and distance */
export type ShotWhat = { weapon: string; m: number; hs?: boolean; n?: number } | { win: true };

export type DemoShot = {
  match: MatchKey;
  start: number;
  end: number;
  /** kills and knocks in the shot, each on a beat */
  kills: number[];
  phase: Phase;
  what: ShotWhat;
};

export type DemoCut = {
  length: number;
  drop: number;
  /** where the part before the drop ends (the drop) */
  hookEnd: number;
  /** music ducked under the gunfire, then slams back in at the end */
  pull: [number, number] | null;
  shots: DemoShot[];
};

/** which map each example match was on */
export const MATCH_MAP: Record<MatchKey, "erangel" | "miramar" | "vikendi" | "taego"> = {
  a: "erangel",
  b: "miramar",
  c: "vikendi",
  d: "taego",
};

const b = (n: number) => +(n * BEAT).toFixed(4);

function cut60(): DemoCut {
  const drop = b(16); // 7.5 s, bar 5
  const shots: DemoShot[] = [
    // before the drop: two earlier fights, in the order they happened
    { match: "b", start: 0, end: b(8), kills: [b(3), b(6)], phase: "hook", what: { weapon: "Kar98k", m: 250, hs: true } },
    // the second one runs right up to the drop
    { match: "c", start: b(8), end: drop, kills: [b(12)], phase: "hook", what: { weapon: "SKS", m: 48, hs: true } },
    // the fight with the most kills: its first kill on the drop
    { match: "a", start: drop, end: b(44), kills: [drop, b(22), b(30), b(38)], phase: "drop", what: { weapon: "Beryl M762", m: 47, n: 4 } },
    { match: "a", start: b(44), end: b(60), kills: [b(50), b(56)], phase: "fight", what: { weapon: "M24", m: 281 } },
    { match: "c", start: b(60), end: b(80), kills: [b(66), b(74)], phase: "fight", what: { weapon: "Mini14", m: 156, hs: true } },
    // the big late fight: the music steps back to the gunfire and slams back
    // in on its last kill
    { match: "d", start: b(80), end: b(116), kills: [b(88), b(96), b(104)], phase: "pull", what: { weapon: "Beryl M762", m: 25, n: 3 } },
    { match: "b", start: b(116), end: b(128), kills: [b(120)], phase: "win", what: { weapon: "M416", m: 3, hs: true } },
  ];
  return { length: b(128), drop, hookEnd: drop, pull: [b(86), b(104)], shots };
}

function cut30(): DemoCut {
  const drop = b(12); // 5.6 s
  const shots: DemoShot[] = [
    { match: "b", start: 0, end: drop, kills: [b(4), b(8)], phase: "hook", what: { weapon: "Kar98k", m: 250, hs: true } },
    { match: "a", start: drop, end: b(36), kills: [drop, b(18), b(24), b(30)], phase: "drop", what: { weapon: "Beryl M762", m: 47, n: 4 } },
    { match: "d", start: b(36), end: b(52), kills: [b(40), b(46)], phase: "fight", what: { weapon: "M24", m: 198, hs: true } },
    { match: "c", start: b(52), end: b(64), kills: [b(56)], phase: "win", what: { weapon: "SKS", m: 48, hs: true } },
  ];
  return { length: b(64), drop, hookEnd: drop, pull: null, shots };
}

export const CUTS: Record<30 | 60, DemoCut> = { 30: cut30(), 60: cut60() };

/** the transition between two shots, or null for a hard cut: only where the
 *  match changes, and never into the fight on the drop */
export function transitionAt(prev: DemoShot, next: DemoShot, style: TransStyle): Trans | null {
  if (style === "cut" || prev.match === next.match || next.phase === "drop") return null;
  return style;
}

/** The song's loudness over the cut, 0..1, one value per beat: a lift into
 *  the drop, loud after it, a breath in the middle, ducked under the pull,
 *  faded out at the end. Deterministic so the server and client agree. */
export function energy(cut: DemoCut): number[] {
  const n = Math.round(cut.length / BEAT);
  const out: number[] = [];
  let seed = 7;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < n; i++) {
    const t = i * BEAT;
    let e: number;
    if (t < cut.drop) e = 0.34 + 0.3 * (t / cut.drop);
    else e = 0.82;
    const mid = cut.length * 0.42;
    if (t > mid && t < mid + BAR * 3) e -= 0.16;
    if (t > cut.length - BAR * 2) e *= Math.max(0.25, (cut.length - t) / (BAR * 2));
    if (i % 4 === 0) e += 0.1;
    e += (rnd() - 0.5) * 0.14;
    out.push(Math.max(0.08, Math.min(1, e)));
  }
  return out;
}

export function clock(s: number): string {
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, "0")}`;
}
