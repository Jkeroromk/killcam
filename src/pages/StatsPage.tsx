import { useEffect, useMemo, useState } from "react";
import { api, type MatchRecord } from "../lib/api";
import { when } from "../lib/format";
import { Segmented, Spinner } from "../components/ui";

type Range = 20 | 50 | 0;
type Metric = "kills" | "damage" | "place";

const METRIC_LABEL: Record<Metric, string> = { kills: "击杀", damage: "伤害", place: "排名" };

function pct(a: number, b: number): string {
  return b > 0 ? `${Math.round((a / b) * 100)}%` : "–";
}
function avg(a: number, b: number, digits = 1): string {
  return b > 0 ? (a / b).toFixed(digits) : "–";
}
/** 0 / 1 / 2 / 5 / 10 … steps so the axis gets ~3 clean lines */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/** keep the tooltip inside the chart near the left / right edge */
function tipStyle(frac: number): { left: string; transform?: string } {
  const left = `${frac * 100}%`;
  if (frac < 0.15) return { left, transform: "translateX(-12px)" };
  if (frac > 0.85) return { left, transform: "translateX(calc(-100% + 12px))" };
  return { left };
}

function Tile(props: { label: string; value: string; sub?: string }) {
  return (
    <div className="st-tile">
      <span className="st-label">{props.label}</span>
      <b className="st-value">{props.value}</b>
      {props.sub && <span className="st-sub">{props.sub}</span>}
    </div>
  );
}

/** One column per match, oldest on the left. */
function MatchColumns(props: { matches: MatchRecord[]; metric: Metric; onOpen: (id: string) => void }) {
  const [hover, setHover] = useState<number | null>(null);
  const val = (m: MatchRecord) => {
    const s = m.stats!;
    if (props.metric === "kills") return s.kills;
    if (props.metric === "damage") return Math.round(s.damage);
    // place: taller = better, so plot how many teams you outlasted
    return s.teams > 0 ? Math.max(0, s.teams - s.place + 1) : 0;
  };
  const shown = (m: MatchRecord) => (props.metric === "place" ? `#${m.stats!.place}` : String(val(m)));
  const max = niceMax(Math.max(...props.matches.map(val), 1));
  const ticks = [0, max / 2, max];
  const h = hover != null ? props.matches[hover] : null;

  return (
    <div className="st-chart">
      <div className="st-plot">
        {ticks.map((t) => (
          <div key={t} className="st-grid" style={{ bottom: `${(t / max) * 100}%` }}>
            <span>{props.metric === "place" ? "" : Math.round(t)}</span>
          </div>
        ))}
        <div className="st-cols" onMouseLeave={() => setHover(null)}>
          {props.matches.map((m, i) => {
            const v = val(m);
            return (
              <button
                type="button"
                key={m.id}
                className={"st-col" + (hover === i ? " is-hover" : "") + (m.stats!.place === 1 ? " is-win" : "")}
                onMouseEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                onClick={() => props.onOpen(m.id)}
                aria-label={`${m.mapLabel} ${when(m.createdAtMs)} ${METRIC_LABEL[props.metric]} ${shown(m)}`}
              >
                <i style={{ height: `${Math.max(v > 0 ? 2 : 0, (v / max) * 100)}%` }} />
              </button>
            );
          })}
        </div>
        {h && hover != null && (
          <div className="st-tip" style={tipStyle((hover + 0.5) / props.matches.length)}>
            <b>
              {h.mapLabel} · #{h.stats!.place}
            </b>
            <span>{when(h.createdAtMs)}</span>
            <span>
              {h.stats!.kills} 击杀 · {h.stats!.knocks} 击倒 · {Math.round(h.stats!.damage)} 伤害
            </span>
          </div>
        )}
      </div>
      <div className="st-axis">
        <span>{props.matches.length ? when(props.matches[0].createdAtMs) : ""}</span>
        <span>最近</span>
      </div>
    </div>
  );
}

