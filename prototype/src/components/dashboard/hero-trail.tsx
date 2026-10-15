"use client";

import { useSyncExternalStore } from "react";
import PixelTrail from "@/components/dashboard/pixel-trail";

/**
 * 「現在」橫幅的金屬像素拖尾（原型第 4 輪，Roy 2026-10-15 指定 React Bits Pixel Trail）。
 * 放在 .hero 第一個子元素：鋪滿橫幅、壓在文字與按鈕底下、pointer-events: none，不擋點擊。
 * 新鮮的像素是銀色、變老時轉淡金，shine 開滿讓每格有斜角高光（金屬感）；不加 gooey，保留方塊像素。
 * 只在有滑鼠（hover + 精準指標）且沒開「減少動態」時掛上；觸控裝置、SSR 都不渲染。
 */
const QUERY = "(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)";

function subscribe(cb: () => void) {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

export function HeroTrail() {
  const on = useSyncExternalStore(subscribe, () => window.matchMedia(QUERY).matches, () => false);
  if (!on) return null;
  return (
    <div aria-hidden data-hero-trail className="hero-trail">
      <PixelTrail
        gridSize={64}
        trailSize={0.05}
        maxAge={800}
        interpolate={6}
        gooeyFilter={false}
        color="#c9d1dc"
        trailColor="#bea468"
        shape="square"
        gap={0.16}
        decay="fade"
        shine={1}
        glow={0.15}
      />
    </div>
  );
}
