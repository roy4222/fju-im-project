"use client";

import { useState, type ReactNode } from "react";
import { IconBellRinging } from "@tabler/icons-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { buttonVariants } from "@/components/ui/button";
import { Stamp, TEXTAREA, fakeTime } from "@/components/dashboard/stamp";

export type Recipient = { name: string; detail?: string };

/**
 * 催繳／提醒（Codex 09-10 A-05／A-06）：先列會寄給誰、信件標題預覽，確認後「已排入寄送」。
 * 原型不寄信。首頁、成績、簽核共用。
 */
export function RemindDialog({ recipients, subject, context, trigger, label = "催繳" }: { recipients: Recipient[]; subject: string; context?: string; trigger?: ReactNode; label?: string }) {
  const [done, setDone] = useState(false);
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setTimeout(() => { setDone(false); setNote(""); }, 200); }}>
      <DialogTrigger nativeButton={!trigger} render={trigger ? <span className="contents" /> : <button type="button" className={buttonVariants({ size: "sm", variant: "outline", className: "press rounded-lg" })} />}>
        {trigger ?? <><IconBellRinging /> {label}</>}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        {done ? (
          <Stamp label="已排入寄送" title={`${recipients.length} 封提醒信`} description={<>{fakeTime()} 排入寄送佇列；原型不會真的寄信。寄送結果會出現在操作紀錄。</>}>
            <button type="button" onClick={() => setOpen(false)} className={buttonVariants({ variant: "outline", size: "lg", className: "press mt-1 rounded-lg" })}>關閉</button>
          </Stamp>
        ) : recipients.length === 0 ? (
          <div className="flex flex-col gap-3">
            <DialogTitle className="text-lg font-extrabold">沒有要提醒的人</DialogTitle>
            <DialogDescription>{context ?? "目前這個範圍內沒有未完成的人。"}</DialogDescription>
          </div>
        ) : (
          <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); setDone(true); }}>
            <div>
              <DialogTitle className="text-lg font-extrabold">提醒 {recipients.length} 人</DialogTitle>
              {context ? <DialogDescription className="mt-1">{context}</DialogDescription> : null}
            </div>
            <div className="rounded-lg border border-border text-sm">
              <div className="border-b border-border px-4 py-2.5">
                <p className="text-[11px] font-bold tracking-[0.06em] text-muted-foreground">信件標題</p>
                <p className="mt-0.5 font-semibold">{subject}</p>
              </div>
              <ul className="max-h-48 overflow-y-auto">
                {recipients.map((r) => (
                  <li key={`${r.name}-${r.detail ?? ""}`} className="flex items-center justify-between gap-3 border-b border-border/70 px-4 py-2 last:border-0">
                    <span className="font-semibold">{r.name}</span>
                    {r.detail ? <span className="truncate text-xs text-muted-foreground">{r.detail}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
            <label htmlFor="remind-note" className="flex flex-col gap-1.5 text-sm font-semibold">
              附一句話（選填）
              <textarea id="remind-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="例：請於 8/20 前完成，有困難請直接回信。" className={TEXTAREA} />
            </label>
            <button type="submit" className="btn-fju h-11 text-sm">寄出提醒（{recipients.length}）</button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
