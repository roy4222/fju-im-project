"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { IconAlertCircle, IconCloudUpload, IconDeviceFloppy, IconDownload, IconSend, IconUsers } from "@tabler/icons-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { buttonVariants } from "@/components/ui/button";
import { CURRENT_USERS, FIELD_TYPE_LABEL, MY_GROUP, TEACHERS, type FormField, type SubmissionState } from "@/lib/fixtures";
import { DEMO_STAMP, DEMO_TIME } from "@/app/dashboard/[role]/affairs/student-status";

/**
 * 組別共用表單（規格 §4.6）：同組看同一份草稿、任一人送出＝全組完成。
 * Codex 09-10 S-01：正式送出前驗證必填；空白不能拿到回執。儲存草稿允許未填完。
 * 組別未成立（myGroupEstablished 為 false）時整組表單只能存草稿：送出鈕 aria-disabled，按了會列出缺的欄位與原因，不裝死。
 */
type Value = string | string[];
export type Receipt = { at: string; version: number; by: string; group: string };

export function GroupForm({ fields, state, locked, backHref, itemTitle, blocked, blockedHref, onSubmitted }: {
  fields: FormField[];
  state: SubmissionState;
  locked: boolean;
  backHref: string;
  itemTitle: string;
  /** 組別未成立等原因不能正式送出；字串就是要顯示的原因 */
  blocked?: string | null;
  blockedHref?: string;
  onSubmitted?: (r: Receipt) => void;
}) {
  const [values, setValues] = useState<Record<string, Value>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [tried, setTried] = useState(false);
  const [saved, setSaved] = useState<"idle" | "saving" | "saved">("idle");
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [done, setDone] = useState(state === "submitted");
  const refs = useRef<Record<string, HTMLElement | null>>({});
  const readOnly = locked;
  const me = CURRENT_USERS.student.name;

  function set(id: string, v: Value) {
    setValues((s) => ({ ...s, [id]: v }));
    setSaved("idle");
    if (errors[id]) setErrors((e) => { const n = { ...e }; delete n[id]; return n; });
  }
  function validate(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const f of fields) {
      if (!f.required) continue;
      const v = values[f.id];
      const empty = v === undefined || (typeof v === "string" ? v.trim() === "" : v.length === 0);
      if (empty) out[f.id] = f.type === "file" ? `請上傳${f.label}` : f.type === "radio" || f.type === "select" ? `請選擇${f.label}` : f.type === "checkbox" ? `請勾選${f.label}` : `請填寫${f.label}`;
    }
    return out;
  }
  function focusField(id: string) {
    const el = refs.current[id];
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
    el?.focus();
  }
  function save() {
    setSaved("saving");
    setTimeout(() => setSaved("saved"), 400);
  }
  function submit() {
    const errs = validate();
    setErrors(errs);
    setTried(true);
    if (Object.keys(errs).length || blocked) {
      const first = Object.keys(errs)[0];
      if (first) focusField(first);
      else summaryRef.current?.focus();
      return;
    }
    const r: Receipt = { at: DEMO_STAMP, version: state === "submitted" ? 2 : 1, by: me, group: MY_GROUP.no };
    setReceipt(r);
    setDone(true);
    onSubmitted?.(r);
  }
  const summaryRef = useRef<HTMLDivElement>(null);
  const missing = fields.filter((f) => errors[f.id]);
  const showSummary = tried && (missing.length > 0 || blocked);

  return (
    <form className="flex flex-col gap-5" noValidate onSubmit={(e) => { e.preventDefault(); submit(); }}>
      {showSummary ? (
        <div ref={summaryRef} tabIndex={-1} role="alert" className="rounded-lg border border-destructive/35 bg-destructive-subtle px-4 py-3 text-sm text-destructive-on-subtle outline-none focus-visible:ring-3 focus-visible:ring-destructive/25">
          <p className="flex items-center gap-2 font-bold"><IconAlertCircle className="size-4 shrink-0" />{missing.length ? `尚缺 ${missing.length} 個欄位，補齊後才能正式送出` : "還不能正式送出"}</p>
          {missing.length ? (
            <ol className="mt-1.5 ml-6 list-decimal space-y-0.5">
              {missing.map((f) => <li key={f.id}><a href={`#${f.id}`} onClick={(e) => { e.preventDefault(); focusField(f.id); }} className="underline underline-offset-2 hover:no-underline">{f.label}</a></li>)}
            </ol>
          ) : null}
          {blocked ? <p className="mt-1.5">{blocked}{blockedHref ? <>。<Link href={blockedHref} className="font-semibold underline underline-offset-2">去我的組別</Link></> : null}</p> : null}
        </div>
      ) : null}

      {fields.map((f) => (
        <Field key={f.id} field={f} readOnly={readOnly} value={values[f.id]} error={errors[f.id]} onChange={(v) => set(f.id, v)} refFn={(el) => { refs.current[f.id] = el; }} />
      ))}

      <div className="sticky bottom-4 z-10 mt-2 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-background/95 p-3 backdrop-blur">
        <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
          <span aria-hidden className={`inline-block size-2 rounded-full border-2 ${saved === "saved" || done ? "border-success bg-success" : "border-muted-foreground/60"}`} />
          {saved === "saving" ? "儲存中…" : saved === "saved" ? `已儲存 ${DEMO_TIME}・全組可見` : done ? "已繳交，截止前可重送" : "未儲存"}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {!readOnly ? (
            <>
              <button type="button" onClick={save} className={buttonVariants({ variant: "outline", size: "lg", className: "press h-11 rounded-lg px-4" })}><IconDeviceFloppy /> 儲存草稿</button>
              <button type="submit" aria-disabled={blocked ? true : undefined} title={blocked ?? undefined} className={`btn-fju h-11 rounded-lg px-5 text-sm ${blocked ? "cursor-not-allowed opacity-50 hover:bg-brand" : ""}`}><IconSend className="size-4" /> {done ? "重新送出" : "正式送出"}</button>
              {blocked ? <span className="basis-full text-right text-xs text-muted-foreground sm:basis-auto">{blocked}{blockedHref ? <>・<Link href={blockedHref} className="font-semibold text-primary underline-offset-2 hover:underline">去確認</Link></> : null}</span> : null}
            </>
          ) : (
            <span className="text-xs font-semibold text-muted-foreground">截止後唯讀，需系辦重新開放</span>
          )}
        </div>
      </div>

      <Dialog open={receipt !== null} onOpenChange={(o) => !o && setReceipt(null)}>
        <DialogContent className="max-w-md">
          {receipt ? <ReceiptStamp receipt={receipt} title={itemTitle} backHref={backHref} /> : null}
        </DialogContent>
      </Dialog>
    </form>
  );
}

