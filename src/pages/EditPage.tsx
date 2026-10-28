// The 剪辑 page, laid out like a video editor: the media bin on the left, the
// monitor in the middle, the inspector on the right and a timeline with a
// video track and a music track underneath.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Clapperboard, Download, Magnet, Minus, Music, Pause, Play, Plus, Redo2, Scissors, Trash2, Undo2, Wand2, X } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, errText, fileUrl, on, type EditOptions, type EditProgress } from "../lib/api";
import { clock, when } from "../lib/format";
import { label, plural, t, title } from "../lib/i18n";
import { addToEdit, itemFrom, layout, loadEdit, newKey, repeats, requests, saveEdit, tclipAfter, totalLen, type EditDoc, type EditItem, type TClip, type Trans } from "../lib/edit";
import { autoCut } from "../lib/beatcut";
import { Button, KindIcon, Range, Segmented, Spinner, Toggle } from "../components/ui";

type Snap = Pick<EditDoc, "timeline" | "musicOffset" | "pulls" | "items">;
type Laid = { c: TClip; at: number; len: number };
type PtrEv = { clientX: number; pointerId: number; preventDefault: () => void; stopPropagation: () => void; target: EventTarget; currentTarget: EventTarget };
type DragEv = { dataTransfer: DataTransfer; preventDefault: () => void; clientX: number; currentTarget: EventTarget };

/** 1:02.3 */
function tc(s: number): string {
  const m = Math.floor(Math.max(0, s) / 60);
  const r = Math.max(0, s) - m * 60;
  return `${m}:${r.toFixed(1).padStart(4, "0")}`;
}

