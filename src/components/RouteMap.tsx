import { useEffect, useMemo, useState } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { api, errText, fileUrl, type MatchRecord, type RouteMark, type RouteView } from "../lib/api";
import { clock } from "../lib/format";
import { label, t } from "../lib/i18n";
import { Spinner } from "./ui";

const KIND: Record<string, () => string> = {
  knock: () => t("击倒", "Knock"),
  kill: () => t("击杀", "Kill"),
  knocked: () => t("被击倒", "Knocked"),
  death: () => t("阵亡", "Death"),
};

/** The record's video time for a moment on the map (its event, else by the clock). */
function videoTime(m: MatchRecord, kind: string, ms: number): number {
  let best: { t: number; d: number } | null = null;
  for (const e of m.events) {
    if (e.kind !== kind) continue;
    const d = Math.abs(e.wallMs - ms);
    if (d < 5_000 && (!best || d < best.d)) best = { t: e.t, d };
  }
  return best ? best.t : Math.max(0, (ms - m.videoStartMs) / 1000);
}

/** Where the player was at `ms`, between two route points. */
function whereAt(r: RouteView["route"], ms: number): { x: number; y: number } | null {
  const p = r.path;
  if (p.length === 0 || ms < p[0].ms || ms > p[p.length - 1].ms + 15_000) return null;
  for (let i = 1; i < p.length; i++) {
    if (p[i].ms >= ms) {
      const a = p[i - 1];
      const b = p[i];
      const f = b.ms > a.ms ? (ms - a.ms) / (b.ms - a.ms) : 0;
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
    }
  }
  return p[p.length - 1];
}

function Marker(props: { mark: RouteMark; on: boolean; onClick: () => void; onHover: (h: boolean) => void }) {
  const { mark: k } = props;
  const x = k.at.x * 1000;
  const y = k.at.y * 1000;
  const common = {
    className: "rm-mark" + (props.on ? " is-on" : ""),
    onClick: props.onClick,
    onMouseEnter: () => props.onHover(true),
    onMouseLeave: () => props.onHover(false),
  };
  if (k.kind === "kill") return <circle {...common} cx={x} cy={y} r={9} data-kind="kill" />;
  if (k.kind === "knock") return <circle {...common} cx={x} cy={y} r={8} data-kind="knock" />;
  if (k.kind === "knocked") return <rect {...common} x={x - 7} y={y - 7} width={14} height={14} data-kind="knocked" />;
  // death: an X
  return (
    <g {...common} data-kind="death">
      <circle cx={x} cy={y} r={12} className="rm-hit" />
      <path d={`M${x - 8} ${y - 8} L${x + 8} ${y + 8} M${x + 8} ${y - 8} L${x - 8} ${y + 8}`} />
    </g>
  );
}

/** A PUBG match on the map: landing, route, knocks, kills, death. `pos` is the
 *  video time being played (the dot), `seek` jumps the video to a moment. */