/** 收件章（簡報特色 2）：一次的印章感，邊框圓角、-2deg、一次淡入；不放彩紙 */
export function ReceiptStamp({ receipt, title, backHref }: { receipt: Receipt; title: string; backHref: string }) {
  const [inked, setInked] = useState(false);
  useEffect(() => { const id = requestAnimationFrame(() => setInked(true)); return () => cancelAnimationFrame(id); }, []);
  return (
    <div className="flex flex-col items-center gap-4 text-center">
      <span aria-hidden className={`inline-flex rotate-[-2deg] items-center rounded-lg border-[3px] border-brand px-4 py-1.5 text-[15px] font-extrabold tracking-[0.2em] text-brand transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none ${inked ? "scale-100 opacity-100" : "scale-110 opacity-0"}`}>已收件</span>
      <div>
        <DialogTitle className="text-xl font-extrabold">已正式送出</DialogTitle>
        <DialogDescription className="mt-1 text-sm">{title}</DialogDescription>
      </div>
      <dl className="grid w-full grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 border-y border-border py-3 text-left text-sm">
        <dt className="text-muted-foreground">版本</dt><dd className="tabular font-semibold">v{receipt.version}</dd>
        <dt className="text-muted-foreground">送出者</dt><dd className="font-semibold">{receipt.by}（代表全組）</dd>
        <dt className="text-muted-foreground">時間</dt><dd className="tabular font-semibold">{receipt.at}</dd>
        <dt className="text-muted-foreground">組別</dt><dd className="font-semibold">{receipt.group}</dd>
      </dl>
      <p className="text-xs text-muted-foreground">全組看到同一個版本。截止前可重送，以最後一次為準。</p>
      <Link href={backHref} className="btn-fju h-11 w-full rounded-lg text-sm">回作業區</Link>
    </div>
  );
}

