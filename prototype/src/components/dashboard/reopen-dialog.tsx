"use client";

import { useState } from "react";
import { IconLockOpen, IconCheck } from "@tabler/icons-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { buttonVariants } from "@/components/ui/button";

/**
 * 管理員對指定組別重新開放（規格 §4.6）：必填理由與新期限；先看影響再確認。
 * Codex 09-10 A-06：列原截止、新截止、目前採計版本、會收到通知的人；確認後由父層即時改列表狀態。
 */
export function ReopenDialog({ groupNo, itemTitle, originalDue, currentVersion, notify = [], onDone, trigger }: {
  groupNo: string;
  itemTitle: string;
  originalDue?: string;
  /** 目前採計版本；沒有代表尚未繳交 */
  currentVersion?: number;
  /** 會收到通知的人名 */
  notify?: string[];
  onDone?: (newDue: string) => void;
  trigger?: React.ReactElement;
}) {
  const [done, setDone] = useState(false);
  const [reason, setReason] = useState("");
  const [date, setDate] = useState("");
  const field = "h-10 rounded-lg border border-input px-3 font-normal outline-none focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25";
  return (
    <Dialog onOpenChange={(o) => { if (!o) { setDone(false); setReason(""); setDate(""); } }}>
      <DialogTrigger render={trigger ?? <button type="button" className={buttonVariants({ size: "sm", variant: "outline", className: "press rounded-lg" })} />}>
        <IconLockOpen /> 重新開放
      </DialogTrigger>
      <DialogContent className="max-w-md">
        {done ? (
          <div className="flex flex-col items-center gap-3 text-center">
            <span className="inline-flex size-12 items-center justify-center rounded-full bg-success-subtle text-success-on-subtle"><IconCheck className="size-6" /></span>
            <DialogTitle className="text-lg font-extrabold">已重新開放 {groupNo}</DialogTitle>
            <DialogDescription>新期限 {date} 23:59。舊版本保留，理由與操作者已寫入紀錄；通知會在正式版寄出，原型不寄信。</DialogDescription>
          </div>
        ) : (
          <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); setDone(true); onDone?.(date); }}>
            <div>
              <DialogTitle className="text-lg font-extrabold">重新開放 {groupNo}</DialogTitle>
              <DialogDescription className="mt-1">{itemTitle}</DialogDescription>
            </div>
            <label className="flex flex-col gap-1.5 text-sm font-semibold">新期限<input type="date" required value={date} min={originalDue} onChange={(e) => setDate(e.target.value)} className={field} /></label>
            <label className="flex flex-col gap-1.5 text-sm font-semibold">理由（必填）<textarea required rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例：組員住院，延至 08-22" className="rounded-lg border border-input px-3 py-2 font-normal outline-none focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25" /></label>
            <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1.5 rounded-lg bg-muted px-4 py-3 text-xs leading-relaxed">
              <dt className="text-muted-foreground">原截止</dt><dd className="tabular font-semibold">{originalDue ?? "—"}</dd>
              <dt className="text-muted-foreground">新截止</dt><dd className="tabular font-semibold">{date ? `${date} 23:59` : "（上面選）"}</dd>
              <dt className="text-muted-foreground">目前採計</dt><dd className="font-semibold">{currentVersion ? `v${currentVersion}，重送後成 v${currentVersion + 1}，舊版保留` : "尚未繳交，重送後為 v1"}</dd>
              <dt className="text-muted-foreground">會通知</dt><dd className="font-semibold">{notify.length ? notify.join("、") : "該組成員與指導老師"}</dd>
              <dt className="text-muted-foreground">範圍</dt><dd>只有 {groupNo} 可在新期限前重送；其他組別不變。</dd>
            </dl>
            <button type="submit" className="btn-fju h-10 text-sm">確認重新開放</button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
