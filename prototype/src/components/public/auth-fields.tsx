"use client";

import { useRef, useState, type ComponentProps, type ReactNode } from "react";
import { IconCheck, IconEye, IconEyeOff } from "@tabler/icons-react";
import { GoogleIcon } from "@/components/public/google-icon";

const INPUT =
  "h-11 w-full rounded-md border border-input bg-background px-3 text-[15px] transition-[border-color,box-shadow] outline-none placeholder:text-muted-foreground/70 focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/20 read-only:bg-muted read-only:text-muted-foreground aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/15";

type FieldProps = Omit<ComponentProps<"input">, "id"> & { id: string; label: string; hint?: ReactNode; error?: string; trailing?: ReactNode };

export function TextField({ id, label, hint, error, trailing, className = "", ...rest }: FieldProps) {
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={id} className="text-sm font-semibold">{label}</label>
        {trailing}
      </div>
      <input id={id} name={id} aria-invalid={error ? true : undefined} aria-describedby={describedBy} className={INPUT} {...rest} />
      {error ? <p id={`${id}-error`} className="text-[13px] text-destructive">{error}</p> : hint ? <p id={`${id}-hint`} className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** 密碼欄＋顯示／隱藏眼睛按鈕（type="button"，不會送出表單） */
export function PasswordField({ id, label, hint, error, trailing, ...rest }: FieldProps) {
  const [shown, setShown] = useState(false);
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={id} className="text-sm font-semibold">{label}</label>
        {trailing}
      </div>
      <div className="relative">
        <input id={id} name={id} type={shown ? "text" : "password"} aria-invalid={error ? true : undefined} aria-describedby={describedBy} className={`${INPUT} pr-12`} {...rest} />
        <button
          type="button"
          onClick={() => setShown((v) => !v)}
          aria-label={shown ? "隱藏密碼" : "顯示密碼"}
          aria-pressed={shown}
          aria-controls={id}
          className="absolute top-1/2 right-1.5 flex size-9 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-brand/30 focus-visible:outline-none"
        >
          {shown ? <IconEyeOff className="size-5" aria-hidden /> : <IconEye className="size-5" aria-hidden />}
        </button>
      </div>
      {error ? <p id={`${id}-error`} className="text-[13px] text-destructive">{error}</p> : hint ? <p id={`${id}-hint`} className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** 6 格驗證碼：自動跳格、Backspace 回上一格、左右鍵移動、整段貼上 */
export function OtpInput({ value, onChange, invalid }: { value: string; onChange: (v: string) => void; invalid?: boolean }) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const digits = Array.from({ length: 6 }, (_, i) => value[i] ?? "");

  function setAt(i: number, d: string) {
    const next = digits.slice();
    next[i] = d;
    onChange(next.join("").slice(0, 6));
  }

  function fill(from: number, text: string) {
    const clean = text.replace(/\D/g, "");
    if (!clean) return;
    const next = digits.slice();
    for (let k = 0; k < clean.length && from + k < 6; k++) next[from + k] = clean[k];
    onChange(next.join(""));
    refs.current[Math.min(from + clean.length, 5)]?.focus();
  }

  return (
    <div className="flex justify-between gap-2" role="group" aria-label="6 位數驗證碼">
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          value={d}
          inputMode="numeric"
          autoComplete={i === 0 ? "one-time-code" : "off"}
          maxLength={i === 0 ? 6 : 1}
          aria-label={`驗證碼第 ${i + 1} 位`}
          aria-invalid={invalid ? true : undefined}
          onChange={(e) => {
            const v = e.target.value;
            if (v.length > 1) return fill(i, v);
            if (!/^\d?$/.test(v)) return;
            setAt(i, v);
            if (v && i < 5) refs.current[i + 1]?.focus();
          }}
          onKeyDown={(e) => {
            if (e.key === "Backspace" && !d && i > 0) {
              e.preventDefault();
              setAt(i - 1, "");
              refs.current[i - 1]?.focus();
            } else if (e.key === "ArrowLeft" && i > 0) {
              e.preventDefault();
              refs.current[i - 1]?.focus();
            } else if (e.key === "ArrowRight" && i < 5) {
              e.preventDefault();
              refs.current[i + 1]?.focus();
            }
          }}
          onPaste={(e) => {
            e.preventDefault();
            fill(i, e.clipboardData.getData("text"));
          }}
          onFocus={(e) => e.target.select()}
          className="h-14 w-full min-w-0 rounded-lg border border-input bg-background text-center text-2xl font-bold tabular-nums transition-[border-color,box-shadow] outline-none focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/20 aria-invalid:border-destructive sm:h-16"
        />
      ))}
    </div>
  );
}

export type StepState = "done" | "current" | "todo" | "skipped";

/** 上方進度條：① ─ ② ─ ③ */
export function StepBar({ steps }: { steps: { label: string; state: StepState; note?: string }[] }) {
  return (
    <ol className="flex items-start" aria-label="註冊進度">
      {steps.map((s, i) => {
        const done = s.state === "done" || s.state === "skipped";
        const current = s.state === "current";
        return (
          <li key={s.label} className="flex flex-1 flex-col items-center gap-2 text-center" aria-current={current ? "step" : undefined}>
            <div className="flex w-full items-center">
              <span aria-hidden className={`h-0.5 flex-1 ${i === 0 ? "invisible" : done || current ? "bg-brand" : "bg-border"}`} />
              <span
                className={`flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-bold transition-colors ${
                  done ? "bg-brand text-brand-foreground" : current ? "bg-brand-subtle text-brand-on-subtle ring-2 ring-brand" : "bg-muted text-muted-foreground"
                }`}
              >
                {done ? <IconCheck className="size-4" stroke={3} aria-hidden /> : i + 1}
              </span>
              <span aria-hidden className={`h-0.5 flex-1 ${i === steps.length - 1 ? "invisible" : done ? "bg-brand" : "bg-border"}`} />
            </div>
            <span className={`text-xs sm:text-[13px] ${current ? "font-bold text-foreground" : done ? "font-semibold text-foreground" : "text-muted-foreground"}`}>
              {s.label}
              {s.note ? <span className="block text-[11px] font-normal text-muted-foreground">{s.note}</span> : null}
              <span className="sr-only">{done ? "（已完成）" : current ? "（目前步驟）" : "（尚未開始）"}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function GoogleButton({ children = "使用 Google 繼續", ...rest }: ComponentProps<"button">) {
  return (
    <button
      type="button"
      className="inline-flex h-12 w-full items-center justify-center gap-3 rounded-md border border-input bg-background text-[15px] font-bold shadow-xs transition-[background-color,box-shadow,transform] hover:bg-accent hover:shadow-sm focus-visible:ring-3 focus-visible:ring-brand/30 focus-visible:outline-none active:scale-[0.99]"
      {...rest}
    >
      <GoogleIcon /> {children}
    </button>
  );
}

export function OrDivider() {
  return (
    <div className="flex items-center gap-3 text-[13px] text-muted-foreground">
      <span className="h-px flex-1 bg-border" />或<span className="h-px flex-1 bg-border" />
    </div>
  );
}

/** 原型示範用的虛線框：讓 Roy 一眼看出「這是示範切換，不是正式畫面」 */
export function DemoBox({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg border border-dashed border-warning bg-warning-subtle/60 px-3.5 py-2.5 text-[13px] leading-relaxed text-warning-on-subtle ${className}`}>
      <span className="mr-1.5 inline-block rounded bg-warning px-1.5 py-px text-[11px] font-bold text-warning-foreground">原型示範</span>
      {children}
    </div>
  );
}

export function nowStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
