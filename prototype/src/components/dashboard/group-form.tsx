"use client";

import { useState } from "react";
import Link from "next/link";
import { IconCheck, IconCloudUpload, IconDeviceFloppy, IconDownload, IconSend, IconUsers } from "@tabler/icons-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { buttonVariants } from "@/components/ui/button";
import { FIELD_TYPE_LABEL, MY_GROUP, TEACHERS, type FormField, type SubmissionState } from "@/lib/fixtures";

/**
 * 組別共用表單（規格 §4.6）：同組看同一份草稿、任一人送出＝全組完成。
 * 原型：儲存／送出只改本地狀態，並給回執（§10.4：送出要有回執，不能只按鈕變色）。
 */
export function GroupForm({ fields, state, locked, backHref, itemTitle }: { fields: FormField[]; state: SubmissionState; locked: boolean; backHref: string; itemTitle: string }) {
  const [saved, setSaved] = useState<"idle" | "saving" | "saved">("idle");
  const [receipt, setReceipt] = useState<null | { at: string; version: number }>(null);
  const [done, setDone] = useState(state === "submitted");
  const readOnly = locked;

  function save() {
    setSaved("saving");
    setTimeout(() => setSaved("saved"), 500);
  }
  function submit() {
    setReceipt({ at: new Date().toLocaleString("zh-TW", { hour12: false }), version: state === "submitted" ? 2 : 1 });
    setDone(true);
  }

  return (
    <form className="flex flex-col gap-5" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      {fields.map((f) => (
        <Field key={f.id} field={f} readOnly={readOnly} />
      ))}
      <div className="sticky bottom-4 z-10 mt-2 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-background/95 p-3 shadow-[0_8px_24px_rgba(0,51,102,0.10)] backdrop-blur">
        <span className="text-xs text-muted-foreground">
          {saved === "saving" ? "儲存中…" : saved === "saved" ? "草稿已儲存，全組可見" : done ? "已繳交，截止前可重送" : "尚未儲存"}
        </span>
        <div className="ml-auto flex gap-2">
          {!readOnly ? (
            <>
              <button type="button" onClick={save} className={buttonVariants({ variant: "outline", size: "lg", className: "press rounded-lg" })}><IconDeviceFloppy /> 儲存草稿</button>
              <button type="submit" className="btn-fju h-9 px-4 text-sm"><IconSend className="size-4" /> {done ? "重新送出" : "正式送出"}</button>
            </>
          ) : (
            <span className="text-xs font-semibold text-muted-foreground">已截止鎖定，需系辦重新開放</span>
          )}
        </div>
      </div>

      <Dialog open={receipt !== null} onOpenChange={(o) => !o && setReceipt(null)}>
        <DialogContent className="max-w-md">
          <div className="flex flex-col items-center gap-3 text-center">
            <span className="inline-flex size-14 items-center justify-center rounded-full bg-success-subtle text-success-on-subtle"><IconCheck className="size-7" /></span>
            <DialogTitle className="text-xl font-extrabold">已正式送出</DialogTitle>
            <DialogDescription className="text-sm">{itemTitle}</DialogDescription>
            <dl className="mt-2 grid w-full grid-cols-2 gap-x-4 gap-y-1.5 rounded-lg bg-muted px-4 py-3 text-left text-sm">
              <dt className="text-muted-foreground">版本</dt><dd className="tabular font-semibold">v{receipt?.version}</dd>
              <dt className="text-muted-foreground">送出者</dt><dd className="font-semibold">林彥廷（代表全組）</dd>
              <dt className="text-muted-foreground">時間</dt><dd className="tabular font-semibold">{receipt?.at}</dd>
              <dt className="text-muted-foreground">組別</dt><dd className="font-semibold">{MY_GROUP.no}</dd>
            </dl>
            <p className="text-xs text-muted-foreground">全組 Dashboard 已同步打勾。截止前可重送，每次送出保留版本。</p>
            <Link href={backHref} className="btn-fju mt-1 h-10 w-full text-sm">回到專題事務</Link>
          </div>
        </DialogContent>
      </Dialog>
    </form>
  );
}

