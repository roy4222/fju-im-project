"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

/**
 * 換頁進度條（Roy 2026-09-08：按下去要有回饋）。
 * 點到站內連結就從導覽列下方長出一條橘線；路由真的換了就補滿並淡出。
 * 不依賴 router event：監聽 document 的 click，pathname／searchParams 變動視為完成。
 */
export function TopLoader() {
  const pathname = usePathname();
  const search = useSearchParams();
  const [state, setState] = useState<"idle" | "loading" | "done">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const routeKey = `${pathname}?${search.toString()}`;
  const lastKey = useRef(routeKey);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin) return;
      const same = url.pathname === location.pathname && url.search === location.search;
      if (same) return; // 純錨點或同頁：不顯示
      setState("loading");
    }
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  useEffect(() => {
    if (lastKey.current === routeKey) return;
    lastKey.current = routeKey;
    setState("done");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 420);
  }, [routeKey]);

  return (
    <div aria-hidden className="pointer-events-none fixed inset-x-0 top-20 z-[60] h-[3px]">
      <div className={`h-full origin-left bg-brand shadow-[0_0_8px_rgba(229,110,0,0.6)] ${state === "loading" ? "top-loader-run" : state === "done" ? "top-loader-done" : "top-loader-idle"}`} />
    </div>
  );
}
