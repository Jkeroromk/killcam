import type { Dict, EventKind, GameId, Locale, LolNote } from "./i18n";
import type { FilmCard } from "./film";

// Made-up but realistic matches for the hero timeline, one per game.
// Times in seconds.

export type MatchEvent = {
  t: number;
  kind: EventKind;
  /** PUBG: weapon, distance in metres, headshot (what the PUBG API adds) */
  detail?: { weapon: string; m: number; hs?: boolean };
  /** League: what the event was (first blood, penta, baron steal…) */
  note?: LolNote;
};

export type DemoMatch = { length: number; events: MatchEvent[]; clips: Clip[] };

const mmss = (m: number, s: number) => m * 60 + s;

const PUBG_EVENTS: MatchEvent[] = [
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

// League: kills inside one fight become a single clip, the way the app merges
// a multikill. The note on the last kill of a streak says what it was.
const LOL_EVENTS: MatchEvent[] = [
  { t: mmss(3, 12), kind: "kill", note: "firstBlood" },
  { t: mmss(7, 30), kind: "objective", note: "dragon" },
  { t: mmss(9, 5), kind: "assist" },
  { t: mmss(11, 44), kind: "kill" },
  { t: mmss(11, 48), kind: "kill", note: "double" },
  { t: mmss(14, 20), kind: "eliminated" },
  { t: mmss(17, 5), kind: "manual" },
  { t: mmss(20, 15), kind: "objective", note: "baronSteal" },
  { t: mmss(22, 40), kind: "kill" },
  { t: mmss(22, 44), kind: "kill" },
  { t: mmss(22, 47), kind: "kill", note: "triple" },
  { t: mmss(22, 52), kind: "assist", note: "ace" },
  { t: mmss(25, 30), kind: "objective", note: "tower" },
  { t: mmss(28, 2), kind: "kill" },
  { t: mmss(28, 5), kind: "kill" },
  { t: mmss(28, 8), kind: "kill" },
  { t: mmss(28, 12), kind: "kill" },
  { t: mmss(28, 15), kind: "kill", note: "penta" },
  { t: mmss(29, 20), kind: "objective", note: "nexus" },
  { t: mmss(29, 24), kind: "win" },
];

// Seconds kept before and after each event (customisable per event in the app).
const PRE = 10;
const POST = 5;

export type Clip = { start: number; end: number; events: MatchEvent[] };

/** Events close together become one clip, the way the app merges them. */
export function clipsFor(events: MatchEvent[], length: number): Clip[] {
  const clips: Clip[] = [];
  for (const e of events) {
    const start = Math.max(0, e.t - PRE);
    const end = Math.min(length, e.t + POST);
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

function demo(length: number, events: MatchEvent[]): DemoMatch {
  return { length, events, clips: clipsFor(events, length) };
}

export const MATCHES: Record<GameId, DemoMatch> = {
  pubg: demo(mmss(22, 20), PUBG_EVENTS),
  lol: demo(mmss(29, 40), LOL_EVENTS),
};

export function timecode(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ---------- cards for the 3D hero ----------


/** games whose footage runs on the hero's film strip */
const FOOTAGE: GameId[] = ["pubg"];

/** The notable moments of every example match, taking turns between games. */
export function filmCards(d: Dict, locale: Locale): FilmCard[] {
  const per = (Object.keys(MATCHES) as GameId[]).map((game) => {
    const g = d.timeline.games[game];
    return MATCHES[game].events
      .filter((e) => e.note || (e.detail && (e.kind === "kill" || e.kind === "knock")) || e.kind === "win")
      .map((e): FilmCard & { weight: number } => {
        const title = e.kind === "win" ? g.win : e.note ? d.timeline.notes[e.note] : d.timeline.events[e.kind];
        let sub = timecode(e.t);
        if (e.detail) {
          const { weapon, m, hs } = e.detail;
          sub = [weapon, locale === "zh" ? `${m} 米` : `${m} m`, hs ? (locale === "zh" ? "爆头" : "headshot") : ""].filter(Boolean).join(" · ");
        }
        const tone: FilmCard["tone"] =
          e.kind === "win" ? "win" : e.kind === "objective" ? "objective" : e.note && e.note !== "firstBlood" ? "multi" : "kill";
        const weight = e.note === "penta" ? 0 : e.note === "baronSteal" || e.detail?.hs ? 1 : e.kind === "win" ? 4 : e.kind === "knock" ? 3 : 2;
        return { title, sub, game: g.name, tone, footage: FOOTAGE.includes(game), weight };
      })
      // the most impressive moments come first
      .sort((a, b) => a.weight - b.weight)
      .map(({ weight: _w, ...card }) => card);
  });
  const out: FilmCard[] = [];
  for (let i = 0; out.length < per.reduce((a, l) => a + l.length, 0); i++) {
    for (const list of per) if (list[i]) out.push(list[i]);
  }
  return out;
}
