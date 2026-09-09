"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { IconChevronLeft, IconChevronRight } from "@tabler/icons-react";

/**
 * 首頁輪播：一次顯示 perView 張，箭頭與圓點切頁，自動輪播 6 秒，
 * hover／focus 暫停，尊重 prefers-reduced-motion（規格 §14.2）。
 * 手機一欄、平板兩欄、桌機 perView 欄。
 */
export function Carousel({ items, perView = 4, label, autoplay = true, interval = 6000 }: { items: ReactNode[]; perView?: 3 | 4; label: string; autoplay?: boolean; interval?: number }) {
  const [page, setPage] = useState(0);
  const [cols, setCols] = useState<number>(perView);
  const [paused, setPaused] = useState(false);
  const reduced = useRef(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    reduced.current = mq.matches;
    const update = () => {
      const w = window.innerWidth;
      setCols(w < 640 ? 1 : w < 1024 ? 2 : perView);
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [perView]);

  const pages = Math.max(1, Math.ceil(items.length / cols));
  const safePage = Math.min(page, pages - 1);
  const goTo = useCallback((p: number) => setPage(((p % pages) + pages) % pages), [pages]);

  useEffect(() => {
    if (!autoplay || paused || reduced.current || pages <= 1) return;
    const t = window.setInterval(() => setPage((p) => (p + 1) % pages), interval);
    return () => window.clearInterval(t);
  }, [autoplay, paused, pages, interval]);

  return (
    <div
      className="relative"
      role="region"
      aria-roledescription="輪播"
      aria-label={label}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <div className="overflow-hidden">
        <div
          className="flex transition-transform duration-500 ease-out motion-reduce:transition-none"
          style={{ transform: `translateX(-${safePage * 100}%)` }}
        >
          {Array.from({ length: pages }).map((_, p) => (
            <div key={p} className="grid w-full shrink-0 gap-6 px-0.5" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }} aria-hidden={p !== safePage}>
              {items.slice(p * cols, p * cols + cols).map((it, i) => (
                <div key={i}>{it}</div>
              ))}
            </div>
          ))}
        </div>
      </div>

      {pages > 1 ? (
        <>
          <button
            type="button"
            onClick={() => goTo(safePage - 1)}
            aria-label="上一頁"
            className="absolute top-[110px] -left-4 z-10 inline-flex size-11 items-center justify-center rounded-full border border-border bg-background text-primary shadow-md transition-colors hover:bg-brand hover:text-brand-foreground lg:-left-16"
          >
            <IconChevronLeft className="size-5" />
          </button>
          <button
            type="button"
            onClick={() => goTo(safePage + 1)}
            aria-label="下一頁"
            className="absolute top-[110px] -right-4 z-10 inline-flex size-11 items-center justify-center rounded-full border border-border bg-background text-primary shadow-md transition-colors hover:bg-brand hover:text-brand-foreground lg:-right-16"
          >
            <IconChevronRight className="size-5" />
          </button>
          <div className="mt-6 flex justify-center gap-2" role="tablist" aria-label="輪播頁次">
            {Array.from({ length: pages }).map((_, p) => (
              <button
                key={p}
                type="button"
                role="tab"
                aria-selected={p === safePage}
                aria-label={`第 ${p + 1} 頁`}
                onClick={() => goTo(p)}
                className={`h-2 rounded-full transition-all ${p === safePage ? "w-6 bg-brand" : "w-2 bg-border hover:bg-muted-foreground/50"}`}
              />
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
