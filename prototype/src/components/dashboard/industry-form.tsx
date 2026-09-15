"use client";

import { useRef, useState } from "react";
import { IconAlertCircle, IconCheck, IconPlus, IconLock } from "@tabler/icons-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { buttonVariants } from "@/components/ui/button";

type Values = { company: string; department: string; title: string; needs: string; note: string; address: string; contact: string; phone: string; email: string };
type Key = keyof Values;
const EMPTY: Values = { company: "", department: "", title: "", needs: "", note: "", address: "", contact: "", phone: "", email: "" };
const REQUIRED: { key: Key; label: string }[] = [
  { key: "company", label: "公司名稱" },
  { key: "department", label: "需求部門" },
  { key: "title", label: "專題／合作內容" },
];

function check(v: Values): Partial<Record<Key, string>> {
  const e: Partial<Record<Key, string>> = {};
  for (const r of REQUIRED) if (!v[r.key].trim()) e[r.key] = `請填${r.label}`;
  if (v.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) e.email = "Email 格式不對，例如 name@company.com";
  if (v.phone && !/^[\d\s()+-]{6,}$/.test(v.phone)) e.phone = "電話只能有數字、空格、括號與 -";
  return e;
}

/** 老師建立／編輯合作案（規格 §6.2）：必填標星、送出逐欄顯示錯誤；公開拆成「學生可見」「網際網路公開」（T-06）。 */
export function IndustryFormDialog({ mode = "create", initial }: { mode?: "create" | "edit"; initial?: Partial<Values> }) {
  const [done, setDone] = useState(false);
  const [values, setValues] = useState<Values>({ ...EMPTY, ...initial });
  const [errors, setErrors] = useState<Partial<Record<Key, string>>>({});
  const [studentVisible, setStudentVisible] = useState(mode === "edit");
  const [internetPublic, setInternetPublic] = useState(false);
  const refs = useRef<Partial<Record<Key, HTMLInputElement | HTMLTextAreaElement | null>>>({});
  const input = "h-11 w-full rounded-lg border bg-background px-3 text-sm font-normal outline-none transition-[border-color,box-shadow] focus-visible:ring-3";
  const area = "w-full resize-y rounded-lg border bg-background px-3 py-2 text-sm font-normal outline-none transition-[border-color,box-shadow] focus-visible:ring-3";
  const tone = (k: Key) => (errors[k] ? "border-destructive focus-visible:border-destructive focus-visible:ring-destructive/20" : "border-input focus-visible:border-brand focus-visible:ring-brand/25");
  const set = (k: Key) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setValues((v) => ({ ...v, [k]: e.target.value }));
    if (errors[k]) setErrors((er) => ({ ...er, [k]: undefined }));
  };
  const scope = internetPublic ? "網際網路公開（含聯絡資訊）" : studentVisible ? "登入的學生可見" : "草稿，只有你與系辦看得到";

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const er = check(values);
    setErrors(er);
    const first = (Object.keys(er) as Key[])[0];
    if (first) { refs.current[first]?.focus(); return; }
    setDone(true);
  }
  function reset() {
    setDone(false);
    setErrors({});
    setValues({ ...EMPTY, ...initial });
  }

  /* 純函式（不是子元件）：避免每次 render 重建元件讓輸入框失焦 */
  const field = ({ k, label, required = false, textarea = false, rows = 3, type = "text", span = false }: { k: Key; label: string; required?: boolean; textarea?: boolean; rows?: number; type?: string; span?: boolean }) => {
    const id = `ind-${k}`;
    const errId = `${id}-err`;
    const err = errors[k];
    const common = { id, value: values[k], onChange: set(k), "aria-invalid": err ? true : undefined, "aria-describedby": err ? errId : undefined, "aria-required": required || undefined };
    return (
      <div key={k} className={`flex flex-col gap-1.5 ${span ? "sm:col-span-2" : ""}`}>
        <label htmlFor={id} className="text-sm font-semibold">{label}{required ? <span className="ml-0.5 text-destructive" aria-hidden>*</span> : null}{required ? <span className="sr-only">（必填）</span> : null}</label>
        {textarea ? <textarea {...common} rows={rows} ref={(el) => { refs.current[k] = el; }} className={`${area} ${tone(k)}`} /> : <input {...common} type={type} ref={(el) => { refs.current[k] = el; }} className={`${input} ${tone(k)}`} />}
        {err ? <p id={errId} className="inline-flex items-center gap-1 text-xs font-semibold text-destructive"><IconAlertCircle className="size-3.5" />{err}</p> : null}
      </div>
    );
  };

  const errCount = Object.values(errors).filter(Boolean).length;

  return (
    <Dialog onOpenChange={(o) => !o && reset()}>
      <DialogTrigger render={mode === "create" ? <button type="button" className="btn-fju h-10 px-4 text-sm" /> : <button type="button" className={buttonVariants({ size: "sm", variant: "outline", className: "press rounded-lg" })} />}>
        {mode === "create" ? <><IconPlus className="size-4" /> 新增合作案</> : "編輯"}
      </DialogTrigger>
      <DialogContent className="max-w-[calc(100%-2rem)] p-0 sm:max-w-2xl" showCloseButton>
        {done ? (
          <div className="flex flex-col items-center gap-3 p-8 text-center">
            <span className="animate-in fade-in-0 zoom-in-95 inline-flex -rotate-2 items-center gap-1.5 rounded-lg border-2 border-success px-3 py-1.5 text-sm font-extrabold tracking-[0.12em] text-success-on-subtle duration-300"><IconCheck className="size-4" strokeWidth={3} />已儲存</span>
            <DialogTitle className="text-lg font-extrabold">{values.company}</DialogTitle>
            <DialogDescription>{scope}。{internetPublic ? "地址、聯絡人、電話、Email 會顯示在前台。" : "地址、聯絡人、電話、Email 只有你與系辦看得到。"}</DialogDescription>
          </div>
        ) : (
          <form className="flex flex-col" onSubmit={submit} noValidate>
            <div className="border-b border-border px-6 py-4"><DialogTitle className="text-lg font-extrabold">{mode === "create" ? "新增合作案" : "編輯合作案"}</DialogTitle><DialogDescription className="mt-0.5">負責老師與發布日由系統帶入。<span className="text-destructive">*</span> 為必填。</DialogDescription></div>
            <div className="grid max-h-[60vh] gap-4 overflow-y-auto px-6 py-5 sm:grid-cols-2">
              {field({ k: "company", label: "公司名稱", required: true })}
              {field({ k: "department", label: "需求部門", required: true })}
              {field({ k: "title", label: "專題／合作內容", required: true, textarea: true, rows: 4, span: true })}
              {field({ k: "needs", label: "對學生的條件／需求", textarea: true, rows: 3, span: true })}
              {field({ k: "note", label: "備註", textarea: true, rows: 2, span: true })}
              <div className="sm:col-span-2 mt-1 flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-xs font-semibold text-muted-foreground"><IconLock className="size-3.5" /> 以下預設只有你與系辦看得到</div>
              {field({ k: "address", label: "公司地址", span: true })}
              {field({ k: "contact", label: "聯絡人" })}
              {field({ k: "phone", label: "聯絡電話", type: "tel" })}
              {field({ k: "email", label: "聯絡 Email", type: "email", span: true })}
            </div>
            <div className="flex flex-col gap-3 border-t border-border px-6 py-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <label htmlFor="vis-student" className="flex cursor-pointer items-start gap-2.5 text-sm">
                  <Checkbox id="vis-student" checked={studentVisible} onCheckedChange={(c) => { setStudentVisible(c); if (!c) setInternetPublic(false); }} className="mt-0.5" />
                  <span><span className="font-semibold">學生可見</span><span className="block text-xs text-muted-foreground">登入的學生看得到案件，可在分組時連結；聯絡資訊不顯示。</span></span>
                </label>
                <label htmlFor="vis-web" className="flex cursor-pointer items-start gap-2.5 text-sm">
                  <Checkbox id="vis-web" checked={internetPublic} onCheckedChange={(c) => { setInternetPublic(c); if (c) setStudentVisible(true); }} className="mt-0.5" />
                  <span><span className="font-semibold">網際網路公開（含聯絡資訊）</span><span className="block text-xs text-muted-foreground">不登入也能在前台看到，地址、聯絡人、電話、Email 一起顯示。</span></span>
                </label>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <span className={`min-w-0 flex-1 text-xs ${errCount ? "font-semibold text-destructive" : "text-muted-foreground"}`} role="status">{errCount ? `${errCount} 個欄位需要修正` : `儲存後：${scope}`}</span>
                <button type="submit" className="btn-fju h-11 px-5 text-sm">{internetPublic ? "儲存並公開" : studentVisible ? "儲存並開放學生" : "儲存草稿"}</button>
              </div>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
