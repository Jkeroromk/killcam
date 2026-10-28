"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { getDict, type Locale } from "@/lib/i18n";
import { BAR, BEAT, BPM, CUTS, MATCH_MAP, clock, energy, transitionAt, type DemoShot, type TransStyle } from "@/lib/beat";

// A working copy of the app's 剪辑 page in 卡点成片 mode: the song on top
// (loudness per beat, the beat grid, the drop), the cut underneath (shots
// coloured by match, kills on the beat, transitions only where the match
// changes), and a playhead that plays it through when it scrolls into view.
// Length and transition style can be switched like in the app.

const PLAY_MS = 9000;
const HOLD_MS = 1800;

export function BeatCut({ locale }: { locale: Locale }) {
  const d = getDict(locale);
  const t = d.edit.demo;
  const [len, setLen] = useState<30 | 60>(60);
  const [style, setStyle] = useState<TransStyle>("mix");
  const [now, setNow] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const visible = useRef(false);
  const raf = useRef<number | null>(null);
  const hold = useRef<number | undefined>(undefined);
  const scroller = useRef<HTMLDivElement>(null);
  const userScrolled = useRef(false);

  const cut = CUTS[len];
  const L = cut.length;
  const pct = (s: number) => `${(s / L) * 100}%`;
  const bars = energy(cut);

  // play through, hold at the end, start again (only while on screen)
  useEffect(() => {
    // pauses where it is while off screen and carries on when it's back
    let elapsed = 0;
    let last: number | null = null;
    const step = (ts: number) => {
      if (!visible.current) {
        last = null;
        hold.current = window.setTimeout(() => (raf.current = requestAnimationFrame(step)), 300);
        return;
      }
      if (last !== null) elapsed += ts - last;
      last = ts;
      const p = Math.min(1, elapsed / PLAY_MS);
      setNow(p * L);
      if (p < 1) raf.current = requestAnimationFrame(step);
      else
        hold.current = window.setTimeout(() => {
          elapsed = 0;
          last = null;
          raf.current = requestAnimationFrame(step);
        }, HOLD_MS);
    };
    setNow(0);
    raf.current = requestAnimationFrame(step);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
      window.clearTimeout(hold.current);
    };
  }, [L]);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    if (!("IntersectionObserver" in window)) {
      visible.current = true;
      return;
    }
    const io = new IntersectionObserver((es) => (visible.current = es.some((e) => e.isIntersecting && e.intersectionRatio > 0.35)), {
      threshold: [0, 0.35, 0.6, 1],
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // On narrow screens the tracks scroll sideways; keep the playhead in view
  // unless the visitor is scrolling them, until the cut starts over.
  useEffect(() => {
    const el = scroller.current;
    if (!el || el.scrollWidth <= el.clientWidth) return;
    if (now < 0.05) userScrolled.current = false;
    if (userScrolled.current) return;
    el.scrollLeft = Math.max(0, (now / L) * el.scrollWidth - el.clientWidth * 0.6);
  }, [now, L]);
  const stopFollowing = () => {
    userScrolled.current = true;
  };

  // transitions between shots, counted so "auto" can take turns
  let nTrans = 0;
  const joins = cut.shots.slice(1).map((s, i) => {
    const tr = transitionAt(cut.shots[i], s, style, nTrans);
    if (tr) nTrans++;
    return { at: s.start, tr };
  });

  const cur: DemoShot = cut.shots.find((s) => now >= s.start && now < s.end) ?? cut.shots[cut.shots.length - 1];
  const inPull = cut.pull && now >= cut.pull[0] && now < cut.pull[1];
  const slammed = cut.pull && now >= cut.pull[1] && now < cut.pull[1] + BAR;
  const phase = inPull ? t.phases.pull : slammed ? t.phases.slam : t.phases[cur.phase === "pull" ? "fight" : cur.phase];
  const what =
    "win" in cur.what
      ? t.win
      : t.shot(cur.what.weapon, cur.what.m, !!cur.what.hs, cur.what.n ?? 1);

  const beats: number[] = [];
  for (let s = 0; s <= L + 0.001; s += BEAT) beats.push(+s.toFixed(4));

  return (
    <div className="bc" ref={root} role="group" aria-label={t.label}>
      <div className="bc-head">
        <span className="bc-page">{t.page}</span>
        <span className="bc-mode">{t.mode}</span>
        <span className="bc-song">
          <span className="bc-note" aria-hidden="true">
            ♪
          </span>
          {t.song} · {BPM} BPM
        </span>
        <span className="bc-clock" aria-hidden="true">
          {clock(now)} / {clock(L)}
        </span>
      </div>

      <div className="bc-scroll" ref={scroller} onPointerDown={stopFollowing} onWheel={stopFollowing} onTouchStart={stopFollowing}>
        <div className="bc-tracks" aria-hidden="true">
          <span className="bc-lane-label is-music">{t.music}</span>
          <div className="bc-music">
            {cut.pull && (
              <span className="bc-pull" style={{ left: pct(cut.pull[0]), width: pct(cut.pull[1] - cut.pull[0]) }}>
                <span>{t.pull}</span>
              </span>
            )}
            <ol className="bc-wave" style={{ "--n": bars.length } as CSSProperties}>
              {bars.map((e, i) => {
                const s = i * BEAT;
                const ducked = cut.pull && s >= cut.pull[0] && s < cut.pull[1];
                return <li key={i} className={`${s < now ? "is-past" : ""}${ducked ? " is-ducked" : ""}`} style={{ "--h": ducked ? e * 0.28 : e } as CSSProperties} />;
              })}
            </ol>
            <span className="bc-drop" style={{ left: pct(cut.drop) }}>
              <span>{t.drop}</span>
            </span>
            {cut.pull && (
              <span className="bc-slam" style={{ left: pct(cut.pull[1]) }}>
                <span>{t.slam}</span>
              </span>
            )}
          </div>

          <div className="bc-grid">
            {beats.map((s, i) => (
              <span key={s} className={i % 4 === 0 ? "is-bar" : undefined} style={{ left: pct(s) }} />
            ))}
          </div>

          <span className="bc-lane-label is-video">{t.video}</span>
          <div className="bc-video">
            <span className="bc-hook" style={{ width: pct(cut.hookEnd) }}>
              <span>{t.hook}</span>
            </span>
            {cut.shots.map((s, i) => (
              <span
                key={`${len}-${i}`}
                className={`bc-shot is-${s.match}${s.phase === "hook" ? " is-quick" : ""}${now >= s.start ? " is-on" : ""}`}
                style={{ left: pct(s.start), width: `calc(${pct(s.end - s.start)} - 2px)` }}
              >
                {s.phase !== "hook" && <span className="bc-shot-map">{d.stats.maps[MATCH_MAP[s.match]]}</span>}
                {s.kills.map((k) => (
                  <i key={k} className={now >= k ? "is-hit" : undefined} style={{ left: `clamp(6px, ${((k - s.start) / (s.end - s.start)) * 100}%, calc(100% - 6px))` }} />
                ))}
              </span>
            ))}
            {joins.map(
              (j) =>
                j.tr && (
                  <span key={`${len}-${j.at}`} className={`bc-trans is-${j.tr}${now >= j.at ? " is-on" : ""}`} style={{ left: pct(j.at) }}>
                    {t.trans[j.tr]}
                  </span>
                ),
            )}
          </div>

          <span className="bc-playhead" style={{ left: pct(now) }} />
        </div>
      </div>

      <div className="bc-foot">
        <p className="bc-now" aria-live="off">
          <span className={`bc-swatch is-${cur.match}`} aria-hidden="true" />
          <span className="bc-now-what">
            {d.stats.maps[MATCH_MAP[cur.match]]} · {what}
          </span>
          <span className="bc-now-phase">{phase}</span>
        </p>
        <div className="bc-controls">
          <div className="sd-seg is-small" role="group" aria-label={t.lengthLabel}>
            {([30, 60] as const).map((n) => (
              <button key={n} type="button" aria-pressed={len === n} onClick={() => setLen(n)}>
                {t.lengths[n]}
              </button>
            ))}
          </div>
          <div className="sd-seg is-small" role="group" aria-label={t.transLabel}>
            {(["mix", "cut", "whip", "flash", "black"] as const).map((k) => (
              <button key={k} type="button" aria-pressed={style === k} onClick={() => setStyle(k)}>
                {t.styles[k]}
              </button>
            ))}
          </div>
        </div>
        <p className="bc-legend">
          <i aria-hidden="true" />
          {t.killLegend}
        </p>
      </div>
    </div>
  );
}
