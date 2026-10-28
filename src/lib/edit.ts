// The 剪辑 (edit) page's project: the clips picked from any matches (the
// media bin), the timeline made of them, and the song under it. Kept in the
// app's config folder so it survives restarts. Each clip carries what the
// page needs to show and play it without loading its match again.

import { api, highlightBounds, joinPath, type EditClipReq, type EditOptions, type EventKind, type GameEvent, type Highlight, type MatchRecord, type MusicMix } from "./api";
import type { MusicInfo } from "./beatcut";
import { t } from "./i18n";

export interface EditItem {
  key: string;
  matchId: string;
  game: string;
  mapLabel: string;
  createdAtMs: number;
  title: string;
  kinds: EventKind[];
  /** still image, absolute path */
  thumb: string | null;
  /** the video the clip is in, absolute path, and the match time of its first frame */
  file: string;
  fileStart: number;
  /** match time */
  start: number;
  end: number;
  /** how far start / end can be moved */
  lo: number;
  hi: number;
  /** the match's moments around the clip */
  events: GameEvent[];
}

export type Trans = "" | "flash" | "black";

/** A piece of a bin clip on the timeline. */
export interface TClip {
  key: string;
  item: string;
  /** match time */
  start: number;
  end: number;
  /** how it comes in from the clip before */
  trans: Trans;
}

export interface Song {
  path: string;
  name: string;
  info: MusicInfo;
}

export interface EditDoc {
  /** the media bin */
  items: EditItem[];
  timeline: TClip[];
  opts: EditOptions;
  song: Song | null;
  /** where in the song the video starts (s) */
  musicOffset: number;
  musicVol: number;
  gameVol: number;
  /** stretches (video time) where the music steps back to the game sound */
  pulls: [number, number][];
  /** edges stick to the beat */
  snap: boolean;
  /** auto cut: target length (0 = the song), transition between matches, pull the music for the big fight */
  auto: { length: number; trans: Trans; pull: boolean };
}

export const DEFAULT_DOC: EditDoc = {
  items: [],
  timeline: [],
  opts: { aspect: "source", height: 1080, sizeMb: 0, fps120: false },
  song: null,
  musicOffset: 0,
  musicVol: 0.9,
  gameVol: 0.45,
  pulls: [],
  snap: true,
  auto: { length: 60, trans: "", pull: true },
};

/** how far a clip can be stretched past where it was cut, in a full recording */
const MARGIN_S = 30;

