"use client";

import { useState } from "react";
import { IconCheck, IconPencil } from "@tabler/icons-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { buttonVariants } from "@/components/ui/button";

/** 管理員更正（規格 §7.5）：保留原值、新值、原因；原始老師輸入不覆蓋。 */
export function OverrideDialog({ groupNo, original }: { groupNo: string; original: number }) {
  const [done, setDone] = useState(false);
  const [value, setValue] = useState(original.toFixed(2));
  const [reason, setReason] = useState("");
  return (
    <Dialog onOpenChange={(o) => !o && setDone(false)}>
      <DialogTrigger render={<button type="button" className={buttonVariants({ size: "sm", variant: "outline", className: "press w-14 rounded-lg" })} />}>
        <IconPencil /> 更正
      </DialogTrigger>
      <DialogContent className="max-w-md">
        {done ? (
          <div className="flex flex-col items-center gap-3 text-center">
            <span className="inline-flex size-12 items-center justify-center rounded-full bg-success-subtle text-success-on-subtle"><IconCheck className="size-6" /></span>
            <DialogTitle className="text-lg font-extrabold">已更正 {groupNo}</DialogTitle>
            <DialogDescription className="tabular">{original.toFixed(2)} → {Number(value).toFixed(2)}。原值、理由與操作者已寫入紀錄。</DialogDescription>
          </div>
        ) : (
          <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); setDone(true); }}>
            <div>
              <DialogTitle className="text-lg font-extrabold">更正 {groupNo} 最終成績</DialogTitle>
              <DialogDescription className="mt-1">原始老師輸入不會被覆蓋。</DialogDescription>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg bg-muted px-4 py-3"><p className="text-xs text-muted-foreground">原值</p><p className="tabular text-xl font-extrabold">{original.toFixed(2)}</p></div>
              <label className="flex flex-col gap-1 text-xs font-semibold text-muted-foreground">新值<input type="number" step="0.01" min={0} max={100} required value={value} onChange={(e) => setValue(e.target.value)} className="tabular h-11 rounded-lg border border-input px-3 text-xl font-extrabold text-foreground outline-none focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25" /></label>
            </div>
            <label className="flex flex-col gap-1.5 text-sm font-semibold">理由（必填）<textarea required rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例：老師來信更正第 3 項分數誤植" className="rounded-lg border border-input px-3 py-2 font-normal outline-none focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25" /></label>
            <button type="submit" className="btn-fju h-10 text-sm">確認更正</button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
