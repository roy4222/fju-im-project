"use client";

import { useSyncExternalStore } from "react";

/**
 * 頭像（原型第 3 輪，Roy 2026-10-15）：預設 12 張插畫（01～08 學生、09～12 老師），假資料每人配一張；
 * 使用者可以「換頭像」：上傳照片或從 12 張選一張。選擇存在 localStorage，頂列、組員、老師卡都讀同一份。
 * 正式版換成帳號資料的 avatarUrl。
 */
export const AVATAR_PRESETS = Array.from({ length: 12 }, (_, i) => `/avatars/avatar-${String(i + 1).padStart(2, "0")}.png`);

/** 假資料的預設配圖：本組五人與四位老師固定，其他學生依 id 落在 01～08 */
const FIXED: Record<string, number> = {
  "u-401": 1, "u-402": 2, "u-403": 3, "u-404": 4, "u-405": 5,
  "u-102": 9, "u-103": 10, "u-104": 11, "u-105": 12,
};

export function defaultAvatar(id: string): string {
  const n = FIXED[id] ?? ([...id].reduce((a, c) => a + c.charCodeAt(0), 0) % 8) + 1;
  return AVATAR_PRESETS[n - 1];
}

const KEY = "fju-proto-avatars";
const EMPTY: Record<string, string> = {};
let cache: Record<string, string> | null = null;
const listeners = new Set<() => void>();

function read(): Record<string, string> {
  if (cache) return cache;
  try {
    cache = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, string>;
  } catch {
    cache = {};
  }
  return cache;
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  const onStorage = (e: StorageEvent) => { if (e.key === KEY) { cache = null; fn(); } };
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(fn); window.removeEventListener("storage", onStorage); };
}

export function useAvatar(id: string): string {
  const all = useSyncExternalStore(subscribe, read, () => EMPTY);
  return all[id] ?? defaultAvatar(id);
}

export function setAvatar(id: string, src: string) {
  cache = { ...read(), [id]: src };
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* 照片太大存不下就只留在這次 */ }
  listeners.forEach((l) => l());
}
