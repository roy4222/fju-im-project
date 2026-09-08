"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * 捲到視窗內才淡入上移的區塊（首頁用）。只播一次；reduced-motion 直接顯示。
 * 用 data-attribute 切換 CSS，不在 effect 裡 setState 觸發連鎖 render。
 */
export function Reveal({ children, className = "", delay = 0, as: Tag = "div" }: { children: ReactNode; className?: string; delay?: number; as?: "div" | "section" }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      el.dataset.shown = "true";
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          el.dataset.shown = "true";
          setShown(true);
          io.disconnect();
        }
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.08 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const T = Tag as "div";
  return (
    <T ref={ref} className={`reveal ${className}`} style={{ transitionDelay: `${delay}ms` }} data-shown={shown ? "true" : undefined}>
      {children}
    </T>
  );
}
