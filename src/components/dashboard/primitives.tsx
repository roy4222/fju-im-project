import Link from "next/link";
import type { ReactNode } from "react";
import { IconArrowRight, IconArrowUpRight, IconArrowDownRight } from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { STATE_LABEL, type SubmissionState } from "@/lib/fixtures";

/**
 * 後台基本元件 v2（2026-09-08 第二輪，依 Roy「資訊量太大、單調」回饋與 impeccable operate 指南）：
 * - 一個區塊一個容器，容器內用 1px 分隔線，不再卡中卡、不加陰影、不做進場動畫。
 * - 顏色克制：數字一律黑；橘色只給主要動作與目前選取；紅／黃只給狀態。
 * - 字少：標題是名詞，說明能省就省。
 */

export function Panel({ title, icon, description, action, children, className = "", bodyClassName = "" }: { title: string; icon?: ReactNode; description?: string; action?: { href: string; label: string } | ReactNode; children: ReactNode; className?: string; bodyClassName?: string }) {
  return (
    <section className={`flex flex-col overflow-hidden rounded-xl border border-border bg-card ${className}`}>
      <div className="flex items-center justify-between gap-3 px-5 py-3.5">
        <div className="flex min-w-0 items-center gap-2">
          {icon ? <span className="shrink-0 text-muted-foreground [&_svg]:size-4">{icon}</span> : null}
          <h2 className="truncate text-[15px] font-bold">{title}</h2>
          {description ? <span className="hidden truncate text-xs text-muted-foreground sm:inline">・{description}</span> : null}
        </div>
        {action && typeof action === "object" && "href" in action ? (
          <Link href={action.href} className="inline-flex shrink-0 items-center gap-1 text-[13px] font-semibold text-muted-foreground transition-colors hover:text-foreground">
            {action.label}
            <IconArrowRight className="size-3.5" />
          </Link>
        ) : (
          action
        )}
      </div>
      <div className={`flex-1 border-t border-border ${bodyClassName}`}>{children}</div>
    </section>
  );
}

/** 統計磚：放在 StatRow 裡，彼此用分隔線；數字黑、小圖灰。 */
export function StatTile({ label, value, unit, hint, trend, chart, tone = "default", href, icon }: { label: string; value: string | number; unit?: string; hint?: string; trend?: { value: number; label?: string }; chart?: ReactNode; tone?: "default" | "warning" | "danger" | "success" | "brand"; href?: string; icon?: ReactNode }) {
  const dot = { default: "", warning: "bg-warning", danger: "bg-destructive", success: "bg-success", brand: "bg-brand" }[tone];
  const body = (
    <>
      <div className="flex items-center gap-2 text-[13px] font-medium text-muted-foreground">
        {icon ? <span className="[&_svg]:size-4">{icon}</span> : null}
        {label}
        {dot ? <span className={`size-1.5 rounded-full ${dot}`} aria-hidden /> : null}
      </div>
      <div className="mt-3 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="tabular text-[28px] font-bold leading-none tracking-tight">
            {value}
            {unit ? <span className="ml-1 text-sm font-medium text-muted-foreground">{unit}</span> : null}
          </p>
          {trend || hint ? (
            <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
              {trend ? (
                <span className={`inline-flex items-center gap-0.5 font-semibold ${trend.value >= 0 ? "text-success-on-subtle" : "text-destructive"}`}>
                  {trend.value >= 0 ? <IconArrowUpRight className="size-3.5" /> : <IconArrowDownRight className="size-3.5" />}
                  {trend.value > 0 ? "+" : ""}{trend.value}
                </span>
              ) : null}
              {hint ? <span className="truncate">{hint}</span> : null}
            </div>
          ) : null}
        </div>
        {chart ? <div className="shrink-0 text-muted-foreground/70">{chart}</div> : null}
      </div>
    </>
  );
  const cls = "block p-5 transition-colors";
  return href ? <Link href={href} className={`${cls} hover:bg-accent/50`}>{body}</Link> : <div className={cls}>{body}</div>;
}

