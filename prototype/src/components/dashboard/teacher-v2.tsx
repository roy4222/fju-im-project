import Link from "next/link";
import type { ReactNode } from "react";
import { IconAlertTriangle, IconCheck, IconCrown } from "@tabler/icons-react";
import type { Member } from "@/lib/fixtures";
import type { DotState } from "@/lib/teacher-v2";

/**
 * 老師後台 v2 共用小元件（Roy 2026-10-15）：分頁列、組員頭像、作業狀態小方塊。
 */
export function TabBar({ label, tabs, active }: { label: string; tabs: { key: string; label: string; href: string; count?: number }[]; active: string }) {
  return (
    <nav aria-label={label} className="flex gap-1 border-b border-border" data-tabs>
      {tabs.map((t) => (
        <Link key={t.key} href={t.href} scroll={false} aria-current={t.key === active ? "page" : undefined} className={`-mb-px inline-flex h-11 items-center gap-1.5 border-b-[3px] px-4 text-[15px] font-bold transition-colors focus-visible:outline-3 focus-visible:outline-offset-[-3px] focus-visible:outline-ring/40 ${t.key === active ? "border-brand text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
          {t.label}
          {t.count ? <span className="tabular inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-brand px-1.5 text-[11px] text-white">{t.count}</span> : null}
        </Link>
      ))}
    </nav>
  );
}

export function PageHead({ title, sub, children }: { title: string; sub?: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-[26px] font-extrabold tracking-tight">{title}</h1>
        {sub ? <p className="tabular mt-1 text-sm text-muted-foreground">{sub}</p> : null}
      </div>
      {children}
    </div>
  );
}

/** 組員頭像疊在一起；approved 有值時，同意的人打勾 */
export function MemberStack({ members, approved }: { members: Member[]; approved?: Set<string> }) {
  return (
    <ul className="flex -space-x-1" aria-label="組員">
      {members.map((m) => {
        const ok = approved?.has(m.name);
        return (
          <li key={m.id} title={m.name} className={`relative inline-flex size-10 items-center justify-center rounded-full text-[11px] font-bold ring-2 ring-card ${approved ? (ok ? "bg-success-subtle text-success-on-subtle" : "bg-muted text-muted-foreground") : "bg-accent text-primary"}`}>
            {m.name.slice(-2)}
            {m.isLeader && !approved ? <IconCrown aria-label="組長" className="absolute -top-2.5 left-1/2 size-4 -translate-x-1/2 fill-[oklch(0.84_0.15_85)] text-[oklch(0.62_0.13_70)]" /> : null}
            {ok ? <span className="absolute -right-0.5 -bottom-0.5 inline-flex size-4 items-center justify-center rounded-full bg-success text-success-foreground ring-2 ring-card"><IconCheck className="size-2.5" strokeWidth={3} /></span> : null}
          </li>
        );
      })}
    </ul>
  );
}

const SQUARE: Record<DotState, string> = {
  done: "bg-success text-success-foreground",
  missing: "bg-muted text-muted-foreground ring-1 ring-inset ring-border",
  overdue: "bg-destructive text-white",
};

export function WorkSquare({ state, title }: { state: DotState; title: string }) {
  return (
    <span title={title} aria-label={title} data-dot={state} className={`inline-flex size-8 items-center justify-center rounded-lg ${SQUARE[state]}`}>
      {state === "done" ? <IconCheck className="size-4" strokeWidth={3} /> : state === "overdue" ? <IconAlertTriangle className="size-4" /> : null}
    </span>
  );
}

export function WorkLegend() {
  return (
    <p className="flex flex-wrap items-center gap-4 text-[13px] font-semibold text-muted-foreground" data-legend>
      {(["done", "missing", "overdue"] as const).map((s) => (
        <span key={s} className="inline-flex items-center gap-1.5">
          <span className={`inline-block size-3.5 rounded ${SQUARE[s]}`} />
          {{ done: "已交", missing: "缺交", overdue: "逾期" }[s]}
        </span>
      ))}
    </p>
  );
}
