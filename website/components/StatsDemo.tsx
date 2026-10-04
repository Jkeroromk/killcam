"use client";

import { useState, type CSSProperties } from "react";
import { getDict, type Locale } from "@/lib/i18n";
import { DEMO } from "@/lib/stats";

// A working copy of the app's 数据 page with example matches: switch the range
// and the metric like in the app. The bars grow in when the panel is revealed.
// The copy is read here (not passed from the server) because it has functions.

type Metric = "kills" | "damage" | "place";

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "–");

export function StatsDemo({ locale }: { locale: Locale }) {
  const t = getDict(locale).stats;
  const [range, setRange] = useState<20 | 50>(20);
  const [metric, setMetric] = useState<Metric>("kills");
  const d = DEMO[range];
  const num = (n: number) => n.toLocaleString(locale === "zh" ? "zh-CN" : "en-US");

  const value = (m: (typeof d.matches)[number]) => (metric === "place" ? m.place : m[metric]);
  // placement: a taller bar is a better finish
  const height = (m: (typeof d.matches)[number]) => {
    if (metric === "place") return (27 - Math.min(m.place, 26)) / 26;
    const max = Math.max(...d.matches.map((x) => x[metric]), 1);
    return m[metric] / max;
  };
  const topWeapon = Math.max(...d.weapons.map((w) => w.kills), 1);

  const tiles = [
    { label: t.tiles.matches, value: String(d.n), sub: t.tiles.matchesSub(d.wins, pct(d.wins, d.n)) },
    { label: t.tiles.kills, value: (d.kills / d.n).toFixed(1), sub: t.tiles.killsSub(d.kills, d.knocks) },
    { label: t.tiles.kd, value: (d.kills / Math.max(d.deaths, 1)).toFixed(2), sub: t.tiles.kdSub(d.deaths) },
    { label: t.tiles.damage, value: num(Math.round(d.damage / d.n)), sub: t.tiles.damageSub(num(d.damage)) },
    { label: t.tiles.top10, value: pct(d.top10, d.n), sub: t.tiles.top10Sub(d.top10) },
    { label: t.tiles.heads, value: pct(d.heads, d.kills), sub: t.tiles.headsSub(d.heads) },
  ];

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
        {tiles.map((x) => (
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
            <h3>{t.perMatch(t.metrics[metric])}</h3>
            <div className="sd-seg is-small" role="group">
              {(["kills", "damage", "place"] as const).map((k) => (
                <button key={k} type="button" aria-pressed={metric === k} onClick={() => setMetric(k)}>
                  {t.metrics[k]}
                </button>
              ))}
            </div>
          </header>
          <ol className="sd-bars" style={{ "--n": d.matches.length } as CSSProperties}>
            {d.matches.map((m, i) => (
              <li
                key={i}
                className={m.place === 1 ? "is-win" : undefined}
                style={{ "--h": height(m), "--i": i } as CSSProperties}
                title={`${t.maps[m.map]} · ${t.metrics[metric]} ${metric === "place" ? `#${m.place}` : num(value(m))}`}
              >
                <span />
              </li>
            ))}
          </ol>
          <p className="sd-legend">
            <span className="sd-swatch" aria-hidden="true" />
            {t.winLegend}
          </p>
        </section>

        <section className="sd-weapons">
          <header>
            <h3>{t.weapons}</h3>
          </header>
          <ul>
            {d.weapons.map((w, i) => (
              <li key={w.name} style={{ "--w": w.kills / topWeapon, "--i": i } as CSSProperties}>
                <span className="sd-w-name">{w.name}</span>
                <span className="sd-w-kills">{w.kills}</span>
                <span className="sd-w-bar">
                  <span />
                </span>
                <span className="sd-w-sub">{t.weaponSub(w.avgDist, w.heads)}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
