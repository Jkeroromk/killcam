"use client";

import { useEffect, useRef, useState } from "react";
import type { FilmCard } from "@/lib/film";

// Mounts the 3D film strip behind the hero. three.js is loaded only in the
// browser, after the page is up; until then (or without WebGL) a still frame
// stands in. Reduced motion gets a still composition, and reduced data skips
// the clip that plays on the newest card.

export function HeroFilm({ cards }: { cards: FilmCard[] }) {
  const host = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const probe = document.createElement("canvas");
    if (!(probe.getContext("webgl2") || probe.getContext("webgl"))) return;

    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const saveData =
      window.matchMedia("(prefers-reduced-data: reduce)").matches ||
      (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
    const phone = window.matchMedia("(max-width: 760px)").matches;
    const size = phone ? "720" : "1280";

    let stop: (() => void) | null = null;
    let cancelled = false;
    Promise.all([import("three"), import("@/lib/film")]).then(([THREE, film]) => {
      if (cancelled) return;
      stop = film.startFilm(THREE, el, {
        cards,
        atlas: "/hero/film-atlas.jpg",
        video: saveData
          ? []
          : [
              { src: `/hero/hero-${size}.mp4`, type: "video/mp4" },
              { src: `/hero/hero-${size}.webm`, type: "video/webm" },
            ],
        still,
        onReady: () => setReady(true),
      });
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [cards]);

  return (
    <div className={ready ? "hero-media is-film is-ready" : "hero-media is-film"} aria-hidden="true" ref={host}>
      <picture>
        <source media="(max-width: 760px)" srcSet="/hero/poster-720.jpg" />
        <img src="/hero/poster-1280.jpg" alt="" className="hero-media-el hero-poster" />
      </picture>
    </div>
  );
}
