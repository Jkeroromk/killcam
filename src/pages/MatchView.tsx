import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ChevronDown, ChevronRight, Download, FolderOpen, Play, Star, Trash2, Scissors, Layers, RotateCcw } from "lucide-react";
import { api, errText, fileUrl, highlightBounds, joinPath, type ExportOptions, type Highlight, type MatchRecord } from "../lib/api";
import { KIND_LABEL, bytes, clock, eventLine, when } from "../lib/format";
import { Button, KindIcon, Segmented, Spinner } from "../components/ui";
import { Timeline } from "../components/Timeline";

export default function MatchView(props: { id: string; back: () => void; libVersion?: number }) {
  const [m, setM] = useState<MatchRecord | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [t, setT] = useState(0);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [opts, setOpts] = useState<ExportOptions>({ aspect: "source", height: 1080, audio: "mix", sizeMb: 0 });
  const [range, setRange] = useState<{ a: number | null; b: number | null }>({ a: null, b: null });
  const [exporting, setExporting] = useState<string | null>(null);
  const [exported, setExported] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showEvents, setShowEvents] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const stopAt = useRef<number | null>(null);
  const pendingSeek = useRef<{ local: number; play: boolean } | null>(null);

  useEffect(() => {
    api
      .getMatch(props.id)
      .then((r) => {
        setM(r);
        setPicked(new Set(r.highlights.map((h) => h.id)));
        if (r.highlights.length) setActive(r.highlights[0].id);
        // older records: make the missing highlight stills in the background
        if (r.highlights.some((h) => !h.thumb)) {
          api
            .ensureThumbs(r.id)
            .then((u) => setM((cur) => (cur && cur.id === u.id ? { ...cur, highlights: u.highlights } : cur)))
            .catch(() => {});
        }
      })
      .catch((e) => setErr(errText(e)));
  }, [props.id]);

  // a quick record gets replaced when PUBG's match data arrives: show the new one
  useEffect(() => {
    if (!m?.pendingApi) return;
    api
      .getMatch(props.id)
      .then((r) => {
        if (r.pendingApi) return;
        setM(r);
        setPicked(new Set(r.highlights.map((h) => h.id)));
        setActive(r.highlights[0]?.id ?? null);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.libVersion]);

  const clipsOnly = !!m && !m.video;
  const activeH = useMemo(() => m?.highlights.find((h) => h.id === active) ?? null, [m, active]);

  const src = useMemo(() => {
    if (!m) return null;
    if (m.video) return fileUrl(joinPath(m.dir, m.video));
    if (activeH?.file) return fileUrl(joinPath(m.dir, activeH.file));
    return null;
  }, [m, activeH]);

  const clipBase = (h: Highlight) => h.fileStart ?? h.start;
  const base = clipsOnly && activeH ? clipBase(activeH) : 0;

  const seekGlobal = (g: number, play = false, h?: Highlight | null) => {
    if (!m) return;
    if (clipsOnly) {
      const target = h ?? m.highlights.find((x) => x.file && g >= x.start && g <= x.end) ?? null;
      if (!target) return;
      if (target.id !== active) {
        pendingSeek.current = { local: g - clipBase(target), play };
        setActive(target.id);
        return;
      }
      if (video.current) {
        video.current.currentTime = Math.max(0, g - clipBase(target));
        if (play) video.current.play().catch(() => {});
      }
      return;
    }
    if (video.current) {
      video.current.currentTime = Math.max(0, g);
      if (play) video.current.play().catch(() => {});
    }
  };

  const playHighlight = (h: Highlight) => {
    setActive(h.id);
    stopAt.current = clipsOnly ? null : h.end;
    seekGlobal(h.start, true, h);
  };

  // keyboard: space, arrows
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      const v = video.current;
      if (!v) return;
      if (e.code === "Space") {
        e.preventDefault();
        if (v.paused) v.play().catch(() => {});
        else v.pause();
      } else if (e.code === "ArrowLeft") {
        v.currentTime = Math.max(0, v.currentTime - 5);
      } else if (e.code === "ArrowRight") {
        v.currentTime = v.currentTime + 5;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const trim = async (h: Highlight, a: number | null, b: number | null) => {
    if (!m) return;
    try {
      const u = await api.trimHighlight(m.id, h.id, a, b);
      setM((cur) => (cur && cur.id === u.id ? { ...cur, highlights: u.highlights } : cur));
    } catch (e) {
      setErr(errText(e));
    }
  };

  const nudge = (h: Highlight, edge: "a" | "b", dt: number) => {
    if (!m) return;
    const [lo, hi] = highlightBounds(m, h);
    const a = edge === "a" ? Math.max(lo, Math.min(h.start + dt, h.end - 1)) : h.start;
    const b = edge === "b" ? Math.min(hi, Math.max(h.end + dt, h.start + 1)) : h.end;
    trim(h, a, b);
    seekGlobal(edge === "a" ? a : Math.max(a, b - 2), false, h);
  };

  const doExport = async (what: "highlight" | "montage" | "range") => {
    if (!m) return;
    setExported(null);
    setErr(null);
    try {
      let path: string;
      if (what === "highlight" && activeH) {
        setExporting(`正在导出「${activeH.title}」`);
        path = await api.exportClip(m.id, activeH.start, activeH.end, activeH.title, opts);
      } else if (what === "montage") {
        setExporting(`正在导出 ${picked.size} 段高光合集`);
        path = await api.exportMontage(m.id, m.highlights.filter((h) => picked.has(h.id)).map((h) => h.id), opts);
      } else {
        const a = Math.min(range.a ?? 0, range.b ?? 0);
        const b = Math.max(range.a ?? 0, range.b ?? 0);
        setExporting("正在导出选定区间");
        path = await api.exportClip(m.id, a, b, "片段", opts);
      }
      setExported(path);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setExporting(null);
    }
  };

  if (err && !m) {
    return (
      <div className="page">
        <Button kind="ghost" small onClick={props.back}>
          <ArrowLeft size={16} /> 返回
        </Button>
        <p className="warn-text">{err}</p>
      </div>
    );
  }
  if (!m) return <div className="page"><Spinner /></div>;

  const st = m.stats;
  const hasRange = range.a != null && range.b != null && Math.abs((range.b ?? 0) - (range.a ?? 0)) >= 1;

  const thumbOf = (h: Highlight) => (h.thumb ? fileUrl(joinPath(m.thumbDir, h.thumb)) : m.thumbnail ? fileUrl(joinPath(m.thumbDir, m.thumbnail)) : null);

  return (
    <div className="page match">
      <header className="match-head">
        <button type="button" className="iconbtn" onClick={props.back} title="返回">
          <ArrowLeft size={18} />
        </button>
        <div className="match-title">
          <h1>
            {m.mapLabel}
            {m.gameMode && <span className="tag">{m.gameMode}</span>}
            {st && st.place > 0 && <span className={"place" + (st.place === 1 ? " is-win" : "")}>#{st.place}</span>}
          </h1>
          <span className="muted small">
            {when(m.createdAtMs)} · {clock(m.durationS)} · {bytes(m.sizeBytes)}
          </span>
        </div>
        <span className="grow" />
        {m.pendingApi && (
          <p className="pending-note">
            高光是读屏先剪好的。PUBG 官方数据到了以后（一般几分钟），会自动补上地图、排名、伤害和每次击杀的武器距离，高光也会按官方数据重新剪一次。
          </p>
        )}
        {st && (
          <div className="match-stats">
            <div className="mstat">
              <b>{st.kills}</b>
              <span>击杀</span>
            </div>
            <div className="mstat">
              <b>{st.knocks}</b>
              <span>击倒</span>
            </div>
            <div className="mstat">
              <b>{Math.round(st.damage)}</b>
              <span>伤害</span>
            </div>
            <div className="mstat">
              <b>{st.headshots}</b>
              <span>爆头</span>
            </div>
            {st.longestKill > 0 && (
              <div className="mstat">
                <b>{Math.round(st.longestKill)}m</b>
                <span>最远击杀</span>
              </div>
            )}
          </div>
        )}
        <button
          type="button"
          className={"iconbtn" + (m.favorite ? " is-on" : "")}
          title={m.favorite ? "取消收藏" : "收藏（不会被自动清理）"}
          onClick={async () => {
            await api.setFavorite(m.id, !m.favorite);
            setM({ ...m, favorite: !m.favorite });
          }}
        >
          <Star size={17} fill={m.favorite ? "currentColor" : "none"} />
        </button>
        <button type="button" className="iconbtn" onClick={() => api.reveal(m.dir)} title="打开文件夹">
          <FolderOpen size={17} />
        </button>
        {confirmDelete ? (
          <Button
            kind="danger"
            small
            onClick={async () => {
              await api.deleteMatch(m.id);
              props.back();
            }}
          >
            确认删除
          </Button>
        ) : (
          <button type="button" className="iconbtn" onClick={() => setConfirmDelete(true)} title="删除这场录像">
            <Trash2 size={17} />
          </button>
        )}
      </header>

      <div className="match-grid">
        <div className="player">
          <div className="player-frame">
            {src ? (
              <video
                ref={video}
                src={src}
                controls
                onLoadedMetadata={() => {
                  const p = pendingSeek.current;
                  if (p && video.current) {
                    video.current.currentTime = p.local;
                    if (p.play) video.current.play().catch(() => {});
                    pendingSeek.current = null;
                  }
                }}
                onTimeUpdate={(e) => {
                  const g = base + e.currentTarget.currentTime;
                  setT(g);
                  if (stopAt.current != null && g >= stopAt.current) {
                    e.currentTarget.pause();
                    stopAt.current = null;
                  }
                }}
                onSeeking={() => {
                  // a manual seek outside the highlight cancels auto-stop
                  const v = video.current;
                  if (v && stopAt.current != null && activeH && (base + v.currentTime < activeH.start - 1 || base + v.currentTime > activeH.end)) {
                    stopAt.current = null;
                  }
                }}
              />
            ) : (
              <div className="player-empty">
                {m.highlights.some((h) => h.file) ? "选一段右边的高光播放" : "这场的录像没有保留下来（当时没有生成任何高光，整局录像按「只留高光片段」被删掉了）"}
              </div>
            )}
          </div>

          <Timeline
            duration={m.durationS}
            events={m.events}
            highlights={m.highlights}
            activeHighlight={active}
            playhead={t}
            onSeek={(g) => seekGlobal(g)}
            trim={
              activeH
                ? {
                    start: activeH.start,
                    end: activeH.end,
                    lo: highlightBounds(m, activeH)[0],
                    hi: highlightBounds(m, activeH)[1],
                    onDrag: (g) => {
                      video.current?.pause();
                      stopAt.current = null;
                      seekGlobal(g, false, activeH);
                    },
                    onCommit: (a, b) => trim(activeH, a, b),
                  }
                : null
            }
            footer={
              <div className="tape-legend">
                {(["kill", "knock", "win", "manual", "death"] as const).map((k) => (
                  <span key={k}>
                    <KindIcon kind={k} small /> {KIND_LABEL[k]}
                  </span>
                ))}
              </div>
            }
          />

          <div className="export">
            {activeH && (
              <div className="export-row trim-row">
                <span className="trim-title">
                  {activeH.title}
                  <span className="mono muted">
                    {" "}
                    {clock(activeH.start)} – {clock(activeH.end)} · {Math.round(activeH.end - activeH.start)}s
                  </span>
                </span>
                <span className="grow" />
                <span className="muted small">开头</span>
                <div className="nudge">
                  <button type="button" onClick={() => nudge(activeH, "a", -1)} title="开头提前 1 秒">−1s</button>
                  <button type="button" onClick={() => nudge(activeH, "a", 1)} title="开头推后 1 秒">+1s</button>
                </div>
                <span className="muted small">结尾</span>
                <div className="nudge">
                  <button type="button" onClick={() => nudge(activeH, "b", -1)} title="结尾提前 1 秒">−1s</button>
                  <button type="button" onClick={() => nudge(activeH, "b", 1)} title="结尾推后 1 秒">+1s</button>
                </div>
                {activeH.origStart != null && (Math.abs(activeH.origStart - activeH.start) > 0.05 || Math.abs((activeH.origEnd ?? activeH.end) - activeH.end) > 0.05) && (
                  <button type="button" className="iconbtn sm" title="恢复原来的范围" onClick={() => trim(activeH, null, null)}>
                    <RotateCcw size={14} />
                  </button>
                )}
              </div>
            )}
            <div className="export-row">
              <Segmented
                value={opts.aspect}
                onChange={(a) => setOpts({ ...opts, aspect: a, height: a === "9:16" ? 1080 : opts.height })}
                options={[
                  { value: "source", label: "原比例" },
                  { value: "16:9", label: "16:9" },
                  { value: "9:16", label: "竖屏" },
                ]}
              />
              <Segmented
                value={opts.height}
                onChange={(h) => setOpts({ ...opts, height: h })}
                options={[
                  { value: 0, label: "原始" },
                  { value: 1080, label: "1080p" },
                  { value: 720, label: "720p" },
                ]}
              />
              <Segmented
                value={opts.sizeMb > 0 ? "mix" : opts.audio}
                onChange={(a) => setOpts({ ...opts, audio: a })}
                options={[
                  { value: "mix", label: "混音" },
                  { value: "all", label: "分轨", disabled: opts.sizeMb > 0 },
                ]}
              />
              <Segmented
                value={opts.sizeMb}
                onChange={(n) => setOpts({ ...opts, sizeMb: n })}
                options={[
                  { value: 0, label: "不限大小" },
                  { value: 10, label: "10MB" },
                  { value: 25, label: "25MB" },
                  { value: 50, label: "50MB" },
                ]}
              />
              <span className="grow" />
              <Button kind="primary" small onClick={() => doExport("highlight")} disabled={!activeH || !!exporting}>
                <Download size={14} /> 导出这段
              </Button>
              <Button small onClick={() => doExport("montage")} disabled={picked.size === 0 || !!exporting}>
                <Layers size={14} /> 合集 · {picked.size}
              </Button>
            </div>
            {opts.sizeMb > 0 && (
              <p className="muted small">
                {opts.sizeMb === 10 ? "10MB 是 Discord 免费用户的上限。" : opts.sizeMb === 25 ? "25MB 适合大多数聊天软件，画质好一些。" : "50MB 适合 Discord Nitro Basic。"}
                会自动降低分辨率和帧率来压到这个大小以内，片段越长越模糊，建议 30 秒以内。
              </p>
            )}
            {!clipsOnly && (
              <div className="export-row">
                <span className="muted small">自选区间</span>
                <Button small kind="ghost" onClick={() => setRange({ ...range, a: t })}>
                  起点 {range.a != null ? clock(range.a) : "–"}
                </Button>
                <Button small kind="ghost" onClick={() => setRange({ ...range, b: t })}>
                  终点 {range.b != null ? clock(range.b) : "–"}
                </Button>
                <Button small kind="ghost" onClick={() => doExport("range")} disabled={!hasRange || !!exporting}>
                  <Scissors size={14} /> 导出区间
                </Button>
              </div>
            )}
            {exporting && (
              <p className="muted small loading-row">
                <Spinner /> {exporting}…
              </p>
            )}
            {exported && (
              <p className="ok-text small">
                已导出 <span className="mono">{exported.split(/[\\/]/).pop()}</span>
                <button type="button" className="link" onClick={() => api.reveal(exported)}>
                  在文件夹中显示
                </button>
              </p>
            )}
            {err && <p className="warn-text">{err}</p>}
          </div>
        </div>

        <aside className="side">
          <div className="side-head">
            高光 · {m.highlights.length}
            <span className="grow" />
            <span className="faint small">勾选的进合集</span>
          </div>
          {m.highlights.length === 0 && (
            <p className="muted small">{m.video ? "这局没有符合规则的高光，可以在左边自选区间导出。" : "没有高光，也没有保留整局录像，这条记录可以删掉。"}</p>
          )}
          <ul className="hl-list">
            {m.highlights.map((h) => {
              const th = thumbOf(h);
              return (
                <li key={h.id}>
                  <div className={"hl" + (h.id === active ? " is-active" : "")} role="button" tabIndex={0} onClick={() => playHighlight(h)} onKeyDown={(e) => e.key === "Enter" && playHighlight(h)}>
                    <div className="hl-thumb">
                      {th && <img src={th} alt="" loading="lazy" />}
                      <span className="dur">{Math.round(h.end - h.start)}s</span>
                      <span className="play">
                        <Play size={20} fill="currentColor" />
                      </span>
                    </div>
                    <div className="hl-info">
                      <span className="hl-title">{h.title}</span>
                      <span className="hl-kinds">
                        {h.kinds.slice(0, 8).map((k, i) => (
                          <KindIcon key={i} kind={k} small />
                        ))}
                      </span>
                      <span className="hl-time">{clock(h.start)}</span>
                    </div>
                    <input
                      className="hl-pick"
                      type="checkbox"
                      checked={picked.has(h.id)}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => {
                        const n = new Set(picked);
                        if (e.target.checked) n.add(h.id);
                        else n.delete(h.id);
                        setPicked(n);
                      }}
                      title="加入合集"
                    />
                  </div>
                </li>
              );
            })}
          </ul>

          <button type="button" className="collapse" onClick={() => setShowEvents(!showEvents)}>
            {showEvents ? <ChevronDown size={14} /> : <ChevronRight size={14} />} 全部事件 · {m.events.length}
          </button>
          {showEvents && (
            <ul className="ev-list">
              {m.events.map((e) => (
                <li key={e.id}>
                  <button type="button" onClick={() => seekGlobal(Math.max(0, e.t - 3), true)} disabled={clipsOnly && !m.highlights.some((h) => h.file && e.t >= h.start && e.t <= h.end)}>
                    <KindIcon kind={e.kind} small />
                    <span className="ev-kind">{KIND_LABEL[e.kind]}</span>
                    <span className="ev-detail">{eventLine(e)}</span>
                    <span className="ev-time mono">{clock(e.t)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </div>
  );
}
