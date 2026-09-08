"use client";

import { useState } from "react";
import { IconCheck, IconHandGrab, IconUserPlus, IconAlertTriangle } from "@tabler/icons-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { buttonVariants } from "@/components/ui/button";
import { TEACHERS } from "@/lib/fixtures";

/** 老師認領產學組（規格 §5.4）：first-success；同時操作只有一位成功。 */
export function ClaimDialog({ groupNo, title, size = "sm" }: { groupNo: string; title: string; size?: "sm" | "lg" }) {
  const [state, setState] = useState<"idle" | "ok" | "conflict">("idle");
  return (
    <Dialog onOpenChange={(o) => !o && setState("idle")}>
      <DialogTrigger render={<button type="button" className={buttonVariants({ size, variant: "outline", className: "press rounded-lg" })} />}><IconHandGrab /> 指定為我的組別</DialogTrigger>
      <DialogContent className="max-w-md">
        {state === "ok" ? (
          <div className="flex flex-col items-center gap-3 text-center"><span className="inline-flex size-12 items-center justify-center rounded-full bg-success-subtle text-success-on-subtle"><IconCheck className="size-6" /></span><DialogTitle className="text-lg font-extrabold">已認領 {groupNo}</DialogTitle><DialogDescription>{title}。已通知全組與系辦。</DialogDescription></div>
        ) : state === "conflict" ? (
          <div className="flex flex-col items-center gap-3 text-center"><span className="inline-flex size-12 items-center justify-center rounded-full bg-warning-subtle text-warning-on-subtle"><IconAlertTriangle className="size-6" /></span><DialogTitle className="text-lg font-extrabold">已被其他老師認領</DialogTitle><DialogDescription>{groupNo} 剛由王雅玲老師認領成功。需要調整請洽系辦重派。</DialogDescription></div>
        ) : (
          <div className="flex flex-col gap-4">
            <div><DialogTitle className="text-lg font-extrabold">認領 {groupNo}</DialogTitle><DialogDescription className="mt-1">{title}。先按先得；同時操作只有一位會成功。</DialogDescription></div>
            <div className="flex gap-2">
              <button type="button" onClick={() => setState("ok")} className="btn-fju h-10 flex-1 text-sm">確認認領</button>
              <button type="button" onClick={() => setState("conflict")} className={buttonVariants({ variant: "outline", size: "lg", className: "press rounded-lg" })}>模擬衝突</button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** 管理員指派／重派指導老師（規格 §5.4）：必填理由。 */
export function AssignDialog({ groupNo, current }: { groupNo: string; current?: string }) {
  const [done, setDone] = useState(false);
  const [teacher, setTeacher] = useState(TEACHERS[0].name);
  const [reason, setReason] = useState("");
  return (
    <Dialog onOpenChange={(o) => !o && setDone(false)}>
      <DialogTrigger render={<button type="button" className={buttonVariants({ size: "sm", variant: "ghost", className: "press rounded-lg" })} />}><IconUserPlus /> {current ? "重派" : "指派老師"}</DialogTrigger>
      <DialogContent className="max-w-md">
        {done ? (
          <div className="flex flex-col items-center gap-3 text-center"><span className="inline-flex size-12 items-center justify-center rounded-full bg-success-subtle text-success-on-subtle"><IconCheck className="size-6" /></span><DialogTitle className="text-lg font-extrabold">{groupNo} 已指派 {teacher}</DialogTitle><DialogDescription>理由與操作者已寫入紀錄。</DialogDescription></div>
        ) : (
          <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); setDone(true); }}>
            <div><DialogTitle className="text-lg font-extrabold">{current ? "重派" : "指派"}指導老師・{groupNo}</DialogTitle>{current ? <DialogDescription className="mt-1">目前：{current}</DialogDescription> : null}</div>
            <label className="flex flex-col gap-1.5 text-sm font-semibold">老師<select value={teacher} onChange={(e) => setTeacher(e.target.value)} className="h-10 rounded-lg border border-input px-3 font-normal outline-none focus-visible:border-brand">{TEACHERS.map((t) => <option key={t.id}>{t.name}</option>)}</select></label>
            <label className="flex flex-col gap-1.5 text-sm font-semibold">理由（必填）<textarea required rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例：抽籤結果" className="rounded-lg border border-input px-3 py-2 font-normal outline-none focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25" /></label>
            <button type="submit" className="btn-fju h-10 text-sm">確認</button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
