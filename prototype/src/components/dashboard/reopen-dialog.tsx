"use client";

import { useState } from "react";
import { IconLockOpen, IconCheck } from "@tabler/icons-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { buttonVariants } from "@/components/ui/button";

/** 管理員對指定組別重新開放（規格 §4.6）：必填理由與新期限；先預覽影響再確認。 */
export function ReopenDialog({ groupNo, itemTitle }: { groupNo: string; itemTitle: string }) {
  const [done, setDone] = useState(false);
  const [reason, setReason] = useState("");
  const [date, setDate] = useState("");
  return (
    <Dialog onOpenChange={(o) => !o && setDone(false)}>
      <DialogTrigger render={<button type="button" className={buttonVariants({ size: "sm", variant: "outline", className: "press rounded-lg" })} />}>
        <IconLockOpen /> 重新開放
      </DialogTrigger>
      <DialogContent className="max-w-md">
        {done ? (
          <div className="flex flex-col items-center gap-3 text-center">
            <span className="inline-flex size-12 items-center justify-center rounded-full bg-success-subtle text-success-on-subtle"><IconCheck className="size-6" /></span>
            <DialogTitle className="text-lg font-extrabold">已重新開放 {groupNo}</DialogTitle>
            <DialogDescription>新期限 {date}。舊版本保留，操作已寫入紀錄。</DialogDescription>
          </div>
        ) : (
          <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); setDone(true); }}>
            <div>
              <DialogTitle className="text-lg font-extrabold">重新開放 {groupNo}</DialogTitle>
              <DialogDescription className="mt-1">{itemTitle}</DialogDescription>
            </div>
            <label className="flex flex-col gap-1.5 text-sm font-semibold">新期限<input type="date" required value={date} onChange={(e) => setDate(e.target.value)} className="h-10 rounded-lg border border-input px-3 font-normal outline-none focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25" /></label>
            <label className="flex flex-col gap-1.5 text-sm font-semibold">理由（必填）<textarea required rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例：組員住院，延至 08-22" className="rounded-lg border border-input px-3 py-2 font-normal outline-none focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25" /></label>
            <div className="rounded-lg bg-muted px-4 py-3 text-xs leading-relaxed text-muted-foreground">
              影響：只有 {groupNo} 可在新期限前重送；其他組別不變。既有版本不刪除；理由與操作者寫入操作紀錄。
            </div>
            <button type="submit" className="btn-fju h-10 text-sm">確認重新開放</button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
