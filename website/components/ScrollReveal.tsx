"use client";

import { useEffect } from "react";

// Reveals elements marked with data-reveal as they scroll into view.
// Without JavaScript nothing is hidden: the page only hides elements after
// this runs, and anything already on screen at that moment is shown straight
// away so it never flickers. With reduced motion turned on they only fade.
// Put style={{ "--i": n }} on siblings to stagger them.
export function ScrollReveal() {
  useEffect(() => {
    if (!("IntersectionObserver" in window)) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const els = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]"));
    const fold = window.innerHeight * 0.92;
    for (const el of els) {
      if (el.getBoundingClientRect().top < fold) el.classList.add("is-in");
    }
    document.documentElement.dataset.reveal = reduce ? "fade" : "on";

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          e.target.classList.add("is-in");
          io.unobserve(e.target);
        }
      },
      { rootMargin: "0px 0px -10% 0px" },
    );
    for (const el of els) if (!el.classList.contains("is-in")) io.observe(el);

    return () => {
      io.disconnect();
      delete document.documentElement.dataset.reveal;
    };
  }, []);

  return null;
}
