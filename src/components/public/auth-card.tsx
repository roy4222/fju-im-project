import type { ReactNode } from "react";

/** 登入／註冊／忘記密碼共用的置中卡片 */
export function AuthCard({ title, description, children, width = "max-w-[440px]" }: { title: string; description: string; children: ReactNode; width?: string }) {
  return (
    <div className="flex min-h-[720px] items-center justify-center bg-muted/50 px-5 py-16">
      <div className={`flex w-full ${width} flex-col gap-5 rounded-xl border border-border bg-card p-9`}>
        <div className="flex flex-col gap-1.5">
          <h1 className="text-[26px] font-extrabold">{title}</h1>
          <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Field({ id, label, type = "text", placeholder, hint, autoComplete, trailing, required }: { id: string; label: string; type?: string; placeholder?: string; hint?: string; autoComplete?: string; trailing?: ReactNode; required?: boolean }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <label htmlFor={id} className="text-sm font-semibold">{label}</label>
        {trailing}
      </div>
      <input id={id} name={id} type={type} placeholder={placeholder} autoComplete={autoComplete} required={required} className="h-11 rounded-md border border-input bg-background px-3 text-sm" />
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </div>
  );
}
