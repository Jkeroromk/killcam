import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Clapperboard, Download, Play, Square, Trash2, X } from "lucide-react";
import { api, errText, fileUrl, on, type EditOptions, type EditProgress } from "../lib/api";
import { clock, when } from "../lib/format";
import { label, plural, t, title } from "../lib/i18n";
import { CAPTION_S, SLOW, captionEvents, captionText, loadEdit, outLen, request, saveEdit, segments, slowTimes, type EditDoc, type EditItem, type SlowMode } from "../lib/edit";
import { Button, KindIcon, Segmented, Spinner, Toggle } from "../components/ui";

/** The selected clip's range on a strip of its footage: drag the edges to trim. */
function TrimBar(props: {
  it: EditItem;
  slow: SlowMode;
  captions: boolean;
  pos: number | null;
  onDrag: (start: number, end: number, edge: "a" | "b") => void;
  onCommit: () => void;
  onSeek: (t: number) => void;
}) {
  const { it } = props;
  const bar = useRef<HTMLDivElement>(null);
  const span = Math.max(1, it.hi - it.lo);
  const pct = (x: number) => `${((Math.min(it.hi, Math.max(it.lo, x)) - it.lo) / span) * 100}%`;
  const at = (clientX: number) => {
    const r = bar.current!.getBoundingClientRect();
    return it.lo + Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * span;
  };
  const grab = (edge: "a" | "b") => (e: { preventDefault(): void; stopPropagation(): void; target: EventTarget; pointerId: number }) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const x = at(ev.clientX);
      if (edge === "a") props.onDrag(Math.min(x, it.end - 1), it.end, "a");
      else props.onDrag(it.start, Math.max(x, it.start + 1), "b");
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      props.onCommit();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const slowWins = segments(
    it.end - it.start,
    slowTimes(it, props.slow).map((x) => x - it.start),
  ).filter((s) => s[2]);
  return (
    <div className="ed-trim" ref={bar} onPointerDown={(e) => props.onSeek(at(e.clientX))}>
      <div className="ed-trim-sel" style={{ left: pct(it.start), width: `calc(${pct(it.end)} - ${pct(it.start)})` }} />
      {slowWins.map(([a, b], i) => (
        <div key={i} className="ed-trim-slow" style={{ left: pct(it.start + a), width: `calc(${pct(it.start + b)} - ${pct(it.start + a)})` }} title={t("慢动作", "Slow motion")} />
      ))}
      {it.events
        .filter((e) => e.t >= it.lo && e.t <= it.hi)
        .map((e) => (
          <span key={e.id} className="ed-trim-ev" style={{ left: pct(e.t) }} title={captionText(e)}>
            <KindIcon kind={e.kind} small game={it.game} />
          </span>
        ))}
      {props.captions &&
        captionEvents(it).map((e) => (
          <div key={"c" + e.id} className="ed-trim-cap" style={{ left: pct(e.t - 0.2), width: `calc(${pct(Math.min(it.end, e.t - 0.2 + CAPTION_S))} - ${pct(e.t - 0.2)})` }} />
        ))}
      {props.pos != null && props.pos >= it.lo && props.pos <= it.hi && <div className="ed-trim-head" style={{ left: pct(props.pos) }} />}
      <button type="button" className="ed-trim-h is-a" style={{ left: pct(it.start) }} onPointerDown={grab("a")} aria-label={t("开头", "Start")} />
      <button type="button" className="ed-trim-h is-b" style={{ left: pct(it.end) }} onPointerDown={grab("b")} aria-label={t("结尾", "End")} />
    </div>
  );
}

