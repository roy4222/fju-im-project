"use client";

import type { ReactNode } from "react";
import { IconCheck } from "@tabler/icons-react";
import { DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { TODAY_YMD } from "@/lib/fixtures";

/**
 * 「收件章」：送出成功的回執（共同視覺語法 #2）。
 * 一次的印章感：圓角邊框、-2deg、一次淡入；不放彩紙、不循環。
 * 只在 Dialog 裡用（內含 DialogTitle／DialogDescription）。
 */
export function Stamp({ label = "已受理", title, description, children }: { label?: string; title: string; description?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 px-2 py-3 text-center">
      <span className="inline-flex -rotate-2 items-center gap-1.5 rounded-lg border-2 border-success px-3 py-1 text-[13px] font-extrabold tracking-[0.08em] text-success-on-subtle duration-200 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-90">
        <IconCheck className="size-4" strokeWidth={3} />
        {label}
      </span>
      <DialogTitle className="text-lg font-extrabold">{title}</DialogTitle>
      {description ? <DialogDescription className="max-w-sm">{description}</DialogDescription> : null}
      {children}
    </div>
  );
}

/** 原型的假時間：以 TODAY_YMD 為基準，不用 new Date()。 */
export function fakeTime(hhmm = "14:32"): string {
  return `${TODAY_YMD} ${hhmm}`;
}

/** 儲存狀態小圓點（共同視覺語法 #3）：空心＝未儲存、實心＝已儲存 */
export function SaveDot({ saved, at }: { saved: boolean; at?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" aria-live="polite">
      <span className={`inline-block size-2 rounded-full border-[1.5px] ${saved ? "border-success bg-success" : "border-muted-foreground"}`} aria-hidden />
      {saved ? `已儲存 ${at ?? ""}`.trim() : "未儲存"}
    </span>
  );
}

/** 表單共用樣式（與 new-item-dialog 一致） */
export const INPUT = "h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none transition-[border-color,box-shadow] focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25";
export const TEXTAREA = "w-full rounded-lg border border-input bg-background px-3 py-2 text-sm font-normal outline-none transition-[border-color,box-shadow] focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25";
