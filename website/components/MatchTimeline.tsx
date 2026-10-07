"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { GAME_IDS, type Dict, type EventKind, type GameId, type Locale } from "@/lib/i18n";
import { MATCHES, timecode, type MatchEvent } from "@/lib/match";
import { EVENT_ICON } from "./icons";

// An example match plays back in ~7 seconds: the playhead sweeps the
// timeline, each event lights up as it's passed and lands in the feed, and
// the highlight bands fill in. It starts when it scrolls into view, then moves
// on to the next game's example by itself, so a new game is just one more
// entry in MATCHES. It pauses while it's off screen.

const PLAY_MS = 7000;
const START_DELAY_MS = 350;
const HOLD_MS = 2600; // how long a finished match stays before the next one

// Which icon a grouped marker shows: the most notable event in the clip.
const RANK: Record<EventKind, number> = { win: 6, kill: 5, objective: 4, knock: 4, assist: 3, eliminated: 2, knocked: 1, manual: 0 };

export function MatchTimeline(props: { t: Dict["timeline"]; locale: Locale; initial?: number }) {
  const { t: copy, locale } = props;
  const [game, setGame] = useState<GameId>("pubg");
  const match = MATCHES[game];
  const g = copy.games[game];
  const [now, setNow] = useState(Math.min(props.initial ?? 0, match.length));
  const raf = useRef<number | null>(null);
  const figure = useRef<HTMLElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const userScrolled = useRef(false);
  const visible = useRef(false);
  const gameRef = useRef<GameId>("pubg");
  const hold = useRef<number | undefined>(undefined);

  const pct = (t: number) => `${(t / match.length) * 100}%`;

  const play = useCallback((id: GameId) => {
    if (raf.current) cancelAnimationFrame(raf.current);
    window.clearTimeout(hold.current);
    gameRef.current = id;
    setGame(id);
    const length = MATCHES[id].length;
    // Plays even with reduced motion turned on: the playhead sweeping the
    // match is the demo itself (the CSS drops the small bounces instead).
    setNow(0);
    userScrolled.current = false;
    let begin: number | null = null;
    const step = (ts: number) => {
      begin ??= ts;
      const p = Math.min(1, (ts - begin) / PLAY_MS);
      // ease out so the final events (and the win) land more slowly
      const eased = 1 - Math.pow(1 - p, 1.6);
      setNow(eased * length);
      if (p < 1) raf.current = requestAnimationFrame(step);
      else hold.current = window.setTimeout(next, HOLD_MS);
    };
    // the next game's example; waits while the timeline is off screen
    const next = () => {
      if (!visible.current) {
        hold.current = window.setTimeout(next, 500);
        return;
      }
      const i = GAME_IDS.indexOf(gameRef.current);
      play(GAME_IDS[(i + 1) % GAME_IDS.length]);
    };
    raf.current = requestAnimationFrame(step);
  }, []);

  useEffect(() => {
    const el = figure.current;
    let timer: number | undefined;
    const start = () => {
      timer = window.setTimeout(() => play("pubg"), START_DELAY_MS);
    };
    let io: IntersectionObserver | undefined;
    let started = false;
    if (el && "IntersectionObserver" in window) {
      io = new IntersectionObserver(
        (entries) => {
          // most of the timeline has to be on screen before it plays (or as
          // much as fits, on short landscape screens)
          const need = Math.min(0.6, (window.innerHeight * 0.85) / el.offsetHeight);
          const seen = entries.some((e) => e.isIntersecting && e.intersectionRatio >= need);
          visible.current = entries.some((e) => e.isIntersecting);
          if (seen && !started) {
            started = true;
            start();
          }
        },
        { threshold: [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 1] },
      );
      io.observe(el);
    } else {
      visible.current = true;
      start();
    }
    return () => {
      io?.disconnect();
      window.clearTimeout(timer);
      window.clearTimeout(hold.current);
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [play]);

  // On narrow screens the timeline scrolls sideways; keep the playhead in view
  // while it plays, unless the visitor has started scrolling it themselves.
  useEffect(() => {
    const el = scroller.current;
    if (!el || userScrolled.current || el.scrollWidth <= el.clientWidth) return;
    const x = (now / match.length) * el.scrollWidth;
    el.scrollLeft = Math.max(0, x - el.clientWidth * 0.6);
  }, [now, match.length]);

  const stopFollowing = () => {
    userScrolled.current = true;
  };

  // a win is 大吉大利 in PUBG and 胜利 in League; dying is 被淘汰 / 阵亡
  const label = (e: MatchEvent) => (e.kind === "win" ? g.win : e.kind === "eliminated" ? g.death : copy.events[e.kind]);
  const detail = (e: MatchEvent): string | null => {
    if (e.note) return copy.notes[e.note];
    if (!e.detail) return null;
    const { weapon, m, hs } = e.detail;
    return locale === "zh" ? `${weapon}，${m} 米${hs ? "，爆头" : ""}` : `${weapon}, ${m} m${hs ? ", headshot" : ""}`;
  };

  const passed = match.events.filter((e) => e.t <= now);
  const first = passed.filter((e) => e.kind === "kill").length;
  const second = passed.filter((e) => e.kind === (game === "lol" ? "assist" : "knock")).length;
  const clipsDone = match.clips.filter((c) => c.events[0].t <= now).length;
  const done = now >= match.length;
  const feed = passed.slice(-3).reverse();

  const ticks: number[] = [];
  for (let s = 0; s <= match.length; s += 60) ticks.push(s);

  return (
    <figure className="scene" aria-label={copy.label} ref={figure} data-game={game}>
      <div className="scene-head">
        <span className="scene-match">
          <span className={done ? "rec-dot is-off" : "rec-dot"} aria-hidden="true" />
          <span className="scene-game">{g.name}</span>
          <span>{g.match}</span>
        </span>
        <span className="scene-clock" aria-hidden="true">
          {timecode(now)} / {timecode(match.length)}
        </span>
      </div>

      <div className="track-scroll" ref={scroller} onPointerDown={stopFollowing} onWheel={stopFollowing} onTouchStart={stopFollowing}>
        <div className="track" aria-hidden="true" key={game}>
          {match.clips.map((c) => {
            const lit = c.events[0].t <= now;
            const top = c.events.reduce((a, b) => (RANK[b.kind] > RANK[a.kind] ? b : a));
            const Icon = EVENT_ICON[top.kind];
            const mid = (c.events[0].t + c.events[c.events.length - 1].t) / 2;
            return (
              <div key={c.start}>
                <span className={lit ? "band is-lit" : "band"} style={{ left: pct(c.start), width: pct(c.end - c.start) }} />
                <span className={`pin pin-${top.kind}${lit ? " is-lit" : ""}`} style={{ left: pct(mid) }}>
                  <span className="pin-chip">
                    <Icon size={15} />
                    {c.events.length > 1 && <span className="pin-count">{c.events.length}</span>}
                  </span>
                  <span className="pin-stem" />
                </span>
              </div>
            );
          })}

          <div className="rail" />
          {ticks.map((s) => (
            <span key={s} className={s % 120 === 0 ? "tick is-major" : "tick"} style={{ left: pct(s) }}>
              {s % 120 === 0 && s < match.length - 60 && <span className="tick-label">{timecode(s)}</span>}
            </span>
          ))}
          <span className="playhead" style={{ left: pct(now) }} />
        </div>
      </div>

      <div className="scene-foot">
        <dl className="tally">
          <div>
            <dt>{g.tally[0]}</dt>
            <dd>{first}</dd>
          </div>
          <div>
            <dt>{g.tally[1]}</dt>
            <dd>{second}</dd>
          </div>
        </dl>
        <p className={done ? "tally-clips is-done" : "tally-clips"}>{copy.clips.replace("{n}", String(clipsDone))}</p>

        <ol className="feed" aria-live="off">
          {feed.map((e) => {
            const Icon = EVENT_ICON[e.kind];
            const d = detail(e);
            return (
              <li key={`${game}-${e.t}`} className={`feed-row feed-${e.kind}${e.note === "penta" || e.note === "baronSteal" ? " is-big" : ""}`}>
                <span className="feed-time">{timecode(e.t)}</span>
                <Icon size={14} />
                <span className="feed-what">{label(e)}</span>
                {d && <span className="feed-detail">{d}</span>}
              </li>
            );
          })}
        </ol>

      </div>
    </figure>
  );
}
