"use client";

import { createContext, useContext, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { IconMoon, IconSun } from "@tabler/icons-react";

/**
 * 後台專用深淺色（前台固定白）。Roy 2026-09-08：切換要像「窗簾從上往下拉」。
 * 做法：先把一塊全螢幕的布從上滑下來蓋住畫面 → 布蓋滿的瞬間換主題 → 布再往下滑走。
 * 主題存在 localStorage `fju-dash-theme`；`dark` class 只加在後台根元素，不影響前台。
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

const Ctx = createContext<{ dark: boolean; toggle: () => void }>({ dark: false, toggle: () => {} });

export function DashThemeRoot({ children }: { children: ReactNode }) {
  // 用 useSyncExternalStore 讀 localStorage：SSR 一律淺色，client 掛載後直接拿到存的值，不在 effect 裡 setState
  const dark = useSyncExternalStore(subscribe, readDark, () => false);
  const [curtain, setCurtain] = useState<"idle" | "down" | "up">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function toggle() {
    if (curtain !== "idle") return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const next = !dark;
    const commit = () => writeDark(next);
    if (reduced) { commit(); return; }
    setCurtain("down");
    timer.current = setTimeout(() => {
      commit();
      setCurtain("up");
      timer.current = setTimeout(() => setCurtain("idle"), 520);
    }, 480);
  }

  return (
    <Ctx.Provider value={{ dark, toggle }}>
      <div className={`${dark ? "dark" : ""} contents`}>
        {children}
        <div aria-hidden className={`theme-curtain ${curtain === "down" ? "theme-curtain-down" : curtain === "up" ? "theme-curtain-up" : ""}`} style={{ background: dark ? "oklch(0.97 0.004 253.89)" : "oklch(0.19 0.012 253.89)" }} />
      </div>
    </Ctx.Provider>
  );
}

export function DashThemeToggle() {
  const { dark, toggle } = useContext(Ctx);
  return (
    <button type="button" onClick={toggle} aria-label={dark ? "切換為淺色" : "切換為深色"} className="relative inline-flex size-9 items-center justify-center overflow-hidden rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
      <IconSun className={`absolute size-[18px] transition-[transform,opacity] duration-300 ${dark ? "translate-y-0 opacity-100" : "-translate-y-6 opacity-0"}`} />
      <IconMoon className={`absolute size-[18px] transition-[transform,opacity] duration-300 ${dark ? "translate-y-6 opacity-0" : "translate-y-0 opacity-100"}`} />
    </button>
  );
}