export default function EditPage(props: { openLibrary: () => void; openMatch: (id: string) => void }) {
  const [doc, setDoc] = useState<EditDoc | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [tab, setTab] = useState<"clip" | "music" | "export">("music");
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const [T, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [progress, setProgress] = useState<EditProgress | null>(null);
  const [exported, setExported] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyMsg, setBusyMsg] = useState<string | null>(null);
  const [fps, setFps] = useState<Record<string, number>>({});
  const [, bump] = useState(0);
  const undo = useRef<Snap[]>([]);
  const redo = useRef<Snap[]>([]);
  const video = useRef<HTMLVideoElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const pending = useRef<{ local: number; play: boolean } | null>(null);
  const docRef = useRef<EditDoc | null>(null);
  docRef.current = doc;

  useEffect(() => {
    loadEdit().then((d) => {
      setDoc(d);
      if (d.items.length) {
        api
          .listMatches()
          .then((list) => {
            const ids = new Set(list.map((m) => m.id));
            setMissing(new Set(d.items.filter((i) => !ids.has(i.matchId)).map((i) => i.matchId)));
          })
          .catch(() => {});
      }
    });
  }, []);

  const items = doc?.items ?? [];
  const byKey = useMemo(() => new Map(items.map((i) => [i.key, i])), [items]);
  const tl = useMemo(() => (doc?.timeline ?? []).filter((c) => byKey.has(c.item)), [doc?.timeline, byKey]);
  const lay = useMemo(() => layout(tl), [tl]);
  const total = totalLen(tl);
  const song = doc?.song ?? null;

  // frame rates of the files on the timeline
  const fileKey = [...new Set(tl.map((c) => byKey.get(c.item)!.file))].sort().join("|");
  useEffect(() => {
    const files = fileKey ? fileKey.split("|").filter((f) => fps[f] == null) : [];
    if (files.length === 0) return;
    api
      .videoFps(files)
      .then((r) => setFps((cur) => ({ ...cur, ...Object.fromEntries(files.map((f, i) => [f, r[i]])) })))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileKey]);

  // ---- changing the project ----------------------------------------------

  const update = (d: EditDoc, persist = true) => {
    setDoc(d);
    docRef.current = d;
    setExported(null);
    if (persist) saveEdit(d).catch((e) => setErr(errText(e)));
  };
  const snapOf = (d: EditDoc): Snap => ({ timeline: d.timeline, musicOffset: d.musicOffset, pulls: d.pulls, items: d.items });
  const remember = () => {
    const d = docRef.current;
    if (!d) return;
    undo.current.push(snapOf(d));
    if (undo.current.length > 80) undo.current.shift();
    redo.current = [];
  };
  /** a change the undo button can take back */
  const edit = (patch: Partial<EditDoc>, persist = true) => {
    const d = docRef.current;
    if (!d) return;
    remember();
    update({ ...d, ...patch }, persist);
  };
  const back = (from: typeof undo, to: typeof redo) => {
    const d = docRef.current;
    const s = from.current.pop();
    if (!d || !s) return;
    to.current.push(snapOf(d));
    update({ ...d, ...s });
    bump((n) => n + 1);
  };

  // ---- playing -------------------------------------------------------------

  const at = (time: number) => {
    const i = lay.findIndex((l) => time >= l.at && time < l.at + l.len);
    return i >= 0 ? i : lay.length - 1;
  };
  const curIdx = lay.length ? at(Math.min(T, total - 0.001)) : -1;
  const cur = curIdx >= 0 ? lay[curIdx] : null;
  const curItem = cur ? byKey.get(cur.c.item)! : null;

  const levels = (time: number) => {
    const d = docRef.current;
    if (!d) return;
    const p = d.pulls.some(([a, b]) => time >= a - 0.4 && time < b);
    if (video.current) video.current.volume = p || !d.song ? 1 : Math.max(0, Math.min(1, d.gameVol));
    if (audio.current) audio.current.volume = Math.max(0, Math.min(1, p ? d.musicVol * 0.08 : d.musicVol));
  };

  const seek = useCallback(
    (time: number, play: boolean) => {
      if (lay.length === 0) return;
      time = Math.max(0, Math.min(total - 0.01, time));
      const i = at(time);
      const l = lay[i];
      const it = byKey.get(l.c.item)!;
      const local = Math.max(0, l.c.start + (time - l.at) - it.fileStart);
      setT(time);
      const v = video.current;
      if (v && v.dataset.file === it.file && v.readyState >= 1) {
        v.currentTime = local;
        if (play) v.play().catch(() => {});
        else v.pause();
      } else {
        pending.current = { local, play };
      }
      const a = audio.current;
      if (a && docRef.current?.song) {
        const st = docRef.current.musicOffset + time;
        if (Math.abs(a.currentTime - st) > 0.08) a.currentTime = st;
        if (play) a.play().catch(() => {});
        else a.pause();
      }
      levels(time);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lay, byKey, total],
  );

  const stop = () => {
    setPlaying(false);
    video.current?.pause();
    audio.current?.pause();
  };
  const play = () => {
    if (lay.length === 0) return;
    setPlaying(true);
    seek(T >= total - 0.05 ? 0 : T, true);
  };

  // the playhead follows the video, and the next clip starts when one ends
  const tRef = useRef(T);
  tRef.current = T;
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const v = video.current;
      const i = at(Math.min(tRef.current, total - 0.001));
      const l = lay[i];
      if (v && l && !v.paused && !v.seeking) {
        const it = byKey.get(l.c.item)!;
        if (it.fileStart + v.currentTime >= l.c.end - 0.03) {
          if (i + 1 < lay.length) {
            seek(lay[i + 1].at, true);
          } else {
            stop();
            setT(total);
            return;
          }
        } else {
          const now = l.at + (it.fileStart + v.currentTime - l.c.start);
          tRef.current = now;
          setT(now);
          levels(now);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, lay]);

  // ---- timeline operations ----------------------------------------------

  const selIdx = tl.findIndex((c) => c.key === sel);
  const selClip = selIdx >= 0 ? tl[selIdx] : null;
  const selItem = selClip ? byKey.get(selClip.item)! : null;

  const setClip = (key: string, patch: Partial<TClip>, undoable = true, persist = true) => {
    const d = docRef.current;
    if (!d) return;
    const timeline = d.timeline.map((c) => (c.key === key ? { ...c, ...patch } : c));
    if (undoable) edit({ timeline }, persist);
    else update({ ...d, timeline }, persist);
  };
  const removeClip = (key: string) => {
    const d = docRef.current;
    if (!d) return;
    edit({ timeline: d.timeline.filter((c) => c.key !== key) });
    if (sel === key) setSel(null);
  };
  const split = () => {
    const d = docRef.current;
    if (!d || !cur) return;
    const cut = cur.c.start + (T - cur.at);
    if (cut - cur.c.start < 0.3 || cur.c.end - cut < 0.3) return;
    const a: TClip = { ...cur.c, end: cut };
    const b: TClip = { ...cur.c, key: newKey(), start: cut, trans: "" };
    edit({ timeline: d.timeline.flatMap((c) => (c.key === cur.c.key ? [a, b] : [c])) });
    setSel(b.key);
  };
  const move = (from: number, to: number) => {
    if (from === to || from === to - 1) return;
    const list = [...tl];
    const [x] = list.splice(from, 1);
    list.splice(to > from ? to - 1 : to, 0, x);
    edit({ timeline: list });
  };
  const insert = (itemKey: string, index: number) => {
    const it = byKey.get(itemKey);
    if (!it) return;
    const list = [...tl];
    const c = tclipAfter(it, list[index - 1], items);
    list.splice(index, 0, c);
    edit({ timeline: list });
    setSel(c.key);
  };
  const removeItem = (key: string) => {
    const d = docRef.current;
    if (!d) return;
    edit({ items: d.items.filter((i) => i.key !== key), timeline: d.timeline.filter((c) => c.item !== key) });
  };

  // keys: space, S, delete, undo / redo, arrows
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.code === "Space") {
        e.preventDefault();
        if (playing) stop();
        else play();
      } else if ((e.key === "s" || e.key === "S") && !e.ctrlKey && !e.metaKey) {
        split();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (sel) removeClip(sel);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) back(redo, undo);
        else back(undo, redo);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        back(redo, undo);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const step = e.shiftKey ? 1 : 1 / 30;
        seek(T + (e.key === "ArrowLeft" ? -step : step), false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ---- bin and song ------------------------------------------------------

  const autoPick = async () => {
    setBusyMsg(t("正在挑素材…", "Picking clips…"));
    setErr(null);
    try {
      const list = (await api.listMatches()).filter((m) => m.highlights.length > 0).sort((a, b) => b.createdAtMs - a.createdAtMs);
      const game = list[0]?.game;
      const out: EditItem[] = [];
      for (const m of list.filter((x) => x.game === game)) {
        for (const h of m.highlights) {
          if (!h.kinds.some((k) => k === "kill" || k === "knock" || k === "win" || k === "objective")) continue;
          try {
            out.push(itemFrom(m, h));
          } catch {
            /* no footage */
          }
        }
        if (out.length >= 30) break;
      }
      if (out.length === 0) {
        setErr(t("录像库里还没有带击杀的高光。", "There are no highlights with kills in the library yet."));
        return;
      }
      remember();
      await addToEdit(out);
      const d = await loadEdit();
      setDoc(d);
      docRef.current = d;
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusyMsg(null);
    }
  };

  const pickSong = async () => {
    const f = await openDialog({
      multiple: false,
      directory: false,
      filters: [{ name: t("音乐", "Music"), extensions: ["mp3", "m4a", "aac", "wav", "flac", "ogg", "opus", "wma"] }],
    });
    if (!f || Array.isArray(f)) return;
    setErr(null);
    setBusyMsg(t("正在分析这首歌的节拍…", "Finding the song's beats…"));
    try {
      const info = await api.analyzeMusic(f);
      const name = f.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, "");
      const d = docRef.current!;
      update({ ...d, song: { path: f, name, info }, musicOffset: 0, pulls: [] });
      setTab("music");
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusyMsg(null);
    }
  };

  const runAuto = () => {
    const d = docRef.current;
    if (!d?.song) return;
    const r = autoCut(
      d.items.filter((i) => !missing.has(i.matchId)),
      d.song.info,
      d.auto,
    );
    if (!r) {
      setErr(t("素材里没有能用的击杀片段。", "None of the clips have kills to cut to."));
      return;
    }
    stop();
    edit({ timeline: r.timeline, musicOffset: r.musicOffset, pulls: r.pulls });
    setSel(null);
    setT(0);
  };

  // ---- export --------------------------------------------------------------

  const fileOf = (c: TClip) => byKey.get(c.item)!.file;
  const lowFps = tl.filter((c) => {
    const f = fps[fileOf(c)];
    return f != null && f > 0 && f < 119;
  }).length;
  const fpsKnown = tl.every((c) => fps[fileOf(c)] != null);
  const canInterp = !fpsKnown || lowFps > 0;

  const doExport = async () => {
    const d = docRef.current;
    if (!d || tl.length === 0) return;
    setErr(null);
    setExported(null);
    stop();
    setProgress({ fraction: 0, part: 1, parts: tl.length });
    const un = on<EditProgress>("edit-progress", setProgress);
    try {
      const r = requests({ ...d, timeline: tl });
      const path = await api.exportEdit(r.clips, { ...d.opts, fps120: d.opts.fps120 && canInterp && lowFps > 0, music: r.music });
      setExported(path);
    } catch (e) {
      setErr(errText(e));
    } finally {
      un();
      setProgress(null);
    }
  };

  if (!doc) {
    return (
      <div className="page">
        <Spinner />
      </div>
    );
  }

  const o = doc.opts;
  const setOpts = (p: Partial<EditOptions>) => update({ ...doc, opts: { ...o, ...p } });
  const busy = progress != null;
  const nMissing = tl.filter((c) => missing.has(byKey.get(c.item)!.matchId)).length;

  return (
    <div className="page page-wide edit-page ed2-page">
      <header className="page-head">
        <h1>{t("剪辑", "Edit")}</h1>
        {tl.length > 0 && <span className="count">{t(`${tl.length} 个片段 · ${clock(total)}`, `${tl.length} ${plural(tl.length, "clip", "clips")} · ${clock(total)}`)}</span>}
        <span className="grow" />
        {busyMsg && (
          <span className="muted small loading-row">
            <Spinner /> {busyMsg}
          </span>
        )}
        {err && <span className="warn-text small">{err}</span>}
      </header>

      <div className="ed2">
        {/* media bin */}
        <section className="ed2-bin">
          <div className="ed2-head">
            <b>{t("素材", "Media")}</b>
            <span className="faint small">{items.length}</span>
            <span className="grow" />
            <button type="button" className="iconbtn sm" title={t("从最近对局挑素材", "Pick from recent matches")} onClick={autoPick} disabled={!!busyMsg}>
              <Wand2 size={15} />
            </button>
          </div>
          {items.length === 0 ? (
            <div className="ed2-bin-empty">
              <Clapperboard size={22} />
              <p className="small muted">{t("在对局页点「加入剪辑」，或者从最近的对局里自动挑。", 'Add clips from a match with "Add to edit", or pick them from your latest matches.')}</p>
              <Button small kind="primary" onClick={autoPick} disabled={!!busyMsg}>
                <Wand2 size={14} /> {t("从最近对局挑", "Pick from recent")}
              </Button>
              <Button small onClick={props.openLibrary}>
                {t("去录像库", "Go to the library")}
              </Button>
            </div>
          ) : (
            <ul className="ed2-bin-list">
              {items.map((it) => {
                const onTl = tl.some((c) => c.item === it.key);
                const gone = missing.has(it.matchId);
                return (
                  <li
                    key={it.key}
                    draggable={!gone}
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/kc-item", it.key);
                      e.dataTransfer.effectAllowed = "copy";
                    }}
                    className={(onTl ? "is-used " : "") + (gone ? "is-missing" : "")}
                    title={t("拖到下面的时间线上", "Drag onto the timeline")}
                  >
                    <span className="ed2-bin-thumb">
                      {it.thumb && <img src={fileUrl(it.thumb)} alt="" loading="lazy" draggable={false} />}
                      <span className="dur">{clock(it.end - it.start)}</span>
                    </span>
                    <span className="ed2-bin-info">
                      <span className="ed2-bin-title">{title(it.title)}</span>
                      <span className="faint small">{gone ? t("录像已删除", "Recording deleted") : `${label(it.mapLabel)} · ${when(it.createdAtMs)}`}</span>
                      <span className="ed2-bin-kinds">
                        {it.kinds.slice(0, 6).map((k, i) => (
                          <KindIcon key={i} kind={k} small game={it.game} />
                        ))}
                      </span>
                    </span>
                    <span className="ed2-bin-acts">
                      <button type="button" className="iconbtn sm" title={t("放到时间线末尾", "Add to the end of the timeline")} disabled={gone} onClick={() => insert(it.key, tl.length)}>
                        <Plus size={14} />
                      </button>
                      <button type="button" className="iconbtn sm" title={t("从素材里移除", "Remove from media")} onClick={() => removeItem(it.key)}>
                        <X size={14} />
                      </button>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* monitor */}
        <section className="ed2-monitor">
          <div className="ed2-screen" onClick={() => (playing ? stop() : play())}>
            {curItem && !missing.has(curItem.matchId) ? (
              <video
                key={curItem.file}
                ref={video}
                data-file={curItem.file}
                src={fileUrl(curItem.file)}
                onLoadedMetadata={(e) => {
                  const p = pending.current;
                  if (p) {
                    e.currentTarget.currentTime = p.local;
                    if (p.play) e.currentTarget.play().catch(() => {});
                    pending.current = null;
                  } else if (cur) {
                    e.currentTarget.currentTime = Math.max(0, cur.c.start + (T - cur.at) - curItem.fileStart);
                  }
                  levels(T);
                }}
              />
            ) : (
              <div className="ed2-screen-empty muted small">
                {curItem ? t("这段所在的录像已经被删掉了", "This clip's recording has been deleted") : t("时间线是空的：把左边的素材拖下来，或者选一首歌一键卡点。", "The timeline is empty: drag clips down from the left, or pick a song and auto-cut.")}
              </div>
            )}
            {o.aspect === "9:16" && <div className="ed-crop" aria-hidden />}
          </div>
          {song && <audio ref={audio} src={fileUrl(song.path)} preload="auto" />}
          <div className="ed2-transport">
            <button type="button" className="ed2-play" onClick={() => (playing ? stop() : play())} disabled={tl.length === 0} title={t("播放 / 暂停（空格）", "Play / pause (Space)")}>
              {playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
            </button>
            <span className="mono">
              {tc(T)} <span className="faint">/ {tc(total)}</span>
            </span>
            <span className="grow" />
            {curItem && (
              <span className="muted small ellipsis">
                {title(curItem.title)} · {label(curItem.mapLabel)}
              </span>
            )}
          </div>
        </section>

        {/* inspector */}
        <section className="ed2-inspector">
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              { value: "clip", label: t("片段", "Clip") },
              { value: "music", label: t("音乐", "Music") },
              { value: "export", label: t("导出", "Export") },
            ]}
          />
          {tab === "clip" &&
            (selClip && selItem ? (
              <div className="ed2-props">
                <div className="ed2-prop-head">
                  {selItem.thumb && <img src={fileUrl(selItem.thumb)} alt="" />}
                  <div>
                    <b>{title(selItem.title)}</b>
                    <span className="muted small">
                      {label(selItem.mapLabel)} · {when(selItem.createdAtMs)}
                    </span>
                  </div>
                </div>
                <div className="ed2-prop">
                  <span>{t("范围", "Range")}</span>
                  <span className="mono small">
                    {clock(selClip.start)} – {clock(selClip.end)} · {(selClip.end - selClip.start).toFixed(1)}s
                  </span>
                </div>
                {(["start", "end"] as const).map((edge) => (
                  <div className="ed2-prop" key={edge}>
                    <span>{edge === "start" ? t("开头", "Start") : t("结尾", "End")}</span>
                    <div className="nudge">
                      {[-1, -0.1, 0.1, 1].map((d) => (
                        <button
                          type="button"
                          key={d}
                          onClick={() => {
                            const c = selClip;
                            const it = selItem;
                            if (edge === "start") setClip(c.key, { start: Math.max(it.lo, Math.min(c.start + d, c.end - 0.5)) });
                            else setClip(c.key, { end: Math.min(it.hi, Math.max(c.end + d, c.start + 0.5)) });
                          }}
                        >
                          {d > 0 ? "+" : "−"}
                          {Math.abs(d)}s
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
                <div className="ed2-prop is-col">
                  <span>{t("进入方式", "Comes in with")}</span>
                  <Segmented
                    value={selIdx === 0 ? "" : selClip.trans}
                    onChange={(v: Trans) => setClip(selClip.key, { trans: v })}
                    options={[
                      { value: "", label: t("硬切", "Cut") },
                      { value: "flash", label: t("闪白", "Flash"), disabled: selIdx === 0 },
                      { value: "black", label: t("黑场", "Black"), disabled: selIdx === 0 },
                    ]}
                  />
                </div>
                <div className="export-row">
                  <Button small onClick={split} disabled={!cur || cur.c.key !== selClip.key}>
                    <Scissors size={14} /> {t("在播放头拆分", "Split at playhead")}
                  </Button>
                  <Button small kind="ghost" onClick={() => removeClip(selClip.key)}>
                    <Trash2 size={14} /> {t("删除", "Delete")}
                  </Button>
                </div>
                <button type="button" className="link small" onClick={() => props.openMatch(selItem.matchId)} disabled={missing.has(selItem.matchId)}>
                  {t("打开这局", "Open match")}
                </button>
                <p className="faint small">{t("拖动时间线上片段的两边可以剪长短，拖动中间可以换位置。S 拆分，Delete 删除，Ctrl+Z 撤销，← → 逐帧。", "Drag a clip's edges on the timeline to trim, its middle to move it. S splits, Delete removes, Ctrl+Z undoes, ← → step a frame.")}</p>
              </div>
            ) : (
              <p className="muted small">{t("点一下时间线上的片段来调整它。", "Click a clip on the timeline to adjust it.")}</p>
            ))}

          {tab === "music" && (
            <div className="ed2-props">
              {song ? (
                <div className="bc-song">
                  <Music size={16} />
                  <span className="ellipsis" title={song.path}>
                    {song.name}
                  </span>
                  <span className="grow" />
                  <span className="mono muted small">
                    {Math.round(song.info.bpm)} BPM · {clock(song.info.duration)}
                  </span>
                </div>
              ) : (
                <p className="muted small">{t("用你自己的歌（mp3、m4a、wav 等）。软件不自带音乐，发布到平台时注意版权。", "Use your own song (mp3, m4a, wav…). No music comes with the app; mind the rights when you post.")}</p>
              )}
              <div className="export-row">
                <Button small kind={song ? "ghost" : "primary"} onClick={pickSong} disabled={!!busyMsg}>
                  <Music size={14} /> {song ? t("换一首", "Change song") : t("选择音乐", "Pick a song")}
                </Button>
                {song && (
                  <Button small kind="ghost" onClick={() => update({ ...doc, song: null, pulls: [] })}>
                    <X size={14} /> {t("不要音乐", "No music")}
                  </Button>
                )}
              </div>
              {song && (
                <>
                  <div className="bc-vol">
                    <span className="small">{t("音乐", "Music")}</span>
                    <Range value={Math.round(doc.musicVol * 100)} min={0} max={100} step={5} format={(v) => `${v}%`} onChange={(v) => update({ ...doc, musicVol: v / 100 })} />
                  </div>
                  <div className="bc-vol">
                    <span className="small">{t("游戏声音", "Game sound")}</span>
                    <Range value={Math.round(doc.gameVol * 100)} min={0} max={100} step={5} format={(v) => `${v}%`} onChange={(v) => update({ ...doc, gameVol: v / 100 })} />
                  </div>
                  <div className="ed2-sub">
                    <b>
                      <Wand2 size={14} /> {t("一键卡点", "Auto-cut to the beat")}
                    </b>
                    <p className="muted small">
                      {t(
                        "按歌重新排时间线：最好的一波的第一个击杀落在歌曲高潮，每场对枪完整不剪断，切点落在拍子上，同一段画面不会出现两次。",
                        "Rebuilds the timeline to the song: the best fight's first kill lands where the song kicks in, every fight plays whole, cuts land on beats, and no footage plays twice.",
                      )}
                    </p>
                    <span className="ed-fx-label">{t("长度", "Length")}</span>
                    <Segmented
                      value={doc.auto.length}
                      onChange={(v) => update({ ...doc, auto: { ...doc.auto, length: v } })}
                      options={[
                        { value: 30, label: t("30 秒", "30 s") },
                        { value: 60, label: t("1 分钟", "1 min") },
                        { value: 0, label: t("整首", "Whole song") },
                      ]}
                    />
                    <span className="ed-fx-label">{t("换局时", "Between matches")}</span>
                    <Segmented
                      value={doc.auto.trans}
                      onChange={(v: Trans) => update({ ...doc, auto: { ...doc.auto, trans: v } })}
                      options={[
                        { value: "", label: t("硬切", "Cut") },
                        { value: "flash", label: t("闪白", "Flash") },
                        { value: "black", label: t("黑场", "Black") },
                      ]}
                    />
                    <Toggle checked={doc.auto.pull} onChange={(v) => update({ ...doc, auto: { ...doc.auto, pull: v } })} label={t("高潮团战抽离音乐", "Drop the music for the big fight")} />
                    <Button kind="primary" onClick={runAuto} disabled={items.length === 0}>
                      <Wand2 size={15} /> {tl.length ? t("重新一键卡点", "Auto-cut again") : t("一键卡点", "Auto-cut")}
                    </Button>
                    {tl.length > 0 && <p className="faint small">{t("会替换现在的时间线，可以 Ctrl+Z 撤销。", "Replaces the current timeline; Ctrl+Z undoes it.")}</p>}
                  </div>
                  <div className="ed2-sub">
                    <b>{t("音乐抽离", "Music pulled back")}</b>
                    {doc.pulls.length === 0 && <p className="muted small">{t("没有。", "None.")}</p>}
                    {doc.pulls.map(([a, b], i) => (
                      <div className="ed2-prop" key={i}>
                        <span className="mono small">
                          {tc(a)} – {tc(b)}
                        </span>
                        <button type="button" className="iconbtn sm" onClick={() => edit({ pulls: doc.pulls.filter((_, j) => j !== i) })} title={t("去掉", "Remove")}>
                          <X size={14} />
                        </button>
                      </div>
                    ))}
                    <Button small kind="ghost" onClick={() => edit({ pulls: [...doc.pulls, [T, Math.min(total, T + 4)] as [number, number]].sort((x, y) => x[0] - y[0]) })} disabled={tl.length === 0}>
                      <Plus size={14} /> {t("从播放头起抽离 4 秒", "Pull back 4 s from the playhead")}
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}

          {tab === "export" && (
            <div className="ed2-props">
              <span className="ed-fx-label">{t("画面", "Picture")}</span>
              <Segmented
                value={o.aspect}
                onChange={(a) => setOpts({ aspect: a })}
                options={[
                  { value: "source", label: t("原比例", "Original") },
                  { value: "16:9", label: "16:9" },
                  { value: "9:16", label: t("竖屏", "Vertical") },
                ]}
              />
              <Segmented
                value={o.height}
                onChange={(h) => setOpts({ height: h })}
                options={[
                  { value: 0, label: t("原始", "Source") },
                  { value: 1080, label: "1080p" },
                  { value: 720, label: "720p" },
                ]}
              />
              <Segmented
                value={o.sizeMb}
                onChange={(n) => setOpts({ sizeMb: n })}
                options={[
                  { value: 0, label: t("不限大小", "Any size") },
                  { value: 10, label: "10MB" },
                  { value: 25, label: "25MB" },
                  { value: 50, label: "50MB" },
                ]}
              />
              {canInterp ? (
                <>
                  <Toggle checked={o.fps120 && o.sizeMb === 0} disabled={o.sizeMb > 0} onChange={(v) => setOpts({ fps120: v })} label={t("补帧到 120 帧", "Interpolate to 120 fps")} />
                  {o.fps120 && o.sizeMb === 0 && (
                    <p className="warn-text small">
                      {t(`有 ${lowFps} 段不到 120 帧。补帧用 CPU 算，非常慢：1 分钟的成片可能要半小时以上。`, `${lowFps} ${plural(lowFps, "clip is", "clips are")} under 120 fps. Interpolation runs on the CPU and is very slow: a 1-minute video can take half an hour or more.`)}
                    </p>
                  )}
                </>
              ) : (
                <p className="muted small">{t("录像本来就是 120 帧，导出也是 120 帧。", "The footage is 120 fps already, and exports at 120 fps.")}</p>
              )}
              {busy ? (
                <>
                  <div className="ed-prog">
                    <div className="ed-prog-bar" style={{ width: `${Math.round(progress.fraction * 100)}%` }} />
                  </div>
                  <div className="export-row">
                    <span className="muted small">
                      {progress.part > 0 ? t(`正在处理第 ${progress.part} / ${progress.parts} 段`, `Clip ${progress.part} of ${progress.parts}`) : t("正在合成", "Joining")} · {Math.round(progress.fraction * 100)}%
                    </span>
                    <span className="grow" />
                    <Button small kind="ghost" onClick={() => api.cancelEdit()}>
                      {t("取消", "Cancel")}
                    </Button>
                  </div>
                </>
              ) : (
                <Button kind="primary" onClick={doExport} disabled={tl.length === 0 || nMissing > 0}>
                  <Download size={15} /> {t("导出视频", "Export video")}
                </Button>
              )}
              {nMissing > 0 && (
                <p className="warn-text small">
                  {t(`时间线上有 ${nMissing} 段的录像已经不在了，先删掉它们。`, `${nMissing} ${plural(nMissing, "clip on the timeline has", "clips on the timeline have")} no recording any more; delete ${plural(nMissing, "it", "them")} first.`)}
                </p>
              )}
              {exported && (
                <p className="ok-text small">
                  {t("已导出", "Exported")} <span className="mono">{exported.split(/[\\/]/).pop()}</span>
                  <button type="button" className="link" onClick={() => api.reveal(exported)}>
                    {t("在文件夹中显示", "Show in folder")}
                  </button>
                </p>
              )}
            </div>
          )}
        </section>

        <TimelinePanel
          doc={doc}
          tl={tl}
          lay={lay}
          total={total}
          byKey={byKey}
          missing={missing}
          T={T}
          sel={sel}
          zoom={zoom}
          setZoom={setZoom}
          playing={playing}
          onPlay={() => (playing ? stop() : play())}
          onSeek={(x) => seek(x, playing)}
          onSelect={(k) => {
            setSel(k);
            if (k) setTab("clip");
          }}
          onTrim={(key, start, end, commit) => setClip(key, { start, end }, false, commit)}
          onTrimStart={remember}
          onMove={move}
          onInsert={insert}
          onTrans={(key) => {
            const c = tl.find((x) => x.key === key);
            if (!c) return;
            setClip(key, { trans: c.trans === "" ? "flash" : c.trans === "flash" ? "black" : "" });
          }}
          onOffset={(off, commit) => {
            const d = docRef.current;
            if (d) update({ ...d, musicOffset: off }, commit);
          }}
          onOffsetStart={remember}
          onSplit={split}
          onDelete={() => sel && removeClip(sel)}
          canUndo={undo.current.length > 0}
          canRedo={redo.current.length > 0}
          onUndo={() => back(undo, redo)}
          onRedo={() => back(redo, undo)}
          onSnap={(v) => update({ ...doc, snap: v })}
          onAuto={runAuto}
        />
      </div>
    </div>
  );
}

function TimelinePanel(props: {
  doc: EditDoc;
  tl: TClip[];
  lay: Laid[];
  total: number;
  byKey: Map<string, EditItem>;
  missing: Set<string>;
  T: number;
  sel: string | null;
  zoom: number;
  setZoom: (z: number) => void;
  playing: boolean;
  onPlay: () => void;
  onSeek: (t: number) => void;
  onSelect: (k: string | null) => void;
  onTrim: (key: string, start: number, end: number, commit: boolean) => void;
  onTrimStart: () => void;
  onMove: (from: number, to: number) => void;
  onInsert: (item: string, index: number) => void;
  onTrans: (key: string) => void;
  onOffset: (off: number, commit: boolean) => void;
  onOffsetStart: () => void;
  onSplit: () => void;
  onDelete: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onSnap: (v: boolean) => void;
  onAuto: () => void;
}) {
  const { doc, tl, lay, total, byKey } = props;
  const song = doc.song;
  const dup = useMemo(() => repeats(tl, doc.items), [tl, doc.items]);
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // the whole video fits at zoom 1, with some room after it
  const span = Math.max(total * 1.1, 15);
  const pps = (Math.max(300, width - 24) / span) * props.zoom;
  const inner = Math.max(width, span * pps + 40);
  const X = (s: number) => s * pps;

  const beats = song ? song.info.beats.map((b) => b - doc.musicOffset).filter((b) => b >= 0 && b <= inner / pps) : [];
  const downs = song ? song.info.downbeats.map((b) => b - doc.musicOffset).filter((b) => b >= 0 && b <= inner / pps) : [];
  const snapT = (s: number) => {
    if (!doc.snap) return s;
    const cands = [...beats, ...lay.map((l) => l.at), total, props.T];
    let best = s;
    let d = 8 / pps;
    for (const c of cands) {
      if (Math.abs(c - s) < d) {
        d = Math.abs(c - s);
        best = c;
      }
    }
    return best;
  };

  // ruler ticks
  const step = [0.5, 1, 2, 5, 10, 15, 30, 60].find((s) => s * pps >= 64) ?? 60;
  const ticks: number[] = [];
  for (let s = 0; s <= inner / pps; s += step) ticks.push(s);

  const timeAt = (clientX: number, el: EventTarget) => {
    const r = (el as HTMLElement).getBoundingClientRect();
    return Math.max(0, (clientX - r.left) / pps);
  };

  const scrub = (e: PtrEv) => {
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    props.onSeek(Math.min(total, timeAt(e.clientX, el)));
    const mv = (ev: PointerEvent) => props.onSeek(Math.min(total, timeAt(ev.clientX, el)));
    const up = () => {
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
  };

  const trim = (l: Laid, edge: "a" | "b") => (e: PtrEv) => {
    e.stopPropagation();
    e.preventDefault();
    const it = byKey.get(l.c.item)!;
    props.onTrimStart();
    props.onSelect(l.c.key);
    const x0 = e.clientX;
    const { start: s0, end: e0 } = l.c;
    let last = { start: s0, end: e0 };
    const mv = (ev: PointerEvent) => {
      const ds = (ev.clientX - x0) / pps;
      let start = s0;
      let end = e0;
      if (edge === "b") {
        end = Math.min(it.hi, Math.max(s0 + 0.5, e0 + ds));
        end = Math.min(it.hi, Math.max(s0 + 0.5, s0 + (snapT(l.at + (end - s0)) - l.at)));
        props.onSeek(Math.max(l.at, l.at + (end - s0) - 0.04));
      } else {
        start = Math.max(it.lo, Math.min(e0 - 0.5, s0 + ds));
        start = Math.max(it.lo, Math.min(e0 - 0.5, e0 - (snapT(l.at + (e0 - start)) - l.at)));
        props.onSeek(l.at);
      }
      last = { start, end };
      props.onTrim(l.c.key, start, end, false);
    };
    const up = () => {
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
      props.onTrim(l.c.key, last.start, last.end, true);
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
  };

  const grabClip = (l: Laid, i: number) => (e: PtrEv) => {
    e.preventDefault();
    const track = (e.currentTarget as HTMLElement).parentElement!;
    const x0 = e.clientX;
    let moved = false;
    let target = i;
    const mv = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - x0) < 5) return;
      moved = true;
      setDragging(l.c.key);
      const x = timeAt(ev.clientX, track);
      let k = lay.findIndex((m) => x < m.at + m.len / 2);
      if (k < 0) k = lay.length;
      target = k;
      setDropAt(k);
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
      setDragging(null);
      setDropAt(null);
      if (moved) props.onMove(i, target);
      else {
        props.onSelect(l.c.key);
        props.onSeek(Math.min(l.at + l.len - 0.01, timeAt(ev.clientX, track)));
      }
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
  };

  const grabMusic = (e: PtrEv) => {
    if (!song) return;
    e.preventDefault();
    props.onOffsetStart();
    const x0 = e.clientX;
    const off0 = doc.musicOffset;
    let last = off0;
    const mv = (ev: PointerEvent) => {
      let off = Math.max(0, Math.min(song.info.duration - 1, off0 - (ev.clientX - x0) / pps));
      if (doc.snap) {
        const d = song.info.downbeats.reduce((b, x) => (Math.abs(x - off) < Math.abs(b - off) ? x : b), off);
        if (Math.abs(d - off) * pps < 12) off = d;
      }
      last = off;
      props.onOffset(off, false);
    };
    const up = () => {
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
      props.onOffset(last, true);
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
  };

  const indexAt = (x: number) => {
    const k = lay.findIndex((m) => x < m.at + m.len / 2);
    return k < 0 ? lay.length : k;
  };
  const binDrop = (e: DragEv) => {
    const k = e.dataTransfer.getData("text/kc-item");
    e.preventDefault();
    setDropAt(null);
    if (k) props.onInsert(k, indexAt(timeAt(e.clientX, e.currentTarget)));
  };

  return (
    <section className="ed2-timeline">
      <div className="ed2-tools">
        <button type="button" className="iconbtn sm" onClick={props.onPlay} title={t("播放 / 暂停（空格）", "Play / pause (Space)")} disabled={tl.length === 0}>
          {props.playing ? <Pause size={15} /> : <Play size={15} />}
        </button>
        <span className="mono small">{tc(props.T)}</span>
        <span className="ed2-sep" />
        <button type="button" className="iconbtn sm" onClick={props.onUndo} disabled={!props.canUndo} title={t("撤销（Ctrl+Z）", "Undo (Ctrl+Z)")}>
          <Undo2 size={15} />
        </button>
        <button type="button" className="iconbtn sm" onClick={props.onRedo} disabled={!props.canRedo} title={t("重做（Ctrl+Y）", "Redo (Ctrl+Y)")}>
          <Redo2 size={15} />
        </button>
        <span className="ed2-sep" />
        <button type="button" className="iconbtn sm" onClick={props.onSplit} disabled={tl.length === 0} title={t("在播放头拆分（S）", "Split at playhead (S)")}>
          <Scissors size={15} />
        </button>
        <button type="button" className="iconbtn sm" onClick={props.onDelete} disabled={!props.sel} title={t("删除选中的片段（Delete）", "Delete the selected clip (Delete)")}>
          <Trash2 size={15} />
        </button>
        <span className="ed2-sep" />
        <button type="button" className={"iconbtn sm" + (doc.snap ? " is-on" : "")} onClick={() => props.onSnap(!doc.snap)} title={doc.snap ? t("吸附：开（贴到节拍和片段边缘）", "Snapping on (beats and clip edges)") : t("吸附：关", "Snapping off")}>
          <Magnet size={15} />
        </button>
        {song && (
          <Button small onClick={props.onAuto}>
            <Wand2 size={14} /> {t("一键卡点", "Auto-cut")}
          </Button>
        )}
        <span className="grow" />
        <button type="button" className="iconbtn sm" onClick={() => props.setZoom(Math.max(1, props.zoom / 1.5))} disabled={props.zoom <= 1} title={t("缩小", "Zoom out")}>
          <Minus size={15} />
        </button>
        <input className="ed2-zoom" type="range" min={0} max={100} value={Math.round((Math.log(props.zoom) / Math.log(20)) * 100)} onChange={(e) => props.setZoom(Math.pow(20, Number(e.target.value) / 100))} />
        <button type="button" className="iconbtn sm" onClick={() => props.setZoom(Math.min(20, props.zoom * 1.5))} title={t("放大", "Zoom in")}>
          <Plus size={15} />
        </button>
      </div>

      <div className="ed2-tracks">
        <div className="ed2-heads">
          <span className="ed2-hd-ruler" />
          <span className="ed2-hd">{t("画面", "Video")}</span>
          <span className="ed2-hd">{t("音乐", "Music")}</span>
        </div>
        <div className="ed2-scroll" ref={wrap}>
          <div className="ed2-inner" style={{ width: inner }}>
            <div className="ed2-ruler" onPointerDown={scrub}>
              {ticks.map((s) => (
                <span key={s} className="ed2-tick" style={{ left: X(s) }}>
                  {clock(s)}
                </span>
              ))}
              {downs.map((b, i) => (
                <span key={"d" + i} className="ed2-bar" style={{ left: X(b) }} />
              ))}
            </div>

            <div
              className={"ed2-track ed2-v" + (dropAt != null ? " is-drop" : "")}
              onPointerDown={(e) => {
                if (e.target === e.currentTarget) {
                  props.onSelect(null);
                  props.onSeek(Math.min(total, timeAt(e.clientX, e.currentTarget)));
                }
              }}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes("text/kc-item")) return;
                e.preventDefault();
                setDropAt(indexAt(timeAt(e.clientX, e.currentTarget)));
              }}
              onDragLeave={() => setDropAt(null)}
              onDrop={binDrop}
            >
              {beats.map((b, i) => (
                <span key={i} className="ed2-beat" style={{ left: X(b) }} />
              ))}
              {lay.map((l, i) => {
                const it = byKey.get(l.c.item)!;
                const gone = props.missing.has(it.matchId);
                return (
                  <div
                    key={l.c.key}
                    className={"ed2-clip" + (l.c.key === props.sel ? " is-sel" : "") + (gone ? " is-missing" : "") + (dragging === l.c.key ? " is-drag" : "") + (dup.has(l.c.key) ? " is-dup" : "")}
                    style={{ left: X(l.at), width: Math.max(4, X(l.len)) }}
                    onPointerDown={grabClip(l, i)}
                    title={`${title(it.title)} · ${label(it.mapLabel)} · ${l.len.toFixed(1)}s`}
                  >
                    {it.thumb && <span className="ed2-clip-film" style={{ backgroundImage: `url("${fileUrl(it.thumb)}")` }} />}
                    <span className="ed2-clip-label">{title(it.title)}</span>
                    <span className="ed2-clip-len mono">{l.len.toFixed(1)}s</span>
                    {dup.has(l.c.key) && <span className="ed2-clip-dup" title={t("这段画面在别的片段里也有，会重复播放", "Some of this footage is also in another clip, so it plays twice")}>{t("重复", "Repeat")}</span>}
                    {it.events
                      .filter((e) => (e.kind === "kill" || e.kind === "knock" || e.kind === "win") && e.t >= l.c.start && e.t <= l.c.end && !e.credited)
                      .map((e) => (
                        <span key={e.id} className={"ed2-ev is-" + e.kind} style={{ left: X(e.t - l.c.start) }} />
                      ))}
                    <span className="ed2-edge is-a" onPointerDown={trim(l, "a")} />
                    <span className="ed2-edge is-b" onPointerDown={trim(l, "b")} />
                  </div>
                );
              })}
              {lay.slice(1).map((l) => (
                <button
                  type="button"
                  key={"t" + l.c.key}
                  className={"ed2-trans is-" + (l.c.trans || "cut")}
                  style={{ left: X(l.at) }}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => props.onTrans(l.c.key)}
                  title={t(`转场：${l.c.trans === "flash" ? "闪白" : l.c.trans === "black" ? "黑场" : "硬切"}（点击切换）`, `Transition: ${l.c.trans === "flash" ? "flash" : l.c.trans === "black" ? "black" : "cut"} (click to change)`)}
                />
              ))}
              {dropAt != null && <span className="ed2-dropline" style={{ left: X(dropAt < lay.length ? lay[dropAt].at : total) }} />}
            </div>

            <div className="ed2-track ed2-m">
              {song ? (
                <div className="ed2-song" style={{ left: X(-doc.musicOffset), width: X(song.info.duration) }} onPointerDown={grabMusic} title={t("左右拖动，选用歌曲的哪一段", "Drag sideways to choose which part of the song plays")}>
                  <span className="ed2-song-wave">
                    {song.info.beats.map((b, i) => (
                      <i key={i} style={{ left: X(b), height: `${20 + 80 * (song.info.energy[i] ?? 0)}%` }} />
                    ))}
                  </span>
                  <span className="ed2-song-name" style={{ left: X(doc.musicOffset) + 6 }}>
                    <Music size={12} /> {song.name}
                  </span>
                  <span className="ed2-song-drop" style={{ left: X(song.info.drop) }} title={t("歌曲高潮", "The song kicks in")} />
                </div>
              ) : (
                <span className="ed2-m-empty faint small">{t("在右边「音乐」里选一首歌", "Pick a song under Music on the right")}</span>
              )}
              {doc.pulls.map(([a, b], i) => (
                <span key={i} className="ed2-pull" style={{ left: X(a), width: X(b - a) }} title={t("音乐抽离", "Music pulled back")} />
              ))}
              <span className="ed2-end" style={{ left: X(total) }} />
            </div>

            <div className="ed2-playhead" style={{ left: X(props.T) }} />
          </div>
        </div>
      </div>
    </section>
  );
}
