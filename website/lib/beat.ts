// The example cut for the 卡点成片 demo: a 128 BPM song and highlights from
// four matches, laid out the way the app's planner (src/lib/beatcut.ts) does
// it: a quick-cut opening on the beat, the best fight starting on the drop,
// whole fights after that, a transition only where the match changes, the
// music stepping back for the big late fight and slamming back in on its last
// kill, and the end on a bar line. All times are seconds in the output video.

export const BPM = 128;
export const BEAT = 60 / BPM; // 0.46875 s
export const BAR = BEAT * 4; // 1.875 s

export type MatchKey = "a" | "b" | "c" | "d";
export type Trans = "whip" | "flash" | "black";
export type TransStyle = "mix" | "cut" | Trans;
export type Phase = "hook" | "drop" | "fight" | "pull" | "slam" | "win";

/** what the shot shows: a weapon and distance, or the chicken dinner */
export type ShotWhat = { weapon: string; m: number; hs?: boolean; n?: number } | { win: true };

export type DemoShot = {
  match: MatchKey;
  start: number;
  end: number;
  /** kills in the shot, each on a beat */
  kills: number[];
  phase: Phase;
  what: ShotWhat;
};

export type DemoCut = {
  length: number;
  drop: number;
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

// the opening: the hardest single moments, two beats each, the kill on the
// second beat of each shot
function hook(n: number, from: number): DemoShot[] {
  const picks: { match: MatchKey; what: ShotWhat }[] = [
    { match: "b", what: { weapon: "Kar98k", m: 250, hs: true } },
    { match: "d", what: { weapon: "Beryl M762", m: 18, hs: true } },
    { match: "a", what: { weapon: "M24", m: 162, hs: true } },
    { match: "c", what: { weapon: "SKS", m: 48, hs: true } },
    { match: "d", what: { weapon: "Kar98k", m: 156, hs: true } },
    { match: "b", what: { weapon: "M416", m: 3, hs: true } },
    { match: "a", what: { weapon: "AUG", m: 11 } },
    { match: "c", what: { weapon: "Mini14", m: 233, hs: true } },
  ];
  return picks.slice(0, n).map((p, i) => ({
    ...p,
    start: from + b(i * 2),
    end: from + b(i * 2 + 2),
    kills: [from + b(i * 2 + 1)],
    phase: "hook" as const,
  }));
}

function cut60(): DemoCut {
  const drop = b(16); // 7.5 s, bar 5
  const shots: DemoShot[] = [
    ...hook(8, 0),
    // the best fight lands on the drop: three kills, the first on the downbeat
    { match: "a", start: drop, end: b(42), kills: [drop, b(24), b(32)], phase: "drop", what: { weapon: "Beryl M762", m: 47, n: 3 } },
    { match: "b", start: b(42), end: b(60), kills: [b(48), b(56)], phase: "fight", what: { weapon: "Kar98k", m: 250, hs: true } },
    { match: "c", start: b(60), end: b(80), kills: [b(68), b(76)], phase: "fight", what: { weapon: "M24", m: 281 } },
    // the big late fight: the music steps back to the gunfire and slams back
    // in on its last kill
    { match: "d", start: b(80), end: b(112), kills: [b(88), b(94), b(100)], phase: "pull", what: { weapon: "Beryl M762", m: 25, n: 3 } },
    { match: "a", start: b(112), end: b(128), kills: [b(116), b(124)], phase: "win", what: { win: true } },
  ];
  return { length: b(128), drop, hookEnd: drop, pull: [b(82), b(100)], shots };
}

function cut30(): DemoCut {
  const drop = b(8); // 3.75 s
  const shots: DemoShot[] = [
    ...hook(4, 0),
    { match: "a", start: drop, end: b(32), kills: [drop, b(16), b(24)], phase: "drop", what: { weapon: "Beryl M762", m: 47, n: 3 } },
    { match: "b", start: b(32), end: b(48), kills: [b(36), b(44)], phase: "fight", what: { weapon: "Kar98k", m: 250, hs: true } },
    { match: "a", start: b(48), end: b(64), kills: [b(52), b(60)], phase: "win", what: { win: true } },
  ];
  return { length: b(64), drop, hookEnd: drop, pull: null, shots };
}

export const CUTS: Record<30 | 60, DemoCut> = { 30: cut30(), 60: cut60() };

/** the transition between two shots, or null for a hard cut */
export function transitionAt(prev: DemoShot, next: DemoShot, style: TransStyle, index: number): Trans | null {
  // transitions only when the match changes, never inside the quick-cut opening
  if (prev.match === next.match || next.phase === "hook" || prev.phase === "hook" || style === "cut") return null;
  if (style !== "mix") return style;
  const order: Trans[] = ["whip", "flash", "black"];
  return order[index % order.length];
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
    // the middle eases off a little, then builds back
    const mid = cut.length * 0.42;
    if (t > mid && t < mid + BAR * 3) e -= 0.16;
    if (t > cut.length - BAR * 2) e *= Math.max(0.25, (cut.length - t) / (BAR * 2));
    // the downbeat hits harder
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
