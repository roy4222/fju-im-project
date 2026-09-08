import Link from "next/link";
import type { ReactNode } from "react";
import { IconArrowRight, IconArrowUpRight, IconArrowDownRight } from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { STATE_LABEL, type SubmissionState } from "@/lib/fixtures";

/**
 * 後台基本元件（2026-09-08 依 demos.shadcndashboard.dev 重做）：
 * 字少、數字大、每張卡一件事；標題列＝小 icon＋名詞＋右側唯一動作。
 */

export function Panel({ title, icon, description, action, children, className = "", bodyClassName = "" }: { title: string; icon?: ReactNode; description?: string; action?: { href: string; label: string } | ReactNode; children: ReactNode; className?: string; bodyClassName?: string }) {
  return (
    <section className={`card-in flex flex-col rounded-xl border border-border bg-card ${className}`}>
      <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
        <div className="flex min-w-0 items-center gap-2.5">
          {icon ? <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground [&_svg]:size-4">{icon}</span> : null}
          <div className="min-w-0">
            <h2 className="truncate text-[15px] font-bold">{title}</h2>
            {description ? <p className="truncate text-xs text-muted-foreground">{description}</p> : null}
          </div>
        </div>
        {action && typeof action === "object" && "href" in action ? (
          <Link href={action.href} className="link-ink inline-flex shrink-0 items-center gap-1 text-[13px] font-semibold text-primary">
            {action.label}
            <IconArrowRight className="size-3.5" />
          </Link>
        ) : (
          action
        )}
      </div>
      <div className={`flex-1 ${bodyClassName}`}>{children}</div>
    </section>
  );
}

/** 統計磚：大數字＋一句提示＋右側小圖 */
export function StatTile({ label, value, unit, hint, trend, chart, tone = "default", href, icon }: { label: string; value: string | number; unit?: string; hint?: string; trend?: { value: number; label?: string }; chart?: ReactNode; tone?: "default" | "warning" | "danger" | "success" | "brand"; href?: string; icon?: ReactNode }) {
  const toneClass = { default: "text-foreground", warning: "text-warning-on-subtle", danger: "text-destructive", success: "text-success-on-subtle", brand: "text-brand" }[tone];
  const body = (
    <>
      <div className="flex items-center gap-2 text-[13px] font-semibold text-muted-foreground">
        {icon ? <span className="[&_svg]:size-4">{icon}</span> : null}
        {label}
      </div>
      <div className="mt-3 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <p className={`tabular text-[30px] font-extrabold leading-none tracking-tight ${toneClass}`}>
            {value}
            {unit ? <span className="ml-1 text-sm font-semibold text-muted-foreground">{unit}</span> : null}
          </p>
          <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
            {trend ? (
              <span className={`inline-flex items-center gap-0.5 font-semibold ${trend.value >= 0 ? "text-success-on-subtle" : "text-destructive"}`}>
                {trend.value >= 0 ? <IconArrowUpRight className="size-3.5" /> : <IconArrowDownRight className="size-3.5" />}
                {trend.value > 0 ? "+" : ""}{trend.value}
                {trend.label ? <span className="font-normal text-muted-foreground">{trend.label}</span> : null}
              </span>
            ) : null}
            {hint ? <span className="truncate">{hint}</span> : null}
          </div>
        </div>
        {chart ? <div className="shrink-0">{chart}</div> : null}
      </div>
    </>
  );
  const cls = "card-in card-lift block rounded-xl border border-border bg-card p-5";
  return href ? <Link href={href} className={cls}>{body}</Link> : <div className={cls}>{body}</div>;
}

/** 問候卡：第一眼「我現在要做什麼」＋唯一主要動作 */
export function Greeting({ name, line, cta, aside }: { name: string; line: string; cta: { href: string; label: string }; aside?: ReactNode }) {
  const h = new Date().getHours();
  const hello = h < 5 ? "晚安" : h < 11 ? "早安" : h < 14 ? "午安" : h < 18 ? "午安" : "晚安";
  return (
    <section className="card-in relative overflow-hidden rounded-xl border border-border bg-card">
      <div className="absolute inset-y-0 right-0 w-1/2 bg-[radial-gradient(ellipse_at_right,var(--brand-subtle),transparent_70%)]" aria-hidden />
      <div className="relative flex flex-col gap-5 p-6 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-extrabold tracking-tight">{hello}，{name}</h1>
          <p className="mt-1.5 text-[15px] text-muted-foreground">{line}</p>
          <Link href={cta.href} className="btn-fju group mt-5 h-10 px-4.5 text-sm">
            {cta.label}
            <IconArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
          </Link>
        </div>
        {aside ? <div className="shrink-0">{aside}</div> : null}
      </div>
    </section>
  );
}

/** 需要處理列：icon、名稱、數字、一個 CTA */
export function ActionRow({ icon, label, detail, count, href, cta, tone = "default" }: { icon: ReactNode; label: string; detail?: string; count: number; href: string; cta: string; tone?: "default" | "warning" | "danger" | "brand" | "info" }) {
  const toneBg = { default: "bg-muted text-muted-foreground", warning: "bg-warning-subtle text-warning-on-subtle", danger: "bg-destructive-subtle text-destructive-on-subtle", brand: "bg-brand-subtle text-brand-on-subtle", info: "bg-info-subtle text-info-on-subtle" }[tone];
  return (
    <li>
      <Link href={href} className="group flex items-center gap-3.5 px-5 py-3.5 transition-colors hover:bg-accent/60">
        <span className={`inline-flex size-9 shrink-0 items-center justify-center rounded-lg ${toneBg} [&_svg]:size-4.5`}>{icon}</span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{label}</p>
          {detail ? <p className="truncate text-xs text-muted-foreground">{detail}</p> : null}
        </div>
        <span className={`tabular text-xl font-extrabold ${count > 0 ? "" : "text-muted-foreground"}`}>{count}</span>
        <span className="hidden items-center gap-1 text-[13px] font-semibold text-primary transition-transform group-hover:translate-x-0.5 sm:inline-flex">
          {cta} <IconArrowRight className="size-3.5" />
        </span>
      </Link>
    </li>
  );
}

const STATE_STYLE: Record<SubmissionState, string> = {
  todo: "border-border bg-muted text-muted-foreground",
  draft: "border-info/30 bg-info-subtle text-info-on-subtle",
  submitted: "border-success/30 bg-success-subtle text-success-on-subtle",
  resubmit: "border-warning/35 bg-warning-subtle text-warning-on-subtle",
  overdue: "border-destructive/35 bg-destructive-subtle text-destructive-on-subtle",
  locked: "border-border bg-muted text-muted-foreground",
};

export function StateBadge({ state, className = "" }: { state: SubmissionState; className?: string }) {
  return (
    <Badge variant="outline" className={`shrink-0 text-[11px] ${STATE_STYLE[state]} ${className}`}>
      {STATE_LABEL[state]}
    </Badge>
  );
}

export function Pill({ children, tone = "default", className = "" }: { children: ReactNode; tone?: "default" | "success" | "warning" | "danger" | "info" | "brand"; className?: string }) {
  const cls = {
    default: "border-border bg-muted text-muted-foreground",
    success: "border-success/30 bg-success-subtle text-success-on-subtle",
    warning: "border-warning/35 bg-warning-subtle text-warning-on-subtle",
    danger: "border-destructive/35 bg-destructive-subtle text-destructive-on-subtle",
    info: "border-info/30 bg-info-subtle text-info-on-subtle",
    brand: "border-brand/30 bg-brand-subtle text-brand-on-subtle",
  }[tone];
  return <Badge variant="outline" className={`shrink-0 text-[11px] ${cls} ${className}`}>{children}</Badge>;
}

/** 進度條：完成／逾期 */
export function ProgressBar({ done, total, overdue = 0, showLabel = true }: { done: number; total: number; overdue?: number; showLabel?: boolean }) {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  const overduePct = total === 0 ? 0 : Math.round((overdue / total) * 100);
  return (
    <div className="flex items-center gap-2.5">
      <div className="h-2 min-w-16 flex-1 overflow-hidden rounded-full bg-muted" role="img" aria-label={`完成 ${done}／${total}${overdue ? `，逾期 ${overdue}` : ""}`}>
        <div className="flex h-full">
          <div className="chart-seg bg-success" style={{ width: `${pct}%` }} />
          <div className="chart-seg bg-destructive" style={{ width: `${overduePct}%` }} />
        </div>
      </div>
      {showLabel ? <span className="tabular shrink-0 text-xs text-muted-foreground">{done}/{total}</span> : null}
    </div>
  );
}

export function EmptyState({ title, hint, icon, action }: { title: string; hint?: string; icon?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
      {icon ? <div className="text-muted-foreground/60 [&_svg]:size-8">{icon}</div> : null}
      <p className="text-sm font-semibold">{title}</p>
      {hint ? <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">{hint}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/** 頁面標題列（內頁用）：標題＋一句＋右側動作 */
export function PageTitle({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-extrabold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