export default function EditPage(props: { openLibrary: () => void; openMatch: (id: string) => void }) {
  const [doc, setDoc] = useState<EditDoc | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<EditProgress | null>(null);
  const [exported, setExported] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [drag, setDrag] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const [pos, setPos] = useState<number | null>(null);
  const [playingAll, setPlayingAll] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const pending = useRef<{ local: number; play: boolean } | null>(null);
  const playAll = useRef(false);
  const stopAt = useRef<number | null>(null);

  useEffect(() => {
    loadEdit().then((d) => {
      setDoc(d);
      setSel(d.items[0]?.key ?? null);
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
  const idx = items.findIndex((i) => i.key === sel);
  const it = idx >= 0 ? items[idx] : null;

  const update = (d: EditDoc, save = true) => {
    setDoc(d);
    setExported(null);
    if (save) saveEdit(d).catch((e) => setErr(errText(e)));
  };
  const setItem = (key: string, patch: Partial<EditItem>, save = true) => {
    if (!doc) return;
    update({ ...doc, items: doc.items.map((i) => (i.key === key ? { ...i, ...patch } : i)) }, save);
  };

  // jump the player to the selected clip
  const show = (x: EditItem, play: boolean, from?: number) => {
    const local = Math.max(0, (from ?? x.start) - x.fileStart);
    stopAt.current = x.end;
    const v = video.current;
    if (v && v.readyState >= 1 && v.dataset.file === x.file) {
      v.currentTime = local;
      if (play) v.play().catch(() => {});
      else v.pause();
    } else {
      pending.current = { local, play };
    }
  };
  useEffect(() => {
    if (it) show(it, playAll.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel]);

  const stopAll = () => {
    playAll.current = false;
    setPlayingAll(false);
  };

  const onTime = (v: HTMLVideoElement) => {
    if (!it || !doc) return;
    const g = it.fileStart + v.currentTime;
    setPos(g);
    // preview the slow motion
    const rel = g - it.start;
    const slow = segments(
      it.end - it.start,
      slowTimes(it, doc.slow).map((x) => x - it.start),
    ).some(([a, b, s]) => s && rel >= a && rel < b);
    const rate = slow ? SLOW : 1;
    if (v.playbackRate !== rate) v.playbackRate = rate;
    if (stopAt.current != null && g >= stopAt.current) {
      stopAt.current = null;
      if (playAll.current && idx + 1 < items.length) {
        setSel(items[idx + 1].key);
      } else {
        v.pause();
        v.playbackRate = 1;
        stopAll();
      }
    }
  };

  const caption = useMemo(() => {
    if (!it || !doc?.captions || pos == null) return null;
    const e = captionEvents(it).find((e) => pos >= e.t - 0.2 && pos <= Math.min(it.end, e.t - 0.2 + CAPTION_S));
    return e ? captionText(e) : null;
  }, [it, doc?.captions, pos]);

  const move = (from: number, to: number) => {
    if (!doc || from === to || to < 0 || to > doc.items.length) return;
    const list = [...doc.items];
    const [x] = list.splice(from, 1);
    list.splice(to > from ? to - 1 : to, 0, x);
    update({ ...doc, items: list });
  };

  const remove = (key: string) => {
    if (!doc) return;
    const i = doc.items.findIndex((x) => x.key === key);
    const list = doc.items.filter((x) => x.key !== key);
    update({ ...doc, items: list });
    if (sel === key) setSel(list[Math.min(i, list.length - 1)]?.key ?? null);
  };

  const nudge = (x: EditItem, edge: "a" | "b", dt: number) => {
    const a = edge === "a" ? Math.max(x.lo, Math.min(x.start + dt, x.end - 1)) : x.start;
    const b = edge === "b" ? Math.min(x.hi, Math.max(x.end + dt, x.start + 1)) : x.end;
    setItem(x.key, { start: a, end: b });
    show({ ...x, start: a, end: b }, false, edge === "a" ? a : Math.max(a, b - 2));
  };

  const doExport = async () => {
    if (!doc || doc.items.length === 0) return;
    setErr(null);
    setExported(null);
    setProgress({ fraction: 0, part: 1, parts: doc.items.length });
    video.current?.pause();
    stopAll();
    const un = on<EditProgress>("edit-progress", setProgress);
    try {
      const path = await api.exportEdit(
        doc.items.map((i) => request(i, doc)),
        doc.opts,
      );
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

  const total = items.reduce((n, i) => n + outLen(i, doc.slow), 0);
  const raw = items.reduce((n, i) => n + (i.end - i.start), 0);
  const nMissing = items.filter((i) => missing.has(i.matchId)).length;
  const o = doc.opts;
  const setOpts = (p: Partial<EditOptions>) => update({ ...doc, opts: { ...o, ...p } });
  const busy = progress != null;

  return (
    <div className="page page-wide edit-page">
      <header className="page-head">
        <h1>{t("剪辑", "Edit")}</h1>
        {items.length > 0 && (
          <span className="count">
            {t(`${items.length} 段 · 成片 ${clock(total)}`, `${items.length} ${plural(items.length, "clip", "clips")} · ${clock(total)} total`)}
            {total - raw > 0.5 && <span className="faint">{t(`（含慢动作 +${Math.round(total - raw)} 秒）`, ` (slow motion +${Math.round(total - raw)}s)`)}</span>}
          </span>
        )}
        <span className="grow" />
        {items.length > 0 &&
          (confirmClear ? (
            <>
              <span className="muted small">{t("清空后片段要重新从录像库里加。", "You'll have to add the clips again from the library.")}</span>
              <Button small kind="ghost" onClick={() => setConfirmClear(false)}>
                {t("算了", "Cancel")}
              </Button>
              <Button
                small
                kind="danger"
                onClick={() => {
                  update({ ...doc, items: [] });
                  setSel(null);
                  setConfirmClear(false);
                }}
              >
                {t("确认清空", "Clear all")}
              </Button>
            </>
          ) : (
            <Button small kind="ghost" onClick={() => setConfirmClear(true)} disabled={busy}>
              <Trash2 size={14} /> {t("清空", "Clear")}
            </Button>
          ))}
      </header>

      {items.length === 0 ? (
        <div className="empty ed-empty">
          <Clapperboard size={28} />
          <p>
            {t(
              "把几局里的高光放到一起，排好顺序、剪好长短，导出成一个视频，不用再开别的剪辑软件。",
              "Put highlights from different matches together, order and trim them, and export one video. No other editor needed.",
            )}
          </p>
          <p className="muted small">
            {t("打开录像库里的一局，勾选高光后点「加入剪辑」。", "Open a match in the library, check the highlights you want and press \"Add to edit\".")}
          </p>
          <Button kind="primary" small onClick={props.openLibrary}>
            {t("去录像库", "Go to the library")}
          </Button>
        </div>
      ) : (
        <>
          <div className="ed-grid">
            <div className="player">
              <div className="player-frame ed-frame">
                {it && !missing.has(it.matchId) ? (
                  <>
                    <video
                      key={it.file}
                      ref={video}
                      data-file={it.file}
                      src={fileUrl(it.file)}
                      controls
                      onLoadedMetadata={(e) => {
                        const p = pending.current;
                        if (p) {
                          e.currentTarget.currentTime = p.local;
                          if (p.play) e.currentTarget.play().catch(() => {});
                          pending.current = null;
                        }
                      }}
                      onTimeUpdate={(e) => onTime(e.currentTarget)}
                      onPause={(e) => {
                        if (!e.currentTarget.seeking && e.currentTarget.playbackRate !== 1) e.currentTarget.playbackRate = 1;
                      }}
                    />
                    {caption && (
                      <div className={"ed-caption" + (o.aspect === "9:16" ? " is-vertical" : "")}>
                        <span>{caption}</span>
                      </div>
                    )}
                    {o.aspect === "9:16" && <div className="ed-crop" aria-hidden />}
                  </>
                ) : (
                  <div className="player-empty">{it ? t("这段所在的录像已经被删掉了", "This clip's recording has been deleted") : t("选一段", "Pick a clip")}</div>
                )}
              </div>

              <ol className="ed-strip" onDragOver={(e) => e.preventDefault()} title={t("拖动卡片可以调整顺序", "Drag the cards to reorder")}>
                {items.map((x, i) => (
                  <li
                    key={x.key}
                    draggable={!busy}
                    className={(drag === i ? "is-drag " : "") + (dropAt === i && drag !== null && drag !== i && drag !== i - 1 ? "is-drop" : "")}
                    onDragStart={(e) => {
                      setDrag(i);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onDragEnd={() => {
                      setDrag(null);
                      setDropAt(null);
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      const r = e.currentTarget.getBoundingClientRect();
                      setDropAt(e.clientX > r.left + r.width / 2 ? i + 1 : i);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (drag != null && dropAt != null) move(drag, dropAt);
                      setDrag(null);
                      setDropAt(null);
                    }}
                  >
                    <button type="button" className={"ed-card" + (x.key === sel ? " is-on" : "") + (missing.has(x.matchId) ? " is-missing" : "")} onClick={() => { stopAll(); setSel(x.key); }}>
                      <span className="ed-thumb">
                        {x.thumb && <img src={fileUrl(x.thumb)} alt="" loading="lazy" draggable={false} />}
                        <span className="ed-num">{i + 1}</span>
                        <span className="dur">{clock(outLen(x, doc.slow))}</span>
                      </span>
                      <span className="ed-card-title">{title(x.title)}</span>
                      <span className="ed-card-sub">{missing.has(x.matchId) ? t("录像已删除", "Recording deleted") : `${label(x.mapLabel)} · ${when(x.createdAtMs)}`}</span>
                    </button>
                  </li>
                ))}
                {dropAt === items.length && drag !== null && drag !== items.length - 1 && <li className="ed-drop-end" aria-hidden />}
              </ol>

              {it && (
                <div className="export ed-clip">
                  <div className="export-row">
                    <span className="trim-title">
                      <span className="ed-num">{idx + 1}</span>
                      {title(it.title)}
                      <span className="muted small">
                        {" "}
                        {label(it.mapLabel)} · {when(it.createdAtMs)}
                      </span>
                    </span>
                    <button type="button" className="link small" onClick={() => props.openMatch(it.matchId)} disabled={missing.has(it.matchId)}>
                      {t("打开这局", "Open match")}
                    </button>
                    <span className="grow" />
                    <button type="button" className="iconbtn sm" title={t("往前挪", "Move earlier")} disabled={idx === 0 || busy} onClick={() => move(idx, idx - 1)}>
                      <ArrowLeft size={15} />
                    </button>
                    <button type="button" className="iconbtn sm" title={t("往后挪", "Move later")} disabled={idx === items.length - 1 || busy} onClick={() => move(idx, idx + 2)}>
                      <ArrowRight size={15} />
                    </button>
                    <button type="button" className="iconbtn sm" title={t("从剪辑里移除", "Remove from the edit")} disabled={busy} onClick={() => remove(it.key)}>
                      <X size={15} />
                    </button>
                  </div>
                  <TrimBar
                    it={it}
                    slow={doc.slow}
                    captions={doc.captions}
                    pos={pos}
                    onDrag={(a, b, edge) => {
                      setItem(it.key, { start: Math.max(it.lo, a), end: Math.min(it.hi, b) }, false);
                      video.current?.pause();
                      stopAll();
                      show(it, false, edge === "a" ? a : b);
                    }}
                    onCommit={() => setDoc((d) => (d ? (saveEdit(d).catch(() => {}), d) : d))}
                    onSeek={(x) => show(it, false, x)}
                  />
                  <div className="export-row">
                    <span className="muted small">{t("开头", "Start")}</span>
                    <div className="nudge">
                      <button type="button" onClick={() => nudge(it, "a", -1)} title={t("开头提前 1 秒", "Start 1s earlier")}>−1s</button>
                      <button type="button" onClick={() => nudge(it, "a", 1)} title={t("开头推后 1 秒", "Start 1s later")}>+1s</button>
                    </div>
                    <span className="muted small">{t("结尾", "End")}</span>
                    <div className="nudge">
                      <button type="button" onClick={() => nudge(it, "b", -1)} title={t("结尾提前 1 秒", "End 1s earlier")}>−1s</button>
                      <button type="button" onClick={() => nudge(it, "b", 1)} title={t("结尾推后 1 秒", "End 1s later")}>+1s</button>
                    </div>
                    <span className="mono muted small">
                      {clock(it.start)} – {clock(it.end)} · {Math.round(it.end - it.start)}s
                    </span>
                    <span className="grow" />
                    <Button small onClick={() => { stopAll(); show(it, true); }} disabled={missing.has(it.matchId)}>
                      <Play size={14} /> {t("播放这段", "Play clip")}
                    </Button>
                    {playingAll ? (
                      <Button small onClick={() => { stopAll(); video.current?.pause(); }}>
                        <Square size={13} /> {t("停止", "Stop")}
                      </Button>
                    ) : (
                      <Button
                        small
                        onClick={() => {
                          const first = items.find((x) => !missing.has(x.matchId));
                          if (!first) return;
                          playAll.current = true;
                          setPlayingAll(true);
                          if (first.key === sel) show(first, true);
                          else setSel(first.key);
                        }}
                        disabled={nMissing === items.length}
                      >
                        <Play size={14} /> {t("从头预览", "Preview all")}
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </div>

            <aside className="ed-side">
              <section className="ed-box">
                <h3>{t("画面", "Picture")}</h3>
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
                    { value: 0, label: t("不限", "Any") },
                    { value: 25, label: "25MB" },
                    { value: 50, label: "50MB" },
                    { value: 100, label: "100MB" },
                  ]}
                />
                {o.sizeMb > 0 && <p className="muted small">{t("会自动降低分辨率和码率来压到这个大小以内，成片越长越模糊。", "Resolution and bitrate are lowered to fit; the longer the video, the blurrier.")}</p>}
              </section>

              <section className="ed-box">
                <h3>{t("效果", "Effects")}</h3>
                <div className="ed-fx">
                  <Toggle checked={doc.captions} onChange={(v) => update({ ...doc, captions: v })} label={t("击杀信息", "Kill captions")} />
                  <p className="muted small">{t("击倒、击杀时在画面下方显示对手、武器、距离和是否爆头。", "Shows the opponent, weapon, distance and headshots at the bottom of the picture on each knock and kill.")}</p>
                </div>
                <div className="ed-fx">
                  <span className="ed-fx-label">{t("慢动作", "Slow motion")}</span>
                  <Segmented
                    value={doc.slow}
                    onChange={(v) => update({ ...doc, slow: v })}
                    options={[
                      { value: "off", label: t("关", "Off") },
                      { value: "big", label: t("精彩瞬间", "Big moments") },
                      { value: "all", label: t("每次击杀", "Every kill") },
                    ]}
                  />
                  <p className="muted small">
                    {doc.slow === "all"
                      ? t("每次击杀前后约 1.5 秒放慢到一半速度。", "About 1.5 s around every kill plays at half speed.")
                      : t("爆头、100 米以上的击杀、多杀和抢龙，前后约 1.5 秒放慢到一半速度。", "Headshots, kills from 100 m+, multikills and steals: about 1.5 s around them plays at half speed.")}
                  </p>
                </div>
                <div className="ed-fx">
                  <Toggle checked={o.fps120 && o.sizeMb === 0} disabled={o.sizeMb > 0} onChange={(v) => setOpts({ fps120: v })} label={t("补帧到 120 帧", "Interpolate to 120 fps")} />
                  <p className={"small " + (o.fps120 && o.sizeMb === 0 ? "warn-text" : "muted")}>
                    {o.sizeMb > 0
                      ? t("限制大小时不能补帧。", "Not available with a size limit.")
                      : t(
                          "用 CPU 算出中间帧，画面和慢动作都更顺滑。非常慢：1 分钟的成片可能要算半小时以上，期间电脑会比较卡，建议打完游戏再导。",
                          "Works out in-between frames on the CPU, for smoother motion and slow motion. Very slow: a 1-minute video can take half an hour or more and keeps the PC busy, so export when you're done playing.",
                        )}
                  </p>
                </div>
              </section>

              <section className="ed-box">
                {busy ? (
                  <>
                    <div className="ed-prog">
                      <div className="ed-prog-bar" style={{ width: `${Math.round(progress.fraction * 100)}%` }} />
                    </div>
                    <div className="export-row">
                      <span className="muted small">
                        {progress.part > 0
                          ? t(`正在处理第 ${progress.part} / ${progress.parts} 段`, `Clip ${progress.part} of ${progress.parts}`)
                          : t("正在合成", "Joining")}{" "}
                        · {Math.round(progress.fraction * 100)}%
                      </span>
                      <span className="grow" />
                      <Button small kind="ghost" onClick={() => api.cancelEdit()}>
                        {t("取消", "Cancel")}
                      </Button>
                    </div>
                  </>
                ) : (
                  <Button kind="primary" onClick={doExport} disabled={nMissing > 0}>
                    <Download size={15} /> {t("导出视频", "Export video")}
                  </Button>
                )}
                {nMissing > 0 && (
                  <p className="warn-text small">
                    {t(`有 ${nMissing} 段的录像已经不在了，先把它们移除。`, `${nMissing} ${plural(nMissing, "clip's recording is", "clips' recordings are")} gone; remove ${plural(nMissing, "it", "them")} first.`)}
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
                {err && <p className="warn-text small">{err}</p>}
              </section>
            </aside>
          </div>

        </>
      )}
    </div>
  );
}
