"use client";

import { useEffect, useRef } from "react";

/**
 * 卡片漣漪（原型第 3 輪，Roy 2026-10-15）：放進任何 .fx-card 卡片裡，自己監聽父元素的滑鼠。
 * 進入時從游標擴散一圈淡光，游標附近浮出隨機字元（移動時換字，像 Claude 桌面 App 的背景）；離開淡出。
 * 只在有滑鼠、沒開「減少動態」時啟動；字元在第一次滑入才產生，不影響 SSR。樣式在 globals.css 的 .fx-*。
 */
const POOL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const COUNT = 1400;

function noise() {
  let s = "";
  for (let i = 0; i < COUNT; i++) s += POOL[(Math.random() * POOL.length) | 0];
  return s;
}

export function CardFx({ tint }: { tint?: string }) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const layer = ref.current;
    const card = layer?.parentElement;
    if (!layer || !card) return;
    const ok = window.matchMedia("(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)");
    const chars = layer.querySelector<HTMLElement>("[data-fx-chars]")!;
    const ring = layer.querySelector<HTMLElement>("[data-fx-ring]")!;
    let last = 0;
    let raf = 0;

    const place = (e: PointerEvent, origin = false) => {
      const r = card.getBoundingClientRect();
      const x = `${e.clientX - r.left}px`;
      const y = `${e.clientY - r.top}px`;
      card.style.setProperty("--fx-x", x);
      card.style.setProperty("--fx-y", y);
      if (origin) { card.style.setProperty("--fx-x0", x); card.style.setProperty("--fx-y0", y); }
    };
    const enter = (e: PointerEvent) => {
      if (!ok.matches || e.pointerType !== "mouse") return;
      place(e, true);
      chars.textContent = noise();
      ring.removeAttribute("data-go");
      void ring.offsetWidth; // 重新觸發擴散動畫
      ring.setAttribute("data-go", "");
      card.dataset.fx = "on";
    };
    const move = (e: PointerEvent) => {
      if (card.dataset.fx !== "on") return;
      place(e);
      const now = performance.now();
      if (now - last < 70) return;
      last = now;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { chars.textContent = noise(); });
    };
    const leave = () => { delete card.dataset.fx; };

    card.addEventListener("pointerenter", enter);
    card.addEventListener("pointermove", move);
    card.addEventListener("pointerleave", leave);
    return () => {
      cancelAnimationFrame(raf);
      card.removeEventListener("pointerenter", enter);
      card.removeEventListener("pointermove", move);
      card.removeEventListener("pointerleave", leave);
    };
  }, []);

  return (
    <span ref={ref} aria-hidden className="fx-layer" style={tint ? ({ "--fx-tint": tint } as React.CSSProperties) : undefined}>
      <span className="fx-glow" />
      <span className="fx-chars" data-fx-chars />
      <span className="fx-ring" data-fx-ring />
    </span>
  );
}
