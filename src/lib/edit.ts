// The 剪辑 (edit) page's clip list: highlights picked from any matches, kept
// in the app's config folder so it survives restarts. Each clip carries what
// the page needs to show and preview it without loading its match again.

import { api, highlightBounds, joinPath, type EditCaption, type EditClipReq, type EditOptions, type EventKind, type GameEvent, type Highlight, type MatchRecord } from "./api";
import { eventLine } from "./format";
import { t } from "./i18n";

export type SlowMode = "off" | "big" | "all";

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

export interface EditDoc {
  items: EditItem[];
  opts: EditOptions;
  captions: boolean;
  slow: SlowMode;
}

export const DEFAULT_DOC: EditDoc = {
  items: [],
  opts: { aspect: "source", height: 1080, sizeMb: 0, fps120: false },
  captions: true,
  slow: "off",
};

/** how far a clip can be stretched past where it was cut, in a full recording */
const MARGIN_S = 30;
// keep in step with src-tauri/src/edit.rs
export const SLOW = 0.5;
const SLOW_BEFORE = 1.0;
const SLOW_AFTER = 0.6;
export const CAPTION_S = 3.0;

export async function loadEdit(): Promise<EditDoc> {
  try {
    const raw = JSON.parse(await api.editGet());
    // the first versions stored only the list
    if (Array.isArray(raw)) return { ...DEFAULT_DOC, items: raw };
    return {
      ...DEFAULT_DOC,
      ...raw,
      opts: { ...DEFAULT_DOC.opts, ...(raw?.opts ?? {}) },
      items: Array.isArray(raw?.items) ? raw.items : [],
    };
  } catch {
    return { ...DEFAULT_DOC };
  }
}

export async function saveEdit(doc: EditDoc): Promise<void> {
  await api.editSet(JSON.stringify(doc));
  window.dispatchEvent(new CustomEvent("kc-edit", { detail: doc.items.length }));
}

let seq = 0;
const newKey = () => `${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** A highlight (or a custom range of a full recording) as an edit clip. */
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

/** Add clips to the end of the edit, skipping ones already in it. */
export async function addToEdit(items: EditItem[]): Promise<{ added: number; total: number }> {
  const doc = await loadEdit();
  const same = (a: EditItem, b: EditItem) => a.matchId === b.matchId && Math.abs(a.start - b.start) < 0.5 && Math.abs(a.end - b.end) < 0.5;
  const fresh = items.filter((x) => !doc.items.some((y) => same(x, y)));
  if (fresh.length > 0) {
    doc.items = [...doc.items, ...fresh];
    await saveEdit(doc);
  }
  return { added: fresh.length, total: doc.items.length };
}

const inClip = (it: EditItem, e: GameEvent) => e.t >= it.start && e.t <= it.end;

/** Moments that get a caption: your knocks and kills (League: kills, objectives). */
export function captionEvents(it: EditItem): GameEvent[] {
  return it.events.filter((e) => inClip(it, e) && !e.credited && (e.kind === "kill" || e.kind === "knock" || (it.game === "lol" && e.kind === "objective")));
}

export function captionText(e: GameEvent): string {
  const head = e.kind === "kill" ? t("击杀", "Kill") : e.kind === "knock" ? t("击倒", "Knock") : "";
  const line = eventLine(e);
  return head ? (line ? `${head}  ${line.replace(/，/g, " · ").replace(/, /g, " · ")}` : head) : line;
}

const MULTI = /双杀|三杀|四杀|五杀|团灭/;

/** Is this one worth slowing down: headshots and long shots, multikills and steals. */
function big(e: GameEvent): boolean {
  if (e.headshot) return true;
  if ((e.distanceM ?? 0) >= 100) return true;
  const d = e.detail ?? "";
  return MULTI.test(d) || d.includes("抢");
}

export function slowEvents(it: EditItem, mode: SlowMode): GameEvent[] {
  if (mode === "off") return [];
  return it.events.filter((e) => inClip(it, e) && !e.credited && (e.kind === "kill" || (e.kind === "objective" && (e.detail ?? "").includes("抢"))) && (mode === "all" || big(e)));
}

/** The clip's pieces in seconds into it: [from, to, slowed]. Same as the export. */
export function segments(dur: number, slow: number[]): [number, number, boolean][] {
  const wins = slow
    .map((t): [number, number] => [Math.max(0, t - SLOW_BEFORE), Math.min(dur, t + SLOW_AFTER)])
    .filter(([a, b]) => b - a > 0.2)
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const w of wins) {
    const l = merged[merged.length - 1];
    if (l && w[0] <= l[1] + 0.3) l[1] = Math.max(l[1], w[1]);
    else merged.push([w[0], w[1]]);
  }
  const out: [number, number, boolean][] = [];
  let at = 0;
  for (const [a, b] of merged) {
    if (a - at > 0.05) out.push([at, a, false]);
    out.push([a, b, true]);
    at = b;
  }
  if (dur - at > 0.05 || out.length === 0) out.push([at, dur, false]);
  return out;
}

export function slowTimes(it: EditItem, mode: SlowMode): number[] {
  return slowEvents(it, mode).map((e) => e.t);
}

/** Length of a clip in the finished video. */
export function outLen(it: EditItem, mode: SlowMode): number {
  const dur = it.end - it.start;
  return segments(
    dur,
    slowTimes(it, mode).map((x) => x - it.start),
  ).reduce((n, [a, b, s]) => n + (s ? (b - a) / SLOW : b - a), 0);
}

/** The export request for a clip. */
export function request(it: EditItem, doc: EditDoc): EditClipReq {
  const captions: EditCaption[] = doc.captions ? captionEvents(it).map((e) => ({ t: e.t, text: captionText(e) })) : [];
  return { matchId: it.matchId, start: it.start, end: it.end, captions, slow: slowTimes(it, doc.slow) };
}
