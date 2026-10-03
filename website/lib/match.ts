import type { EventKind } from "./i18n";

// A made-up but realistic match for the hero timeline. Times in seconds.
export const MATCH_LENGTH = 22 * 60 + 20;

export type MatchEvent = {
  t: number;
  kind: EventKind;
  /** weapon, distance in metres, headshot: what the PUBG API adds */
  detail?: { weapon: string; m: number; hs?: boolean };
};

const mmss = (m: number, s: number) => m * 60 + s;

export const EVENTS: MatchEvent[] = [
  { t: mmss(4, 5), kind: "knock", detail: { weapon: "Beryl M762", m: 34 } },
  { t: mmss(4, 12), kind: "kill", detail: { weapon: "Beryl M762", m: 34 } },
  { t: mmss(6, 9), kind: "manual" },
  { t: mmss(7, 52), kind: "kill", detail: { weapon: "M416", m: 128, hs: true } },
  { t: mmss(9, 44), kind: "knock", detail: { weapon: "P90", m: 12 } },
  { t: mmss(9, 51), kind: "kill", detail: { weapon: "P90", m: 12 } },
  { t: mmss(10, 2), kind: "kill", detail: { weapon: "P90", m: 18 } },
  { t: mmss(11, 56), kind: "knock", detail: { weapon: "Kar98k", m: 210 } },
  { t: mmss(13, 47), kind: "kill", detail: { weapon: "Kar98k", m: 230, hs: true } },
  { t: mmss(15, 43), kind: "kill", detail: { weapon: "M416", m: 61 } },
  { t: mmss(18, 37), kind: "knock", detail: { weapon: "M416", m: 44 } },
  { t: mmss(18, 40), kind: "kill", detail: { weapon: "M416", m: 44 } },
  { t: mmss(20, 55), kind: "knocked" },
  { t: mmss(21, 41), kind: "win" },
];

// Seconds kept before and after each event (customisable per event in the app).
const PRE = 10;
const POST = 5;

export type Clip = { start: number; end: number; events: MatchEvent[] };

/** Events close together become one clip, the way the app merges them. */
export function clipsFor(events: MatchEvent[]): Clip[] {
  const clips: Clip[] = [];
  for (const e of events) {
    const start = Math.max(0, e.t - PRE);
    const end = Math.min(MATCH_LENGTH, e.t + POST);
    const last = clips[clips.length - 1];
    if (last && start <= last.end) {
      last.end = Math.max(last.end, end);
      last.events.push(e);
    } else {
      clips.push({ start, end, events: [e] });
    }
  }
  return clips;
}

export const CLIPS = clipsFor(EVENTS);

export function timecode(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
