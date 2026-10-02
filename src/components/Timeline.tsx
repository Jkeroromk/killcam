import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { Minus, Plus, Scan } from "lucide-react";
import type { EventKind } from "../lib/api";
import { KIND_LABEL, clock } from "../lib/format";
import { KindIcon } from "./ui";

type Ev = { id?: string; t: number; kind: EventKind };
type Hl = { id: string; start: number; end: number };

/** which icon represents a group of pins that sit too close together */
const RANK: Record<EventKind, number> = { win: 6, kill: 5, knock: 4, knocked: 3, death: 3, manual: 1 };
/** px a pin needs before the next one gets merged into it */
const PIN = 26;
const RULER_STEPS = [5, 10, 15, 30, 60, 120, 300, 600];

interface Cluster {
  x0: number;
  x1: number;
  t0: number;
  t1: number;
  items: Ev[];
  top: Ev;
}

function summary(items: Ev[]): string {
  const n = new Map<EventKind, number>();
  for (const e of items) n.set(e.kind, (n.get(e.kind) ?? 0) + 1);
  return [...n.entries()]
    .sort((a, b) => RANK[b[0]] - RANK[a[0]])
    .map(([k, c]) => `${c} ${KIND_LABEL[k]}`)
    .join(" · ");
}

/**
 * Match timeline with wheel zoom. Pins that would overlap at the current zoom
 * are merged into one pin with a count; clicking it zooms in on that stretch.
 */
