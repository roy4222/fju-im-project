"use client";

import { useState } from "react";
import { IconCheck, IconPlus, IconLock } from "@tabler/icons-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { buttonVariants } from "@/components/ui/button";

/** 老師建立／編輯合作案（規格 §6.2）：長文字用可拉伸 textarea；聯絡資料私有。 */
export function IndustryFormDialog({ mode = "create", initial }: { mode?: "create" | "edit"; initial?: { company?: string; department?: string; title?: string } }) {
  const [done, setDone] = useState(false);
  const [status, setStatus] = useState<"draft" | "public">("public");
  const input = "h-10 w-full rounded-lg border border-input bg-background px-3 text-sm font-normal outline-none transition-[border-color,box-shadow] focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25";
  const area = "w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm font-normal outline-none transition-[border-color,box-shadow] focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25";
  return (
    <Dialog onOpenChange={(o) => !o && setDone(false)}>
      <DialogTrigger render={mode === "create" ? <button type="button" className="btn-fju h-10 px-4 text-sm" /> : <button type="button" className={buttonVariants({ size: "sm", variant: "outline", className: "press rounded-lg" })} />}>
        {mode === "create" ? <><IconPlus className="size-4" /> 新增合作案</> : "編輯"}
      </DialogTrigger>
      <DialogContent className="max-w-[calc(100%-2rem)] p-0 sm:max-w-2xl" showCloseButton>
        {done ? (
          <div className="flex flex-col items-center gap-3 p-8 text-center"><span className="inline-flex size-12 items-center justify-center rounded-full bg-success-subtle text-success-on-subtle"><IconCheck className="size-6" /></span><DialogTitle className="text-lg font-extrabold">{status === "public" ? "已公開" : "已存為草稿"}</DialogTitle><DialogDescription>公開的合作案登入後都看得到；地址、聯絡人、電話、Email 只有你與系辦看得到。</DialogDescription></div>
        ) : (
          <form className="flex flex-col" onSubmit={(e) => { e.preventDefault(); setDone(true); }}>
            <div className="border-b border-border px-6 py-4"><DialogTitle className="text-lg font-extrabold">{mode === "create" ? "新增合作案" : "編輯合作案"}</DialogTitle><DialogDescription className="mt-0.5">負責老師與發布日由系統帶入。</DialogDescription></div>
            <div className="grid max-h-[60vh] gap-4 overflow-y-auto px-6 py-5 sm:grid-cols-2">
              <label className="flex flex-col gap-1.5 text-sm font-semibold">公司名稱 <span className="sr-only">必填</span><input required defaultValue={initial?.company} className={input} /></label>
              <label className="flex flex-col gap-1.5 text-sm font-semibold">需求部門<input required defaultValue={initial?.department} className={input} /></label>
              <label className="flex flex-col gap-1.5 text-sm font-semibold sm:col-span-2">專題／合作內容<textarea required rows={4} defaultValue={initial?.title} className={area} /></label>
              <label className="flex flex-col gap-1.5 text-sm font-semibold sm:col-span-2">對學生的條件／需求<textarea rows={3} className={area} /></label>
              <label className="flex flex-col gap-1.5 text-sm font-semibold sm:col-span-2">備註<textarea rows={2} className={area} /><span className="text-xs font-normal text-muted-foreground"><label className="mr-3 inline-flex items-center gap-1.5"><input type="radio" name="note" defaultChecked className="accent-[var(--brand)]" /> 公開</label><label className="inline-flex items-center gap-1.5"><input type="radio" name="note" className="accent-[var(--brand)]" /> 內部</label></span></label>
              <div className="sm:col-span-2 mt-1 flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-xs font-semibold text-muted-foreground"><IconLock className="size-3.5" /> 以下只有你與系辦看得到</div>
              <label className="flex flex-col gap-1.5 text-sm font-semibold sm:col-span-2">公司地址<input className={input} /></label>
              <label className="flex flex-col gap-1.5 text-sm font-semibold">聯絡人<input className={input} /></label>
              <label className="flex flex-col gap-1.5 text-sm font-semibold">聯絡電話<input className={input} /></label>
              <label className="flex flex-col gap-1.5 text-sm font-semibold sm:col-span-2">聯絡 Email<input type="email" className={input} /></label>
            </div>
            <div className="flex items-center gap-2 border-t border-border px-6 py-4">
              <label className="inline-flex items-center gap-2 text-sm"><input type="radio" name="status" checked={status === "public"} onChange={() => setStatus("public")} className="accent-[var(--brand)]" /> 公開</label>
              <label className="inline-flex items-center gap-2 text-sm"><input type="radio" name="status" checked={status === "draft"} onChange={() => setStatus("draft")} className="accent-[var(--brand)]" /> 草稿</label>
              <button type="submit" className="btn-fju ml-auto h-10 px-5 text-sm">{status === "public" ? "公開" : "儲存草稿"}</button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
