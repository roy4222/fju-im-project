"use client";

import { useSyncExternalStore } from "react";
import { GRADING_GROUPS, type GradeRecord } from "@/lib/teacher-v2";

/**
 * 老師評分進度（原型）：存在 sessionStorage，換組、回總覽、回首頁都看得到同一份；關掉分頁就回到種子資料。
 * 正式版換成 API，形狀照 GradeRecord。
 */
const KEY = "fju-proto-grading";
const EMPTY: Record<string, GradeRecord> = {};
let cache: Record<string, GradeRecord> | null = null;
const listeners = new Set<() => void>();

function read(): Record<string, GradeRecord> {
  if (cache) return cache;
  try {
    cache = JSON.parse(sessionStorage.getItem(KEY) ?? "{}") as Record<string, GradeRecord>;
  } catch {
    cache = {};
  }
  return cache;
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 只有改過的組才在裡面；沒改過的用種子 */
export function useGradeRecords(): Record<string, GradeRecord> {
  return useSyncExternalStore(subscribe, read, () => EMPTY);
}

export function useGradeRecord(groupId: string): GradeRecord {
  const all = useGradeRecords();
  return all[groupId] ?? GRADING_GROUPS.find((g) => g.groupId === groupId)!.seed;
}

export function saveGradeRecord(groupId: string, rec: GradeRecord) {
  cache = { ...read(), [groupId]: rec };
  sessionStorage.setItem(KEY, JSON.stringify(cache));
  listeners.forEach((l) => l());
}

/** 「10/15 14:02」：日期跟著真實時鐘（評分在學期後段，不用原型的 08-17） */
export function stampNow(): string {
  const d = new Date();
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