export function Timeline(props: {
  duration: number;
  events: Ev[];
  highlights: Hl[];
  activeHighlight: string | null;
  playhead: number;
  onSeek: (t: number) => void;
  footer?: ReactNode;
  /** handles to trim the active highlight */
  trim?: {
    start: number;
    end: number;
    lo: number;
    hi: number;
    /** while dragging (to preview the frame under the handle) */
    onDrag?: (t: number) => void;
    onCommit: (start: number, end: number) => void;
  } | null;
}) {
  const d = Math.max(props.duration, 1);
  const view = useRef<HTMLDivElement>(null);
  const [vw, setVw] = useState(800);
  const [z, setZ] = useState(1);
  const [sl, setSl] = useState(0);
  const zRef = useRef(1);
  zRef.current = z;
  const pendingScroll = useRef<number | null>(null);
  const userAt = useRef(0);
  const [drag, setDrag] = useState<{ edge: "a" | "b"; start: number; end: number } | null>(null);
  const trimRef = useRef(props.trim);
  trimRef.current = props.trim;
  const maxZ = Math.max(1, Math.min(64, d / 15));
  const W = vw * z;
  const x = (t: number) => (Math.max(0, Math.min(d, t)) / d) * W;

  useLayoutEffect(() => {
    const el = view.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setVw(el.clientWidth || 800));
    ro.observe(el);
    setVw(el.clientWidth || 800);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (pendingScroll.current != null && view.current) {
      view.current.scrollLeft = pendingScroll.current;
      pendingScroll.current = null;
      setSl(view.current.scrollLeft);
    }
  }, [z, vw]);

  /** zoom to `nz`, keeping time `t` under view pixel `px` */
  const zoomAt = useCallback(
    (nz: number, t: number, px: number) => {
      const el = view.current;
      if (!el) return;
      const clamped = Math.max(1, Math.min(maxZ, nz));
      const target = (t / d) * el.clientWidth * clamped - px;
      if (Math.abs(clamped - zRef.current) < 1e-3) {
        el.scrollLeft = target;
        return;
      }
      pendingScroll.current = target;
      setZ(clamped);
    },
    [d, maxZ],
  );

  // wheel = zoom at the cursor, shift+wheel = pan (needs a non-passive listener)
  useEffect(() => {
    const el = view.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault();
      userAt.current = Date.now();
      if (e.shiftKey) {
        el.scrollLeft += e.deltaY;
        return;
      }
      const px = e.clientX - el.getBoundingClientRect().left;
      const t = ((el.scrollLeft + px) / (el.clientWidth * zRef.current)) * d;
      zoomAt(zRef.current * Math.exp(-e.deltaY * 0.002), t, px);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [d, zoomAt]);

  // keep the playhead in view while playing, unless the user just moved the view
  useEffect(() => {
    const el = view.current;
    if (!el || z <= 1 || Date.now() - userAt.current < 4000) return;
    const px = x(props.playhead);
    if (px < el.scrollLeft || px > el.scrollLeft + el.clientWidth - 12) {
      el.scrollLeft = px - el.clientWidth * 0.15;
    }
  }, [props.playhead]);

  // bring the selected highlight into view
  useEffect(() => {
    const el = view.current;
    const h = props.highlights.find((h) => h.id === props.activeHighlight);
    if (!el || !h || z <= 1) return;
    const a = x(h.start);
    const b = x(h.end);
    if (a < el.scrollLeft || b > el.scrollLeft + el.clientWidth) {
      el.scrollLeft = (a + b) / 2 - el.clientWidth / 2;
    }
  }, [props.activeHighlight]);

  const clusters = useMemo(() => {
    const out: Cluster[] = [];
    for (const e of [...props.events].sort((a, b) => a.t - b.t)) {
      const px = x(e.t);
      const last = out[out.length - 1];
      if (last && px - last.x1 < PIN) {
        last.items.push(e);
        last.x1 = px;
        last.t1 = e.t;
        if (RANK[e.kind] > RANK[last.top.kind]) last.top = e;
      } else {
        out.push({ x0: px, x1: px, t0: e.t, t1: e.t, items: [e], top: e });
      }
    }
    return out;
  }, [props.events, W, d]);

  const ruler = useMemo(() => {
    const step = RULER_STEPS.find((s) => (s / d) * W >= 72) ?? 1200;
    const from = Math.max(0, Math.floor(((sl - vw) / W) * d / step) * step);
    const to = Math.min(d, ((sl + 2 * vw) / W) * d);
    const marks: number[] = [];
    for (let t = from; t <= to; t += step) marks.push(t);
    return marks;
  }, [sl, vw, W, d]);

  const seekAt = (clientX: number) => {
    const el = view.current;
    if (!el) return;
    const t = ((el.scrollLeft + clientX - el.getBoundingClientRect().left) / W) * d;
    props.onSeek(Math.max(0, Math.min(d, t)));
  };

  const openCluster = (c: Cluster) => {
    const el = view.current;
    if (!el) return;
    userAt.current = Date.now();
    if (c.items.length === 1 || zRef.current >= maxZ - 1e-3) {
      props.onSeek(Math.max(0, c.t0 - 3));
      return;
    }
    // fit the group into half the view
    const span = Math.max(c.t1 - c.t0, 1);
    const nz = Math.max(zRef.current * 1.5, (0.5 * d) / span);
    zoomAt(nz, (c.t0 + c.t1) / 2, el.clientWidth / 2);
  };

  const zoomButton = (factor: number) => {
    const el = view.current;
    if (!el) return;
    userAt.current = Date.now();
    const ph = x(props.playhead) - el.scrollLeft;
    const anchor = ph >= 0 && ph <= el.clientWidth ? ph : el.clientWidth / 2;
    const t = ((el.scrollLeft + anchor) / W) * d;
    zoomAt(zRef.current * factor, t, anchor);
  };

  const timeAt = (clientX: number) => {
    const el = view.current;
    if (!el) return 0;
    return ((el.scrollLeft + clientX - el.getBoundingClientRect().left) / (el.clientWidth * zRef.current)) * d;
  };

  const startTrim = (edge: "a" | "b", e: ReactMouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const tr = trimRef.current;
    if (!tr) return;
    userAt.current = Date.now();
    let cur = { edge, start: tr.start, end: tr.end };
    setDrag(cur);
    const move = (ev: MouseEvent) => {
      const t = trimRef.current;
      if (!t) return;
      const g = timeAt(ev.clientX);
      cur =
        edge === "a"
          ? { ...cur, start: Math.max(t.lo, Math.min(g, cur.end - 1)) }
          : { ...cur, end: Math.min(t.hi, Math.max(g, cur.start + 1)) };
      setDrag(cur);
      t.onDrag?.(edge === "a" ? cur.start : cur.end);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setDrag(null);
      const t = trimRef.current;
      if (t && (Math.abs(cur.start - t.start) > 0.04 || Math.abs(cur.end - t.end) > 0.04)) {
        t.onCommit(cur.start, cur.end);
      }
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const ts = drag ? drag.start : props.trim?.start;
  const te = drag ? drag.end : props.trim?.end;

  return (
    <div className="tl">
      <div
        className="tl-view"
        ref={view}
        onScroll={(e) => setSl(e.currentTarget.scrollLeft)}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) userAt.current = Date.now();
        }}
      >
        <div
          className="tl-inner"
          style={{ width: W }}
          onMouseDown={(e) => seekAt(e.clientX)}
          onMouseMove={(e) => e.buttons === 1 && seekAt(e.clientX)}
        >
          {ruler.map((t) => (
            <span key={t} className="tl-mark" style={{ left: x(t) }}>
              <i />
              {clock(t)}
            </span>
          ))}
          <div className="tl-rail" />
          {props.highlights.map((h) => {
            const on = props.activeHighlight === h.id;
            const a = on && ts != null ? ts : h.start;
            const b = on && te != null ? te : h.end;
            return <div key={h.id} className={"tl-hl" + (on ? " is-active" : "")} style={{ left: x(a), width: Math.max(2, x(b) - x(a)) }} />;
          })}
          {props.trim && ts != null && te != null && (
            <>
              <div className="tl-trim-band" style={{ left: x(ts), width: Math.max(2, x(te) - x(ts)) }} />
              <span
                className={"tl-handle is-a" + (drag?.edge === "a" ? " is-drag" : "")}
                style={{ left: x(ts) }}
                title="拖动调整开头"
                onMouseDown={(e) => startTrim("a", e)}
              >
                {drag?.edge === "a" && <b className="tl-handle-time">{clock(ts)}</b>}
              </span>
              <span
                className={"tl-handle is-b" + (drag?.edge === "b" ? " is-drag" : "")}
                style={{ left: x(te) }}
                title="拖动调整结尾"
                onMouseDown={(e) => startTrim("b", e)}
              >
                {drag?.edge === "b" && <b className="tl-handle-time">{clock(te)}</b>}
              </span>
            </>
          )}
          {props.events.map((e, i) => (
            <span key={e.id ?? i} className={`tl-tick k-${e.kind}`} style={{ left: x(e.t) }} />
          ))}
          {clusters.map((c) => (
            <button
              key={`${c.t0}-${c.items.length}`}
              type="button"
              className={`tl-pin k-${c.top.kind}` + (c.items.length > 1 ? " is-group" : "")}
              style={{ left: (c.x0 + c.x1) / 2 }}
              title={`${clock(c.t0)}  ${summary(c.items)}` + (c.items.length > 1 ? "\n点击放大" : "")}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => openCluster(c)}
            >
              {c.items.length > 1 && <span className="tl-span" style={{ width: c.x1 - c.x0 }} />}
              <KindIcon kind={c.top.kind} />
              {c.items.length > 1 && <b className="tl-count">{c.items.length}</b>}
            </button>
          ))}
          <div className="tl-head" style={{ left: x(props.playhead) }} />
        </div>
      </div>
      <div className="tl-foot">
        {props.footer}
        <span className="grow" />
        <div className="tl-zoom">
          <button type="button" className="iconbtn sm" title="缩小" onClick={() => zoomButton(1 / 1.6)} disabled={z <= 1}>
            <Minus size={15} />
          </button>
          <span className="mono tl-z">{z < 10 ? z.toFixed(1) : Math.round(z)}×</span>
          <button type="button" className="iconbtn sm" title="放大（也可以在时间轴上滚动滚轮）" onClick={() => zoomButton(1.6)} disabled={z >= maxZ}>
            <Plus size={15} />
          </button>
          <button type="button" className="iconbtn sm" title="显示整局" onClick={() => zoomAt(1, 0, 0)} disabled={z <= 1}>
            <Scan size={15} />
          </button>
        </div>
        <span className="mono tl-time">
          {clock(props.playhead)} / {clock(d)}
        </span>
      </div>
    </div>
  );
}
