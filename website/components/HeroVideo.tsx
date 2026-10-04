"use client";

import { useEffect, useRef, useState } from "react";

// Muted gameplay loop behind the hero (Jkeroro's own match, the final fight
// around the APC). The poster is always there; the video is only added when
// the visitor hasn't asked for reduced motion or reduced data, and it pauses
// while the hero is scrolled out of view.

const PHONE = "(max-width: 760px)";

export function HeroVideo() {
  const [play, setPlay] = useState(false);
  const video = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const reduceData = window.matchMedia("(prefers-reduced-data: reduce)").matches;
    const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
    if (!reduceMotion && !reduceData && !saveData) setPlay(true);
  }, []);

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) v.play().catch(() => {});
      else v.pause();
    });
    io.observe(v);
    return () => io.disconnect();
  }, [play]);

  return (
    <div className="hero-media" aria-hidden="true">
      <picture>
        <source media={PHONE} srcSet="/hero/poster-720.jpg" />
        <img src="/hero/poster-1280.jpg" alt="" className="hero-media-el" />
      </picture>
      {play && (
        <video ref={video} className="hero-media-el is-video" autoPlay muted loop playsInline preload="auto" disablePictureInPicture>
          {/* H.264 for Safari/Chrome/Edge; VP9 for browsers built without H.264 */}
          <source media={PHONE} src="/hero/hero-720.mp4" type="video/mp4" />
          <source media={PHONE} src="/hero/hero-720.webm" type="video/webm" />
          <source src="/hero/hero-1280.mp4" type="video/mp4" />
          <source src="/hero/hero-1280.webm" type="video/webm" />
        </video>
      )}
    </div>
  );
}