function Field({ field: f, readOnly }: { field: FormField; readOnly: boolean }) {
  const base = "h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none transition-[border-color,box-shadow] focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25 disabled:bg-muted disabled:text-muted-foreground";
  const label = (
    <label htmlFor={f.id} className="text-sm font-semibold">
      {f.label}
      {f.required ? <span className="ml-1 text-destructive">*</span> : null}
      {f.help ? <span className="ml-2 text-xs font-normal text-muted-foreground">{f.help}</span> : null}
    </label>
  );
  switch (f.type) {
    case "heading":
      return <h3 className="mt-2 border-b border-border pb-2 text-base font-bold">{f.label}</h3>;
    case "paragraph":
      return <p className="rounded-lg bg-muted px-4 py-3 text-sm leading-relaxed text-muted-foreground">{f.label}</p>;
    case "divider":
      return <hr className="border-border" />;
    case "groupinfo":
      return (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm">
          <span className="inline-flex items-center gap-1.5 font-bold"><IconUsers className="size-4 text-primary" />{MY_GROUP.no}</span>
          <span>組長 {MY_GROUP.members.find((m) => m.isLeader)?.name}</span>
          <span className="text-muted-foreground">{MY_GROUP.members.map((m) => m.name).join("、")}</span>
          <span className="text-muted-foreground">指導老師 {TEACHERS.find((t) => t.id === MY_GROUP.advisorId)?.name ?? "尚未指派"}</span>
        </div>
      );
    case "attachment":
      return (
        <div className="flex items-center gap-3 rounded-lg border border-border px-4 py-3 text-sm">
          <IconDownload className="size-4 text-primary" />
          <span className="font-semibold">{f.label}</span>
          <span className="text-xs text-muted-foreground">{f.meta}</span>
          <a href="#" className="link-ink ml-auto text-[13px] font-semibold text-primary">下載</a>
        </div>
      );
    case "file":
      return (
        <div className="flex flex-col gap-1.5">
          {label}
          <label className={`flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-border px-4 py-4 text-sm transition-colors hover:border-brand hover:bg-brand-subtle/30 ${readOnly ? "pointer-events-none opacity-60" : ""}`}>
            <IconCloudUpload className="size-5 text-brand" />
            <span className="font-semibold">拖放或點擊上傳</span>
            <span className="text-xs text-muted-foreground">{f.meta}</span>
            <input id={f.id} type="file" className="sr-only" disabled={readOnly} />
          </label>
        </div>
      );
    case "textarea":
      return <div className="flex flex-col gap-1.5">{label}<textarea id={f.id} rows={4} placeholder={f.placeholder} disabled={readOnly} className={`${base} h-auto resize-y py-2.5`} /></div>;
    case "radio":
    case "checkbox":
      return (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-semibold">{f.label}{f.required ? <span className="ml-1 text-destructive">*</span> : null}</legend>
          <div className="flex flex-wrap gap-2">
            {f.options?.map((o) => (
              <label key={o} className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm transition-colors has-checked:border-brand has-checked:bg-brand-subtle/50">
                <input type={f.type} name={f.id} disabled={readOnly} className="accent-[var(--brand)]" /> {o}
              </label>
            ))}
          </div>
        </fieldset>
      );
    case "select":
      return (
        <div className="flex flex-col gap-1.5">{label}
          <select id={f.id} disabled={readOnly} className={base} defaultValue="">
            <option value="" disabled>請選擇</option>
            {f.options?.map((o) => <option key={o}>{o}</option>)}
          </select>
        </div>
      );
    default:
      return <div className="flex flex-col gap-1.5">{label}<input id={f.id} type={f.type === "number" ? "number" : f.type === "email" ? "email" : f.type === "url" ? "url" : f.type === "date" ? "date" : f.type === "time" ? "time" : "text"} placeholder={f.placeholder ?? FIELD_TYPE_LABEL[f.type]} disabled={readOnly} className={base} /></div>;
  }
}
