"use client";

import { useState } from "react";
import { IconRotate } from "@tabler/icons-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { buttonVariants } from "@/components/ui/button";
import { Stamp, TEXTAREA, fakeTime } from "@/components/dashboard/stamp";

/**
 * 管理員重置（Codex 09-10 A-06）：先顯示目前版本、這組已同意的人（這些簽署會失效）、老師是否已簽，再填原因。
 * 不可代簽。
 */
export function ResetDialog({ groupNo, version, signed, teacher }: { groupNo: string; version: number; signed: string[]; teacher: { name: string; signed: boolean } | null }) {
  const [done, setDone] = useState(false);
  const [reason, setReason] = useState("");
  const affected = signed.length + (teacher?.signed ? 1 : 0);
  return (
    <Dialog onOpenChange={(o) => { if (!o) { setDone(false); setReason(""); } }}>
      <DialogTrigger render={<button type="button" className={buttonVariants({ size: "sm", variant: "outline", className: "press rounded-lg" })} />}><IconRotate /> 重置</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        {done ? (
          <Stamp label="已重置" title={`${groupNo}・v${version}`} description={<>{fakeTime()}・{affected} 筆簽署失效並保留歷史；全組與老師需重新同意，已通知。</>} />
        ) : (
          <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); setDone(true); }}>
            <div><DialogTitle className="text-lg font-extrabold">重置 {groupNo} 簽核</DialogTitle><DialogDescription className="mt-1">系辦不能代替任何人同意，只能重開或重置。重置後所有人要重新同意。</DialogDescription></div>
            <dl className="grid grid-cols-[6rem_1fr] gap-y-2 rounded-lg border border-border px-4 py-3 text-sm">
              <dt className="text-muted-foreground">目前版本</dt><dd className="tabular font-semibold">v{version}</dd>
              <dt className="text-muted-foreground">將失效的簽署</dt>
              <dd className="font-semibold">{signed.length ? <>{signed.join("、")} <span className="tabular text-xs font-normal text-muted-foreground">（{signed.length} 位學生）</span></> : <span className="font-normal text-muted-foreground">還沒有學生同意</span>}</dd>
              <dt className="text-muted-foreground">指導老師</dt>
              <dd className="font-semibold">{teacher ? <>{teacher.name}・{teacher.signed ? <span className="text-destructive">已簽，會一併失效</span> : <span className="font-normal text-muted-foreground">尚未簽</span>}</> : <span className="font-normal text-muted-foreground">尚未指派</span>}</dd>
            </dl>
            <label htmlFor={`rs-${groupNo}`} className="flex flex-col gap-1.5 text-sm font-semibold">原因（必填）<textarea id={`rs-${groupNo}`} required rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例：組員異動，名單已更新" className={TEXTAREA} /></label>
            <button type="submit" className={buttonVariants({ variant: "destructive", size: "lg", className: "press h-11 rounded-lg" })}>確認重置（{affected} 筆簽署失效）</button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
