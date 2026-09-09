"use client";

import { createContext, useContext, useRef, useSyncExternalStore, type ReactNode } from "react";
import { IconMoon, IconSun } from "@tabler/icons-react";

/**
 * 後台專用深淺色（前台固定白）。
 * 2026-09-09 Roy：窗簾會閃白、「想要奢華沒奢華起來」→ 改成從按鈕位置一圈擴開（View Transitions API）。
 * 不支援的瀏覽器直接切換；reduced-motion 也直接切換。主題存 localStorage `fju-dash-theme`，
 * `dark` class 只加在後台根元素，不影響前台。
 */
const KEY = "fju-dash-theme";
const listeners = new Set<() => void>();
function subscribe(cb: () => void) {
  listeners.add(cb);
  window.addEventListener("storage", cb);
  return () => { listeners.delete(cb); window.removeEventListener("storage", cb); };
}
function readDark() {
  try { return localStorage.getItem(KEY) === "dark"; } catch { return false; }
}
function writeDark(v: boolean) {
  try { localStorage.setItem(KEY, v ? "dark" : "light"); } catch {}
  listeners.forEach((l) => l());
}

type DocWithVT = Document & { startViewTransition?: (cb: () => void) => { finished: Promise<void> } };

const Ctx = createContext<{ dark: boolean; toggle: (origin?: { x: number; y: number }) => void }>({ dark: false, toggle: () => {} });

export function DashThemeRoot({ children }: { children: ReactNode }) {
  const dark = useSyncExternalStore(subscribe, readDark, () => false);
  const busy = useRef(false);

  function toggle(origin?: { x: number; y: number }) {
    if (busy.current) return;
    const next = !dark;
    const doc = document as DocWithVT;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!doc.startViewTransition || reduced || !origin) { writeDark(next); return; }
    const x = origin.x, y = origin.y;
    const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    const root = document.documentElement;
    root.style.setProperty("--reveal-x", `${x}px`);
    root.style.setProperty("--reveal-y", `${y}px`);
    root.style.setProperty("--reveal-r", `${r}px`);
    busy.current = true;
    const vt = doc.startViewTransition(() => writeDark(next));
    vt.finished.finally(() => { busy.current = false; });
  }

  return (
    <Ctx.Provider value={{ dark, toggle }}>
      <div className={`${dark ? "dark" : ""} contents text-foreground`}>
        {children}
      </div>
    </Ctx.Provider>
  );
}

export function DashThemeToggle() {
  const { dark, toggle } = useContext(Ctx);
  return (
    <button
      type="button"
      onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); toggle({ x: r.left + r.width / 2, y: r.top + r.height / 2 }); }}
      aria-label={dark ? "切換為淺色" : "切換為深色"}
      className="relative inline-flex size-9 items-center justify-center overflow-hidden rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      <IconSun className={`absolute size-[18px] transition-[transform,opacity] duration-300 ${dark ? "translate-y-0 opacity-100" : "-translate-y-6 opacity-0"}`} />
      <IconMoon className={`absolute size-[18px] transition-[transform,opacity] duration-300 ${dark ? "translate-y-6 opacity-0" : "translate-y-0 opacity-100"}`} />
    </button>
  );
}
