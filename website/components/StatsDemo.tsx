"use client";

import { useState, type CSSProperties } from "react";
import { getDict, type Locale } from "@/lib/i18n";
import { DEMO } from "@/lib/stats";

// A working copy of the app's 数据 page with example PUBG matches: switch the
// range and the metric like in the app. Each game has its own stats page in
// the app; one example is enough here. The bars grow in when the panel is
// revealed. The copy is read here (not passed from the server) because it has
// functions.

type Metric = "kills" | "damage" | "place";
type Tile = { label: string; value: string; sub: string };
type Bar = { h: number; win: boolean; title: string };
type Row = { name: string; value: string; frac: number; sub: string };
type View = {
  tiles: Tile[];
  metrics: { id: Metric; label: string }[];
  chartTitle: string;
  bars: Bar[];
  winLegend: string;
  listTitle: string;
  rows: Row[];
};

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "–");
const scale = (vals: number[]) => {
  const max = Math.max(...vals, 1);
  return vals.map((v) => v / max);
};

export function StatsDemo({ locale }: { locale: Locale }) {
  const t = getDict(locale).stats;
  const [range, setRange] = useState<20 | 50>(20);
  const [metric, setMetric] = useState<Metric>("kills");
  const num = (n: number) => n.toLocaleString(locale === "zh" ? "zh-CN" : "en-US");

  let view: View;
  {
    const d = DEMO[range];
    const m = metric;
    // placement: a taller bar is a better finish
    const hs = m === "place" ? d.matches.map((x) => (27 - Math.min(x.place, 26)) / 26) : scale(d.matches.map((x) => x[m]));
    const top = Math.max(...d.weapons.map((w) => w.kills), 1);
    view = {
      tiles: [
        { label: t.tiles.matches, value: String(d.n), sub: t.tiles.matchesSub(d.wins, pct(d.wins, d.n)) },
        { label: t.tiles.kills, value: (d.kills / d.n).toFixed(1), sub: t.tiles.killsSub(d.kills, d.knocks) },
        { label: t.tiles.kd, value: (d.kills / Math.max(d.deaths, 1)).toFixed(2), sub: t.tiles.kdSub(d.deaths) },
        { label: t.tiles.damage, value: num(Math.round(d.damage / d.n)), sub: t.tiles.damageSub(num(d.damage)) },
        { label: t.tiles.top10, value: pct(d.top10, d.n), sub: t.tiles.top10Sub(d.top10) },
        { label: t.tiles.heads, value: pct(d.heads, d.kills), sub: t.tiles.headsSub(d.heads) },
      ],
      metrics: (["kills", "damage", "place"] as const).map((id) => ({ id, label: t.metrics[id] })),
      chartTitle: t.perMatch(t.metrics[m]),
      bars: d.matches.map((x, i) => ({
        h: hs[i],
        win: x.place === 1,
        title: `${t.maps[x.map]} · ${t.metrics[m]} ${m === "place" ? `#${x.place}` : num(x[m])}`,
      })),
      winLegend: t.winLegend,
      listTitle: t.weapons,
      rows: d.weapons.map((w) => ({ name: w.name, value: String(w.kills), frac: w.kills / top, sub: t.weaponSub(w.avgDist, w.heads) })),
    };
  }

  return (
    <div className="sd" role="group" aria-label={t.panelLabel}>
      <div className="sd-head">
        <span className="sd-page">{t.page}</span>
        <span className="sd-sample">{t.sample}</span>
        <div className="sd-seg" role="group">
          {([20, 50] as const).map((n) => (
            <button key={n} type="button" aria-pressed={range === n} onClick={() => setRange(n)}>
              {t.range(n)}
            </button>
          ))}
        </div>
      </div>

      <dl className="sd-tiles">
        {view.tiles.map((x) => (
          <div key={x.label}>
            <dt>{x.label}</dt>
            <dd>
              <span className="sd-big">{x.value}</span>
              <span className="sd-sub">{x.sub}</span>
            </dd>
          </div>
        ))}
      </dl>

      <div className="sd-body">
        <section className="sd-chart">
          <header>
            <h3>{view.chartTitle}</h3>
            <div className="sd-seg is-small" role="group">
              {view.metrics.map((k) => (
                <button key={k.id} type="button" aria-pressed={metric === k.id} onClick={() => setMetric(k.id)}>
                  {k.label}
                </button>
              ))}
            </div>
          </header>
          <ol className="sd-bars" style={{ "--n": view.bars.length } as CSSProperties}>
            {view.bars.map((b, i) => (
              <li key={i} className={b.win ? "is-win" : undefined} style={{ "--h": b.h, "--i": i } as CSSProperties} title={b.title}>
                <span />
              </li>
            ))}
          </ol>
          <p className="sd-legend">
            <span className="sd-swatch" aria-hidden="true" />
            {view.winLegend}
          </p>
        </section>

        <section className="sd-weapons">
          <header>
            <h3>{view.listTitle}</h3>
          </header>
          <ul>
            {view.rows.map((w, i) => (
              <li key={w.name} style={{ "--w": w.frac, "--i": i } as CSSProperties}>
                <span className="sd-w-name">{w.name}</span>
                <span className="sd-w-kills">{w.value}</span>
                <span className="sd-w-bar">
                  <span />
                </span>
                <span className="sd-w-sub">{w.sub}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