function Field({ field: f, readOnly, value, error, onChange, refFn }: { field: FormField; readOnly: boolean; value?: Value; error?: string; onChange: (v: Value) => void; refFn: (el: HTMLElement | null) => void }) {
  const errId = `${f.id}-err`;
  const base = `h-11 w-full rounded-lg border bg-background px-3 text-sm outline-none transition-[border-color,box-shadow] focus-visible:ring-3 disabled:bg-muted disabled:text-muted-foreground ${error ? "border-destructive focus-visible:border-destructive focus-visible:ring-destructive/25" : "border-input focus-visible:border-brand focus-visible:ring-brand/25"}`;
  const label = (
    <label htmlFor={f.id} className="text-sm font-semibold">
      {f.label}
      {f.required ? <span className="ml-1 text-destructive" aria-hidden>*</span> : null}
      {f.help ? <span className="ml-2 text-xs font-normal text-muted-foreground">{f.help}</span> : null}
    </label>
  );
  const errLine = error ? <p id={errId} className="text-xs font-semibold text-destructive">{error}</p> : null;
  const aria = { "aria-invalid": error ? true : undefined, "aria-describedby": error ? errId : undefined, "aria-required": f.required || undefined };
  const str = typeof value === "string" ? value : "";
  switch (f.type) {
    case "heading":
      return <h3 className="mt-2 border-b border-border pb-2 text-base font-bold">{f.label}</h3>;
    case "paragraph":
      return <p className="border-l-[3px] border-border pl-3 text-sm leading-relaxed text-muted-foreground">{f.label}</p>;
    case "divider":
      return <hr className="border-border" />;
    case "groupinfo":
      return (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-border pb-3 text-sm">
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
          <label className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-dashed px-4 py-3 text-sm transition-colors hover:bg-brand-subtle/30 ${error ? "border-destructive" : "border-border hover:border-brand"} ${readOnly ? "pointer-events-none opacity-60" : ""}`}>
            <IconCloudUpload className="size-5 text-brand" />
            <span className="font-semibold">{str ? str : "拖放或點擊上傳"}</span>
            <span className="text-xs text-muted-foreground">{str ? "已選檔案" : f.meta}</span>
            <input id={f.id} ref={refFn} type="file" className="sr-only" disabled={readOnly} onChange={(e) => onChange(e.target.files?.[0]?.name ?? "")} {...aria} />
          </label>
          {errLine}
        </div>
      );
    case "textarea":
      return <div className="flex flex-col gap-1.5">{label}<textarea id={f.id} ref={refFn} rows={4} placeholder={f.placeholder} disabled={readOnly} value={str} onChange={(e) => onChange(e.target.value)} className={`${base} h-auto resize-y py-2.5`} {...aria} />{errLine}</div>;
    case "radio":
    case "checkbox": {
      const arr = Array.isArray(value) ? value : [];
      return (
        <fieldset className="flex flex-col gap-2" aria-invalid={error ? true : undefined} aria-describedby={error ? errId : undefined}>
          <legend className="text-sm font-semibold">{f.label}{f.required ? <span className="ml-1 text-destructive" aria-hidden>*</span> : null}</legend>
          <div className="flex flex-wrap gap-2">
            {f.options?.map((o, i) => {
              const checked = f.type === "radio" ? str === o : arr.includes(o);
              return (
                <label key={o} className={`inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors has-checked:border-brand has-checked:bg-brand-subtle/50 ${error ? "border-destructive" : "border-border"}`}>
                  <input type={f.type} name={f.id} id={i === 0 ? f.id : undefined} ref={i === 0 ? refFn : undefined} disabled={readOnly} checked={checked} onChange={() => onChange(f.type === "radio" ? o : checked ? arr.filter((x) => x !== o) : [...arr, o])} className="accent-[var(--brand)]" /> {o}
                </label>
              );
            })}
          </div>
          {errLine}
        </fieldset>
      );
    }
    case "select":
      return (
        <div className="flex flex-col gap-1.5">{label}
          <select id={f.id} ref={refFn} disabled={readOnly} value={str} onChange={(e) => onChange(e.target.value)} className={base} {...aria}>
            <option value="" disabled>請選擇</option>
            {f.options?.map((o) => <option key={o}>{o}</option>)}
          </select>
          {errLine}
        </div>
      );
    default:
      return <div className="flex flex-col gap-1.5">{label}<input id={f.id} ref={refFn} type={f.type === "number" ? "number" : f.type === "email" ? "email" : f.type === "url" ? "url" : f.type === "date" ? "date" : f.type === "time" ? "time" : "text"} placeholder={f.placeholder ?? FIELD_TYPE_LABEL[f.type]} disabled={readOnly} value={str} onChange={(e) => onChange(e.target.value)} className={base} {...aria} />{errLine}</div>;
  }
}