export function RouteMap(props: { m: MatchRecord; pos: number; seek: (t: number) => void }) {
  const { m } = props;
  const [view, setView] = useState<RouteView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [whole, setWhole] = useState(false);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    setView(null);
    setErr(null);
    api
      .matchRoute(m.id)
      .then((v) => live && setView(v))
      .catch((e) => live && setErr(errText(e)));
    return () => {
      live = false;
    };
  }, [m.id]);

  const r = view?.route;
  // zoomed onto where the player was (all of the map when asked, or nothing to frame)
  const box = useMemo(() => {
    if (!r || whole) return { x: 0, y: 0, s: 1000 };
    const pts = [...r.path, ...r.marks.map((k) => k.at), ...(r.landing ? [r.landing] : [])];
    if (pts.length === 0) return { x: 0, y: 0, s: 1000 };
    const xs = pts.map((p) => p.x * 1000);
    const ys = pts.map((p) => p.y * 1000);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const s = Math.min(1000, Math.max(180, Math.max(x1 - x0, y1 - y0) * 1.25));
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    return { x: Math.min(1000 - s, Math.max(0, cx - s / 2)), y: Math.min(1000 - s, Math.max(0, cy - s / 2)), s };
  }, [r, whole]);

  const now = r ? whereAt(r, m.videoStartMs + props.pos * 1000) : null;
  const marks = r ? [...r.marks].sort((a, b) => a.at.ms - b.at.ms) : [];
  const startMs = r?.landing?.ms ?? r?.path[0]?.ms ?? m.videoStartMs;
  // marker / line widths stay the same on screen whatever the zoom
  const k = box.s / 1000;

  return (
    <section className="route-card">
      <header className="side-head">
        {t("路线和击杀", "Route and fights")}
        <span className="grow" />
        {r && (
          <button type="button" className="icon-btn" onClick={() => setWhole(!whole)} title={whole ? t("放大到路线", "Zoom to the route") : t("看整张地图", "Whole map")}>
            {whole ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
        )}
      </header>
      {err ? (
        <p className="muted small">{err}</p>
      ) : !view ? (
        <div className="route-wait">
          <Spinner /> <span className="muted small">{t("正在读取这局的路线…", "Loading this match's route…")}</span>
        </div>
      ) : (
        <div className="route-body">
          <div className="route-map">
            <svg viewBox={`${box.x} ${box.y} ${box.s} ${box.s}`} preserveAspectRatio="xMidYMid meet" style={{ ["--k" as string]: k }}>
              {view.image ? (
                <image href={fileUrl(view.image)} x={0} y={0} width={1000} height={1000} />
              ) : (
                <rect x={0} y={0} width={1000} height={1000} className="rm-nomap" />
              )}
              {r!.path.length > 1 && (
                <polyline className="rm-path" points={r!.path.map((p) => `${p.x * 1000},${p.y * 1000}`).join(" ")} style={{ strokeWidth: 3 * k }} />
              )}
              {r!.landing && (
                <g className="rm-landing" transform={`translate(${r!.landing.x * 1000} ${r!.landing.y * 1000}) scale(${k})`}>
                  <path d="M0 -14 L10 4 L-10 4 Z" />
                </g>
              )}
              {marks.map((mk, i) => (
                <g key={i} transform={`translate(${mk.at.x * 1000} ${mk.at.y * 1000}) scale(${k}) translate(${-mk.at.x * 1000} ${-mk.at.y * 1000})`}>
                  <Marker mark={mk} on={hover === i} onHover={(h) => setHover(h ? i : null)} onClick={() => props.seek(videoTime(m, mk.kind, mk.at.ms))} />
                </g>
              ))}
              {now && <circle className="rm-now" cx={now.x * 1000} cy={now.y * 1000} r={7 * k} />}
            </svg>
            {!view.image && <span className="route-nomap muted small">{t("地图图片没下载下来（离线？），路线照常显示", "The map image couldn't be downloaded (offline?); the route still shows")}</span>}
          </div>
          <ol className="route-list">
            {r!.landing && (
              <li className="route-item is-landing">
                <span className="route-dot" data-kind="landing" />
                <span>{t("落地", "Landed")}</span>
                <span className="grow" />
                <span className="mono muted small">0:00</span>
              </li>
            )}
            {marks.map((mk, i) => (
              <li key={i}>
                <button
                  type="button"
                  className={"route-item" + (hover === i ? " is-on" : "")}
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                  onClick={() => props.seek(videoTime(m, mk.kind, mk.at.ms))}
                >
                  <span className="route-dot" data-kind={mk.kind} />
                  <span className="route-what">
                    <b>{KIND[mk.kind]?.() ?? mk.kind}</b>
                    {mk.other && <span className="route-other">{mk.other}</span>}
                    <span className="muted small">
                      {[mk.weapon ? label(mk.weapon) : null, mk.distanceM != null && mk.distanceM > 0 ? t(`${Math.round(mk.distanceM)} 米`, `${Math.round(mk.distanceM)} m`) : null]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                  <span className="grow" />
                  <span className="mono muted small">{clock(Math.max(0, (mk.at.ms - startMs) / 1000))}</span>
                </button>
              </li>
            ))}
            {marks.length === 0 && <li className="muted small">{t("这局没有交战记录。", "No fights this match.")}</li>}
          </ol>
        </div>
      )}
    </section>
  );
}