let seq = 0;
export const newKey = () => `${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const tclip = (it: EditItem): TClip => ({ key: newKey(), item: it.key, start: it.start, end: it.end, trans: "" });

/** A bin clip as the next timeline clip after `prev`: when both are the same
 *  match and overlap, it starts where `prev` ends, so nothing plays twice. */
export function tclipAfter(it: EditItem, prev: TClip | undefined, items: EditItem[]): TClip {
  const c = tclip(it);
  const p = prev ? items.find((i) => i.key === prev.item) : undefined;
  if (p && p.matchId === it.matchId && c.start < prev!.end && c.end > prev!.start && c.end - prev!.end >= 0.8) c.start = prev!.end;
  return c;
}

/** Timeline clips that show footage another clip also shows. */
export function repeats(tl: TClip[], items: EditItem[]): Set<string> {
  const m = new Map(items.map((i) => [i.key, i.matchId]));
  const out = new Set<string>();
  for (let i = 0; i < tl.length; i++)
    for (let j = i + 1; j < tl.length; j++) {
      const a = tl[i];
      const b = tl[j];
      if (m.get(a.item) === m.get(b.item) && Math.min(a.end, b.end) - Math.max(a.start, b.start) > 0.3) {
        out.add(a.key);
        out.add(b.key);
      }
    }
  return out;
}

export async function loadEdit(): Promise<EditDoc> {
  try {
    const raw = JSON.parse(await api.editGet());
    // the first versions stored only the list
    const items: EditItem[] = Array.isArray(raw) ? raw : Array.isArray(raw?.items) ? raw.items : [];
    const doc: EditDoc = Array.isArray(raw)
      ? { ...DEFAULT_DOC, items }
      : {
          ...DEFAULT_DOC,
          ...raw,
          items,
          opts: { ...DEFAULT_DOC.opts, ...(raw?.opts ?? {}) },
          auto: { ...DEFAULT_DOC.auto, ...(raw?.auto ?? {}) },
          pulls: Array.isArray(raw?.pulls) ? raw.pulls : [],
        };
    const keys = new Set(items.map((i) => i.key));
    // before the timeline existed the bin was the video, in order
    if (!Array.isArray(raw?.timeline)) doc.timeline = items.map(tclip);
    doc.timeline = doc.timeline.filter((c) => keys.has(c.item));
    return doc;
  } catch {
    return { ...DEFAULT_DOC };
  }
}

export async function saveEdit(doc: EditDoc): Promise<void> {
  await api.editSet(JSON.stringify(doc));
  window.dispatchEvent(new CustomEvent("kc-edit", { detail: doc.items.length }));
}

/** A highlight (or a custom range of a full recording) as a bin clip. */
export function itemFrom(m: MatchRecord, h: Highlight | { start: number; end: number; title: string }): EditItem {
  const hl = "id" in h ? h : null;
  let file: string;
  let fileStart = 0;
  let lo: number;
  let hi: number;
  if (m.video) {
    file = joinPath(m.dir, m.video);
    lo = Math.max(0, h.start - MARGIN_S);
    hi = Math.min(m.durationS || h.end + MARGIN_S, h.end + MARGIN_S);
  } else {
    const clip = hl ?? m.highlights.find((x) => x.file && h.start >= x.start - 0.5 && h.end <= x.end + 0.5);
    if (!clip?.file) throw new Error(t("这段没有可用的录像", "No usable recording for this part"));
    file = joinPath(m.dir, clip.file);
    fileStart = clip.fileStart ?? clip.start;
    [lo, hi] = highlightBounds(m, clip);
  }
  const thumbName = hl?.thumb ?? m.thumbnail;
  return {
    key: newKey(),
    matchId: m.id,
    game: m.game ?? "pubg",
    mapLabel: m.mapLabel,
    createdAtMs: m.createdAtMs,
    title: h.title,
    kinds: hl?.kinds ?? [],
    thumb: thumbName ? joinPath(m.thumbDir, thumbName) : null,
    file,
    fileStart,
    start: h.start,
    end: h.end,
    lo,
    hi,
    events: m.events.filter((e) => e.t >= lo - 1 && e.t <= hi + 1),
  };
}

/** Add clips to the bin and the end of the timeline, skipping ones already in. */
export async function addToEdit(items: EditItem[]): Promise<{ added: number; total: number }> {
  const doc = await loadEdit();
  const same = (a: EditItem, b: EditItem) => a.matchId === b.matchId && Math.abs(a.start - b.start) < 0.5 && Math.abs(a.end - b.end) < 0.5;
  const fresh = items.filter((x) => !doc.items.some((y) => same(x, y)));
  if (fresh.length > 0) {
    doc.items = [...doc.items, ...fresh];
    const all = [...doc.items];
    for (const it of fresh) doc.timeline = [...doc.timeline, tclipAfter(it, doc.timeline[doc.timeline.length - 1], all)];
    await saveEdit(doc);
  }
  return { added: fresh.length, total: doc.items.length };
}

/** Where each timeline clip sits in the video. */
export function layout(tl: TClip[]): { c: TClip; at: number; len: number }[] {
  let at = 0;
  return tl.map((c) => {
    const len = Math.max(0, c.end - c.start);
    const r = { c, at, len };
    at += len;
    return r;
  });
}

export const totalLen = (tl: TClip[]) => tl.reduce((n, c) => n + Math.max(0, c.end - c.start), 0);

/** The export request: the timeline's clips with their cuts, and the song. */
export function requests(doc: EditDoc): { clips: EditClipReq[]; music: MusicMix | null } {
  const byKey = new Map(doc.items.map((i) => [i.key, i]));
  const tl = doc.timeline.filter((c) => byKey.has(c.item));
  const clips = tl.map((c, i) => {
    const next = tl[i + 1];
    const out = next?.trans === "black" ? "black" : i === tl.length - 1 && doc.song ? "black" : "";
    return { matchId: byKey.get(c.item)!.matchId, start: c.start, end: c.end, captions: [], slow: [], transIn: i === 0 ? "" : c.trans, transOut: out };
  });
  const music = doc.song ? { path: doc.song.path, start: doc.musicOffset, volume: doc.musicVol, game: doc.gameVol, pulls: doc.pulls } : null;
  return { clips, music };
}

const MOMENT_KINDS = new Set(["kill", "knock", "win", "objective", "manual"]);

/** Cut the waiting out: each clip down to its moments (a little before the
 *  first, a little after the last), split where moments are far apart.
 *  Clips with no moments stay as they are. */
export function tighten(tl: TClip[], items: EditItem[], lead = 2.2, tail = 1.5, gap = 4.5): TClip[] {
  const byKey = new Map(items.map((i) => [i.key, i]));
  const out: TClip[] = [];
  for (const c of tl) {
    const it = byKey.get(c.item);
    const ms = it ? it.events.filter((e) => MOMENT_KINDS.has(e.kind) && !e.credited && e.t >= c.start && e.t <= c.end).map((e) => e.t).sort((a, b) => a - b) : [];
    if (!it || ms.length === 0) {
      out.push(c);
      continue;
    }
    const groups: number[][] = [];
    for (const t of ms) {
      const g = groups[groups.length - 1];
      if (g && t - g[g.length - 1] <= gap) g.push(t);
      else groups.push([t]);
    }
    groups.forEach((g, i) => {
      const start = Math.max(c.start, g[0] - lead);
      const end = Math.min(c.end, g[g.length - 1] + tail);
      if (end - start < 0.5) return;
      out.push({ key: i === 0 ? c.key : newKey(), item: c.item, start, end, trans: i === 0 ? c.trans : "" });
    });
  }
  return out;
}
