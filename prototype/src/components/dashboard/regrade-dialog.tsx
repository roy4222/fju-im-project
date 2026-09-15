"use client";

import { useState } from "react";
import { IconArrowBackUp } from "@tabler/icons-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { buttonVariants } from "@/components/ui/button";
import { INPUT, Stamp, TEXTAREA, fakeTime } from "@/components/dashboard/stamp";

/** 退回重評（Codex 09-10 A-04）：選老師＋理由；該老師的正式評分解鎖成暫存，其他人不受影響。 */
export function RegradeDialog({ groupNo, stageName, evaluators }: { groupNo: string; stageName: string; evaluators: { name: string; score: number | null }[] }) {
  const submitted = evaluators.filter((e) => e.score !== null);
  const [teacher, setTeacher] = useState(submitted[0]?.name ?? "");
  const [reason, setReason] = useState("");
  const [done, setDone] = useState(false);
  return (
    <Dialog onOpenChange={(o) => { if (!o) { setDone(false); setReason(""); } }}>
      <DialogTrigger render={<button type="button" disabled={submitted.length === 0} title={submitted.length === 0 ? "還沒有老師送出，不用退回" : undefined} className={buttonVariants({ size: "sm", variant: "ghost", className: "press rounded-lg" })} />}><IconArrowBackUp /> 退回重評</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        {done ? (
          <Stamp label="已退回" title={`${groupNo}・${teacher}`} description={<>{fakeTime()}・{stageName} 的正式評分已解鎖為暫存，{teacher} 老師會收到通知並重新送出；階段平均在重新送出前不成立。</>} />
        ) : (
          <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); setDone(true); }}>
            <div><DialogTitle className="text-lg font-extrabold">退回重評・{groupNo}</DialogTitle><DialogDescription className="mt-1">{stageName}。只退回選定老師的那一份，原值保留在歷程。</DialogDescription></div>
            <label htmlFor={`rg-t-${groupNo}`} className="flex flex-col gap-1.5 text-sm font-semibold">退回哪位老師的評分
              <select id={`rg-t-${groupNo}`} value={teacher} onChange={(e) => setTeacher(e.target.value)} className={INPUT}>
                {submitted.map((e) => <option key={e.name} value={e.name}>{e.name}・{e.score!.toFixed(2)}</option>)}
              </select>
            </label>
            <label htmlFor={`rg-r-${groupNo}`} className="flex flex-col gap-1.5 text-sm font-semibold">理由（必填）<textarea id={`rg-r-${groupNo}`} required rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例：老師來信表示第 3 項誤植" className={TEXTAREA} /></label>
            <button type="submit" className="btn-fju h-11 text-sm">確認退回</button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