export default function StatsPage(props: { libVersion: number; openMatch: (id: string) => void }) {
  const [all, setAll] = useState<MatchRecord[] | null>(null);
  const [range, setRange] = useState<Range>(20);
  const [metric, setMetric] = useState<Metric>("kills");

  useEffect(() => {
    api.listMatches().then(setAll).catch(() => setAll([]));
  }, [props.libVersion]);

  const data = useMemo(() => {
    if (!all) return null;
    // newest first from the backend
    const official = all.filter((m) => m.stats && m.stats.place > 0);
    // quick records still waiting for PUBG's data are neither yet
    const others = all.filter((m) => !(m.stats && m.stats.place > 0) && !m.pendingApi);
    const pick = range ? official.slice(0, range) : official;
    const n = pick.length;
    const sum = (f: (m: MatchRecord) => number) => pick.reduce((a, m) => a + f(m), 0);
    const kills = sum((m) => m.stats!.kills);
    const knocks = sum((m) => m.stats!.knocks);
    const damage = sum((m) => m.stats!.damage);
    const heads = sum((m) => m.stats!.headshots);
    const wins = pick.filter((m) => m.stats!.place === 1).length;
    const top10 = pick.filter((m) => m.stats!.place <= 10).length;
    const deaths = sum((m) => m.events.filter((e) => e.kind === "death").length);
    const longest = pick.reduce((b, m) => (m.stats!.longestKill > (b?.stats!.longestKill ?? 0) ? m : b), null as MatchRecord | null);
    const best = pick.reduce((b, m) => (!b || m.stats!.kills > b.stats!.kills || (m.stats!.kills === b.stats!.kills && m.stats!.damage > b.stats!.damage) ? m : b), null as MatchRecord | null);

    // weapons from the official kill events
    const wmap = new Map<string, { kills: number; dist: number; heads: number }>();
    for (const m of pick) {
      for (const e of m.events) {
        if (e.kind !== "kill" || !e.weapon) continue;
        const w = wmap.get(e.weapon) ?? { kills: 0, dist: 0, heads: 0 };
        w.kills += 1;
        w.dist += e.distanceM ?? 0;
        w.heads += e.headshot ? 1 : 0;
        wmap.set(e.weapon, w);
      }
    }
    const weapons = [...wmap.entries()].sort((a, b) => b[1].kills - a[1].kills).slice(0, 6);

    const mmap = new Map<string, { n: number; wins: number; kills: number; place: number }>();
    for (const m of pick) {
      const r = mmap.get(m.mapLabel) ?? { n: 0, wins: 0, kills: 0, place: 0 };
      r.n += 1;
      r.wins += m.stats!.place === 1 ? 1 : 0;
      r.kills += m.stats!.kills;
      r.place += m.stats!.place;
      mmap.set(m.mapLabel, r);
    }
    const maps = [...mmap.entries()].sort((a, b) => b[1].n - a[1].n);

    const otherKills = others.reduce((a, m) => a + m.events.filter((e) => e.kind === "kill").length, 0);

    return {
      pick: [...pick].reverse(),
      n,
      kills,
      knocks,
      damage,
      heads,
      wins,
      top10,
      deaths,
      longest,
      best,
      weapons,
      maps,
      others: others.length,
      otherKills,
      total: official.length,
    };
  }, [all, range]);

  if (!data) {
    return (
      <div className="page">
        <Spinner />
      </div>
    );
  }

  const d = data;
  const maxW = Math.max(1, ...d.weapons.map(([, w]) => w.kills));

  return (
    <div className="page stats">
      <header className="page-head">
        <h1>数据</h1>
        <Segmented
          value={range}
          onChange={setRange}
          options={[
            { value: 20, label: "最近 20 局" },
            { value: 50, label: "最近 50 局" },
            { value: 0, label: `全部 ${d.total}` },
          ]}
        />
      </header>

      {d.n === 0 ? (
        <p className="empty">
          还没有带官方数据的对局。点左下角绑定 PUBG 账号后，普通和排位对局的击杀、伤害、排名都会汇总到这里。
        </p>
      ) : (
        <>
          <div className="st-tiles">
            <Tile label="对局" value={String(d.n)} sub={`${d.wins} 次吃鸡 · 吃鸡率 ${pct(d.wins, d.n)}`} />
            <Tile label="场均击杀" value={avg(d.kills, d.n)} sub={`共 ${d.kills} 击杀 · ${d.knocks} 击倒`} />
            <Tile label="K/D" value={d.deaths > 0 ? (d.kills / d.deaths).toFixed(2) : String(d.kills)} sub={`阵亡 ${d.deaths} 次`} />
            <Tile label="场均伤害" value={avg(d.damage, d.n, 0)} sub={`共 ${Math.round(d.damage).toLocaleString()}`} />
            <Tile label="前十率" value={pct(d.top10, d.n)} sub={`${d.top10} 局进前十`} />
            <Tile label="爆头率" value={pct(d.heads, d.kills)} sub={`${d.heads} 次爆头击杀`} />
          </div>

          <section className="st-card">
            <header>
              <h2>每局{METRIC_LABEL[metric]}</h2>
              <span className="muted small">{metric === "place" ? "越高排名越好，白色是吃鸡" : "白色是吃鸡的对局，点一下打开"}</span>
              <span className="grow" />
              <Segmented
                value={metric}
                onChange={setMetric}
                options={[
                  { value: "kills", label: "击杀" },
                  { value: "damage", label: "伤害" },
                  { value: "place", label: "排名" },
                ]}
              />
            </header>
            <MatchColumns matches={d.pick} metric={metric} onOpen={props.openMatch} />
          </section>

          <div className="st-row">
            <section className="st-card">
              <header>
                <h2>常用武器</h2>
                <span className="muted small">按击杀数</span>
              </header>
              {d.weapons.length === 0 ? (
                <p className="muted small">这些对局里没有武器数据。</p>
              ) : (
                <ul className="st-bars">
                  {d.weapons.map(([name, w]) => (
                    <li key={name}>
                      <span className="st-bar-name">{name}</span>
                      <span className="st-bar-track">
                        <i style={{ width: `${(w.kills / maxW) * 100}%` }} />
                      </span>
                      <b>{w.kills}</b>
                      <span className="st-bar-sub">平均 {Math.round(w.dist / w.kills)} 米{w.heads ? ` · ${w.heads} 爆头` : ""}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="st-card">
              <header>
                <h2>地图</h2>
              </header>
              <table className="st-table">
                <thead>
                  <tr>
                    <th>地图</th>
                    <th>对局</th>
                    <th>吃鸡</th>
                    <th>场均击杀</th>
                    <th>平均排名</th>
                  </tr>
                </thead>
                <tbody>
                  {d.maps.map(([map, r]) => (
                    <tr key={map}>
                      <td>{map}</td>
                      <td>{r.n}</td>
                      <td>{r.wins}</td>
                      <td>{avg(r.kills, r.n)}</td>
                      <td>#{avg(r.place, r.n, 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>

          <div className="st-row">
            {d.best && (
              <button type="button" className="st-card st-best" onClick={() => props.openMatch(d.best!.id)}>
                <span className="muted small">击杀最多的一局</span>
                <b>
                  {d.best.stats!.kills} 击杀 · {Math.round(d.best.stats!.damage)} 伤害
                </b>
                <span className="muted small">
                  {d.best.mapLabel} · #{d.best.stats!.place} · {when(d.best.createdAtMs)}
                </span>
              </button>
            )}
            {d.longest && d.longest.stats!.longestKill > 0 && (
              <button type="button" className="st-card st-best" onClick={() => props.openMatch(d.longest!.id)}>
                <span className="muted small">最远击杀</span>
                <b>{Math.round(d.longest.stats!.longestKill)} 米</b>
                <span className="muted small">
                  {d.longest.mapLabel} · {when(d.longest.createdAtMs)}
                </span>
              </button>
            )}
            {d.others > 0 && (
              <div className="st-card st-best">
                <span className="muted small">街机 / 自定义 / 训练（不计入上面的统计）</span>
                <b>{d.others} 次</b>
                <span className="muted small">读屏识别到 {d.otherKills} 次击杀</span>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
