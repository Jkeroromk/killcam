"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Dict, EventKind, Locale } from "@/lib/i18n";
import { CLIPS, EVENTS, MATCH_LENGTH, timecode, type MatchEvent } from "@/lib/match";
import { EVENT_ICON, RotateCcw } from "./icons";

// The hero: one match plays back in ~7 seconds. The playhead sweeps the
// timeline, each event lights up as it's passed and lands in the feed, and
// the highlight bands fill in. It plays once, when it first scrolls into view
// (on phones it starts below the fold); "Replay" plays it again.

const PLAY_MS = 7000;
const START_DELAY_MS = 350;

// Which icon a grouped marker shows: the most notable event in the clip.
const RANK: Record<EventKind, number> = { win: 5, kill: 4, knock: 3, eliminated: 2, knocked: 1, manual: 0 };

const pct = (t: number) => `${(t / MATCH_LENGTH) * 100}%`;

function detail(e: MatchEvent, locale: Locale): string | null {
  if (!e.detail) return null;
  const { weapon, m, hs } = e.detail;
  return locale === "zh" ? `${weapon}，${m} 米${hs ? "，爆头" : ""}` : `${weapon}, ${m} m${hs ? ", headshot" : ""}`;
}

export function MatchTimeline(props: { t: Dict["timeline"]; locale: Locale; initial?: number }) {
  const { t: copy, locale } = props;
  const [now, setNow] = useState(Math.min(props.initial ?? 0, MATCH_LENGTH));
  const raf = useRef<number | null>(null);
  const figure = useRef<HTMLElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const userScrolled = useRef(false);

  const play = useCallback(() => {
    if (raf.current) cancelAnimationFrame(raf.current);
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
      setNow(eased * MATCH_LENGTH);
      if (p < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
  }, []);

  useEffect(() => {
    const el = figure.current;
    let timer: number | undefined;
    const start = () => {
      timer = window.setTimeout(play, START_DELAY_MS);
    };
    let io: IntersectionObserver | undefined;
    if (el && "IntersectionObserver" in window) {
      io = new IntersectionObserver(
        (entries) => {
          // most of the timeline has to be on screen before it plays (or as
          // much as fits, on short landscape screens)
          const need = Math.min(0.75, (window.innerHeight * 0.85) / el.offsetHeight);
          if (entries.some((e) => e.isIntersecting && e.intersectionRatio >= need)) {
            io?.disconnect();
            start();
          }
        },
        { threshold: [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 1] },
      );
      io.observe(el);
    } else {
      start();
    }
    return () => {
      io?.disconnect();
      window.clearTimeout(timer);
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [play]);

  // On narrow screens the timeline scrolls sideways; keep the playhead in view
  // while it plays, unless the visitor has started scrolling it themselves.
  useEffect(() => {
    const el = scroller.current;
    if (!el || userScrolled.current || el.scrollWidth <= el.clientWidth) return;
    const x = (now / MATCH_LENGTH) * el.scrollWidth;
    el.scrollLeft = Math.max(0, x - el.clientWidth * 0.6);
  }, [now]);

  const stopFollowing = () => {
    userScrolled.current = true;
  };

  const passed = EVENTS.filter((e) => e.t <= now);
  const kills = passed.filter((e) => e.kind === "kill").length;
  const knocks = passed.filter((e) => e.kind === "knock").length;
  const clipsDone = CLIPS.filter((c) => c.events[0].t <= now).length;
  const done = now >= MATCH_LENGTH;
  const feed = passed.slice(-3).reverse();

  const ticks: number[] = [];
  for (let s = 0; s <= MATCH_LENGTH; s += 60) ticks.push(s);

  return (
    <figure className="scene" aria-label={copy.label} ref={figure}>
      <div className="scene-head">
        <span className="scene-match">
          <span className={done ? "rec-dot is-off" : "rec-dot"} aria-hidden="true" />
          {copy.match}
        </span>
        <span className="scene-clock" aria-hidden="true">
          {timecode(now)} / {timecode(MATCH_LENGTH)}
        </span>
      </div>

      <div className="track-scroll" ref={scroller} onPointerDown={stopFollowing} onWheel={stopFollowing} onTouchStart={stopFollowing}>
        <div className="track" aria-hidden="true">
          {CLIPS.map((c) => {
            const lit = c.events[0].t <= now;
            const top = c.events.reduce((a, b) => (RANK[b.kind] > RANK[a.kind] ? b : a));
            const Icon = EVENT_ICON[top.kind];
            const mid = (c.events[0].t + c.events[c.events.length - 1].t) / 2;
            return (
              <div key={c.start}>
                <span
                  className={lit ? "band is-lit" : "band"}
                  style={{ left: pct(c.start), width: pct(c.end - c.start) }}
                />
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
              {s % 120 === 0 && s < MATCH_LENGTH - 60 && <span className="tick-label">{timecode(s)}</span>}
            </span>
          ))}
          <span className="playhead" style={{ left: pct(now) }} />
        </div>
      </div>

      <div className="scene-foot">
        <dl className="tally">
          <div>
            <dt>{copy.kills}</dt>
            <dd>{kills}</dd>
          </div>
          <div>
            <dt>{copy.knocks}</dt>
            <dd>{knocks}</dd>
          </div>
        </dl>
        <p className={done ? "tally-clips is-done" : "tally-clips"}>{copy.clips.replace("{n}", String(clipsDone))}</p>

        <ol className="feed" aria-live="off">
          {feed.map((e) => {
            const Icon = EVENT_ICON[e.kind];
            const d = detail(e, locale);
            return (
              <li key={e.t} className={`feed-row feed-${e.kind}`}>
                <span className="feed-time">{timecode(e.t)}</span>
                <Icon size={14} />
                <span className="feed-what">{copy.events[e.kind]}</span>
                {d && <span className="feed-detail">{d}</span>}
              </li>
            );
          })}
        </ol>

        <button type="button" className="replay" onClick={play} disabled={!done}>
          <RotateCcw size={14} />
          {copy.replay}
        </button>
      </div>
    </figure>
  );
}
