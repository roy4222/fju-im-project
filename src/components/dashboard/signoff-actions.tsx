"use client";

import { useState } from "react";
import { IconCheck, IconRotate, IconX } from "@tabler/icons-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { buttonVariants } from "@/components/ui/button";

/** 本人同意／不同意（規格 §8.1）：每人只有自己的一票；不同意必填原因。 */
export function ApproveActions({ who, title, packageVersion, onDone }: { who: string; title: string; packageVersion: number; onDone?: (r: "approved" | "declined") => void }) {
  const [state, setState] = useState<"idle" | "approved" | "declined">("idle");
  const [reason, setReason] = useState("");
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const stamp = () => new Date().toLocaleString("zh-TW", { hour12: false });

  if (state === "approved") {
    return <div className="flex items-center gap-2 rounded-lg bg-success-subtle px-4 py-3 text-sm font-semibold text-success-on-subtle"><IconCheck className="size-4" /> 你已於 {stamp()} 同意 v{packageVersion}。已記錄帳號、時間與內容版本。</div>;
  }
  if (state === "declined") {
    return <div className="flex items-center gap-2 rounded-lg bg-warning-subtle px-4 py-3 text-sm font-semibold text-warning-on-subtle"><IconRotate className="size-4" /> 已退回修正，原因已通知系辦與全組。</div>;
  }
  return (
    <div className="flex flex-wrap gap-2">
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogTrigger render={<button type="button" className="btn-fju h-10 px-4 text-sm" />}><IconCheck className="size-4" /> 我已閱讀並同意</DialogTrigger>
        <DialogContent className="max-w-md">
          <DialogTitle className="text-lg font-extrabold">確認同意</DialogTitle>
          <DialogDescription>{title}・v{packageVersion}。以 {who} 的身分同意，只代表你自己的一票。</DialogDescription>
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={() => { setConfirm(false); setState("approved"); onDone?.("approved"); }} className="btn-fju h-10 flex-1 text-sm">確認同意</button>
            <button type="button" onClick={() => setConfirm(false)} className={buttonVariants({ variant: "outline", size: "lg", className: "press flex-1 rounded-lg" })}>取消</button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger render={<button type="button" className={buttonVariants({ variant: "outline", size: "lg", className: "press rounded-lg" })} />}><IconX /> 不同意</DialogTrigger>
        <DialogContent className="max-w-md">
          <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); setOpen(false); setState("declined"); onDone?.("declined"); }}>
            <div><DialogTitle className="text-lg font-extrabold">不同意並退回</DialogTitle><DialogDescription className="mt-1">會回到修正狀態；修正後全組重走一次。</DialogDescription></div>
            <label className="flex flex-col gap-1.5 text-sm font-semibold">原因（必填）<textarea required rows={3} value={reason} onChange={(e) => setReason(e.target.value)} className="rounded-lg border border-input px-3 py-2 font-normal outline-none focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25" /></label>
            <button type="submit" className={buttonVariants({ variant: "destructive", size: "lg", className: "press rounded-lg" })}>送出退回</button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** 管理員：重開／重置（必填原因，不可代簽） */
export function ResetDialog({ groupNo }: { groupNo: string }) {
  const [done, setDone] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <Dialog onOpenChange={(o) => !o && setDone(false)}>
      <DialogTrigger render={<button type="button" className={buttonVariants({ size: "sm", variant: "outline", className: "press rounded-lg" })} />}><IconRotate /> 重置</DialogTrigger>
      <DialogContent className="max-w-md">
        {done ? (
          <div className="flex flex-col items-center gap-3 text-center"><span className="inline-flex size-12 items-center justify-center rounded-full bg-success-subtle text-success-on-subtle"><IconCheck className="size-6" /></span><DialogTitle className="text-lg font-extrabold">已重置 {groupNo}</DialogTitle><DialogDescription>舊同意失效並保留歷史；全組需重新同意。</DialogDescription></div>
        ) : (
          <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); setDone(true); }}>
            <div><DialogTitle className="text-lg font-extrabold">重置 {groupNo} 簽核</DialogTitle><DialogDescription className="mt-1">系辦不能代替任何人同意，只能重開或重置。</DialogDescription></div>
            <label className="flex flex-col gap-1.5 text-sm font-semibold">原因（必填）<textarea required rows={3} value={reason} onChange={(e) => setReason(e.target.value)} className="rounded-lg border border-input px-3 py-2 font-normal outline-none focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25" /></label>
            <button type="submit" className="btn-fju h-10 text-sm">確認重置</button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