/** 一列統計磚：單一容器、分隔線 */
export function StatRow({ children, cols = 4 }: { children: ReactNode; cols?: 3 | 4 }) {
  return (
    <div className={`grid overflow-hidden rounded-xl border border-border bg-card divide-y divide-border sm:grid-cols-2 sm:divide-y-0 ${cols === 4 ? "xl:grid-cols-4" : "xl:grid-cols-3"} [&>*:nth-child(odd)]:sm:border-r [&>*]:sm:border-border ${cols === 4 ? "[&>*:not(:last-child)]:xl:border-r" : "[&>*:not(:last-child)]:xl:border-r"} [&>*:nth-child(-n+2)]:sm:border-b [&>*]:xl:border-b-0`}>
      {children}
    </div>
  );
}

/** 問候列：不是卡片，只有一行名字、一句話、一個主要動作。 */
export function Greeting({ name, line, cta, aside }: { name: string; line: string; cta: { href: string; label: string }; aside?: ReactNode }) {
  const h = new Date().getHours();
  const hello = h < 5 ? "晚安" : h < 11 ? "早安" : h < 18 ? "午安" : "晚安";
  return (
    <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
      <div className="min-w-0">
        <h1 className="text-[22px] font-bold tracking-tight">{hello}，{name}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{line}</p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {aside}
        <Link href={cta.href} className="btn-fju h-10 px-4 text-sm">
          {cta.label}
          <IconArrowRight className="size-4" />
        </Link>
      </div>
    </div>
  );
}

/** 需要處理列：名稱、數字、箭頭。沒有 icon 方塊。 */
export function ActionRow({ label, detail, count, href, cta, tone = "default", icon }: { icon?: ReactNode; label: string; detail?: string; count: number; href: string; cta?: string; tone?: "default" | "warning" | "danger" | "brand" | "info" }) {
  const dot = { default: "bg-muted-foreground/40", warning: "bg-warning", danger: "bg-destructive", brand: "bg-brand", info: "bg-info" }[tone];
  return (
    <li>
      <Link href={href} className="group flex items-center gap-3.5 px-5 py-3.5 transition-colors hover:bg-accent/50">
        <span className={`size-2 shrink-0 rounded-full ${count > 0 ? dot : "bg-muted-foreground/25"}`} aria-hidden />
        {icon ? <span className="shrink-0 text-muted-foreground [&_svg]:size-4">{icon}</span> : null}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{label}</p>
          {detail ? <p className="truncate text-xs text-muted-foreground">{detail}</p> : null}
        </div>
        <span className={`tabular text-lg font-bold ${count > 0 ? "" : "text-muted-foreground/60"}`}>{count}</span>
        <IconArrowRight className="size-4 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
        {cta ? <span className="sr-only">{cta}</span> : null}
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

export function ProgressBar({ done, total, overdue = 0, showLabel = true }: { done: number; total: number; overdue?: number; showLabel?: boolean }) {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  const overduePct = total === 0 ? 0 : Math.round((overdue / total) * 100);
  return (
    <div className="flex items-center gap-2.5">
      <div className="h-1.5 min-w-16 flex-1 overflow-hidden rounded-full bg-muted" role="img" aria-label={`完成 ${done}／${total}${overdue ? `，逾期 ${overdue}` : ""}`}>
        <div className="flex h-full">
          <div className="bg-foreground/70" style={{ width: `${pct}%` }} />
          <div className="bg-destructive" style={{ width: `${overduePct}%` }} />
        </div>
      </div>
      {showLabel ? <span className="tabular shrink-0 text-xs text-muted-foreground">{done}/{total}</span> : null}
    </div>
  );
}

export function EmptyState({ title, hint, icon, action }: { title: string; hint?: string; icon?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
      {icon ? <div className="text-muted-foreground/50 [&_svg]:size-7" aria-hidden>{icon}</div> : null}
      <p className="text-sm font-semibold">{title}</p>
      {hint ? <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">{hint}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function PageTitle({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-[22px] font-bold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
