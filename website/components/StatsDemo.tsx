"use client";

import { useState, type CSSProperties } from "react";
import { GAME_IDS, getDict, type GameId, type Locale } from "@/lib/i18n";
import { CHAMPS, DEMO, LOL_DEMO } from "@/lib/stats";

// A working copy of the app's 数据 page with example matches: switch the game,
// the range and the metric like in the app. The bars grow in when the panel is
// revealed. The copy is read here (not passed from the server) because it has
// functions.

type Tile = { label: string; value: string; sub: string };
type Bar = { h: number; win: boolean; title: string };
type Row = { name: string; value: string; frac: number; sub: string };
type View = {
  tiles: Tile[];
  metrics: { id: string; label: string }[];
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
  const [game, setGame] = useState<GameId>("pubg");
  const [range, setRange] = useState<20 | 50>(20);
  const [metrics, setMetrics] = useState<Record<GameId, string>>({ pubg: "kills", lol: "kills" });
  const metric = metrics[game];
  const num = (n: number) => n.toLocaleString(locale === "zh" ? "zh-CN" : "en-US");

  let view: View;
  if (game === "pubg") {
    const d = DEMO[range];
    const m = metric as "kills" | "damage" | "place";
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
  } else {
    const d = LOL_DEMO[range];
    const l = t.lol;
    const m = metric as "kills" | "kda" | "damage";
    const per = (v: number) => (v / d.n).toFixed(1);
    const of = (x: (typeof d.matches)[number]) => (m === "kills" ? x.k : m === "kda" ? (x.k + x.a) / Math.max(x.d, 1) : x.damage);
    const hs = scale(d.matches.map(of));
    const top = Math.max(...d.champs.map((c) => c.games), 1);
    view = {
      tiles: [
        { label: t.tiles.matches, value: String(d.n), sub: l.matchesSub(d.wins, pct(d.wins, d.n)) },
        { label: l.kda, value: ((d.k + d.a) / Math.max(d.d, 1)).toFixed(2), sub: l.kdaSub(per(d.k), per(d.d), per(d.a)) },
        { label: l.cs, value: (d.cs / d.minutes).toFixed(1), sub: l.csSub(Math.round(d.cs / d.n)) },
        { label: l.damage, value: num(Math.round(d.damage / d.n)), sub: l.damageSub(num(d.damage)) },
        { label: l.kp, value: pct(d.k + d.a, d.teamKills), sub: l.kpSub },
        { label: l.multi, value: String(d.multi.reduce((a, b) => a + b, 0)), sub: l.multiSub(...d.multi) },
      ],
      metrics: (["kills", "kda", "damage"] as const).map((id) => ({ id, label: l.metrics[id] })),
      chartTitle: t.perMatch(l.metrics[m]),
      bars: d.matches.map((x, i) => {
        const champ = locale === "zh" ? CHAMPS[x.champ].zh : CHAMPS[x.champ].en;
        const v = of(x);
        return { h: hs[i], win: x.win, title: `${champ} · ${l.metrics[m]} ${m === "kda" ? v.toFixed(1) : num(v)}` };
      }),
      winLegend: l.winLegend,
      listTitle: l.champs,
      rows: d.champs.map((c) => ({
        name: locale === "zh" ? c.champ.zh : c.champ.en,
        value: String(c.games),
        frac: c.games / top,
        sub: l.champSub(c.games, pct(c.wins, c.games), c.kda.toFixed(2)),
      })),
    };
  }

  return (
    <div className="sd" role="group" aria-label={t.panelLabel} data-game={game}>
      <div className="sd-head">
        <span className="sd-page">{t.page}</span>
        <div className="sd-seg" role="group">
          {GAME_IDS.map((id) => (
            <button key={id} type="button" aria-pressed={game === id} onClick={() => setGame(id)}>
              {t.gameTabs[id]}
            </button>
          ))}
        </div>
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
                <button key={k.id} type="button" aria-pressed={metric === k.id} onClick={() => setMetrics({ ...metrics, [game]: k.id })}>
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
