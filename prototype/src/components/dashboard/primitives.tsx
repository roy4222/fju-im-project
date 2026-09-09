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
    <section className={`dash-card flex flex-col overflow-hidden ${className}`}>
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
      <div className={`flex-1 ${bodyClassName}`}>{children}</div>
    </section>
  );
}

/** 統計磚（V1）：白卡、右上彩色 icon 方塊、黑色大數字、底部迷你長條。 */
export function StatTile({ label, value, unit, hint, trend, chart, tone = "default", href, icon }: { label: string; value: string | number; unit?: string; hint?: string; trend?: { value: number; label?: string }; chart?: ReactNode; tone?: "default" | "warning" | "danger" | "success" | "brand" | "info"; href?: string; icon?: ReactNode }) {
  const chip = { default: "bg-muted text-foreground", warning: "bg-muted text-foreground", danger: "bg-destructive-subtle text-destructive-on-subtle", success: "bg-muted text-foreground", brand: "bg-brand text-brand-foreground", info: "bg-muted text-foreground" }[tone];
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-medium text-muted-foreground">{label}</span>
        {icon ? <span className={`inline-flex size-8 shrink-0 items-center justify-center rounded-[9px] ${chip} [&_svg]:size-4`}>{icon}</span> : null}
      </div>
      <p className="tabular mt-3.5 text-[30px] font-extrabold leading-none tracking-tight">
        {value}
        {unit ? <span className="ml-1 text-[13px] font-medium text-muted-foreground">{unit}</span> : null}
      </p>
      <div className="mt-3.5 flex items-end justify-between gap-3">
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          {trend ? (
            <span className={`inline-flex items-center gap-0.5 font-semibold ${trend.value >= 0 ? "text-success-on-subtle" : "text-destructive"}`}>
              {trend.value >= 0 ? <IconArrowUpRight className="size-3.5" /> : <IconArrowDownRight className="size-3.5" />}
              {trend.value > 0 ? "+" : ""}{trend.value}
            </span>
          ) : null}
          {hint ? <span className="truncate">{hint}</span> : null}
        </div>
        {chart ? <div className={`shrink-0 ${tone === "danger" ? "text-destructive" : "text-brand"}`}>{chart}</div> : null}
      </div>
    </>
  );
  const cls = "dash-card block p-5";
  return href ? <Link href={href} className={`${cls} dash-card-hover`}>{body}</Link> : <div className={cls}>{body}</div>;
}

/** 統計磚一列 */
export function StatRow({ children, cols = 4 }: { children: ReactNode; cols?: 2 | 3 | 4 }) {
  return <div className={`grid gap-4 sm:grid-cols-2 ${cols === 4 ? "xl:grid-cols-4" : cols === 3 ? "xl:grid-cols-3" : ""}`}>{children}</div>;
}

/** 問候列：一行名字、一句話、一顆主要動作（沒事時沒有按鈕）。 */
export function Greeting({ name, line, cta, aside }: { name: string; line: string; cta?: { href: string; label: string }; aside?: ReactNode }) {
  const h = new Date().getHours();
  const hello = h < 5 ? "晚安" : h < 11 ? "早安" : h < 18 ? "午安" : "晚安";
  return (
    <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
      <div className="min-w-0">
        <h1 className="text-[22px] font-extrabold tracking-tight">{hello}，{name}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{line}</p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {aside}
        {cta ? (
          <Link href={cta.href} className="btn-fju group h-[38px] rounded-lg px-4 text-[13px]">
            {cta.label}
            <IconArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
          </Link>
        ) : null}
      </div>
    </div>
  );
}

/** 需要處理列：彩色 icon 方塊、名稱、數字、一顆按鈕。 */
export function ActionRow({ label, detail, count, href, cta = "查看", tone = "default", icon }: { icon?: ReactNode; label: string; detail?: string; count: number; href: string; cta?: string; tone?: "default" | "warning" | "danger" | "brand" | "info" | "success" }) {
  const chip = { default: "bg-muted text-foreground", warning: "bg-muted text-foreground", danger: "bg-destructive-subtle text-destructive-on-subtle", brand: "bg-brand-subtle text-brand-on-subtle", info: "bg-muted text-foreground", success: "bg-muted text-foreground" }[tone];
  return (
    <li>
      <Link href={href} className="group flex items-center gap-3.5 border-t border-border/70 px-5 py-3.5 transition-colors hover:bg-accent/50">
        <span className={`inline-flex size-[34px] shrink-0 items-center justify-center rounded-[10px] ${chip} [&_svg]:size-4`}>{icon}</span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{label}</p>
          {detail ? <p className="truncate text-xs text-muted-foreground">{detail}</p> : null}
        </div>
        <span className={`tabular text-lg font-bold ${count > 0 ? "" : "text-muted-foreground/60"}`}>{count}</span>
        <span className="rounded-md bg-accent px-2.5 py-1.5 text-xs font-bold text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">{cta}</span>
      </Link>
    </li>
  );
}

const STATE_STYLE: Record<SubmissionState, string> = {
  todo: "border-border bg-muted text-muted-foreground",
  draft: "border-brand/30 bg-brand-subtle text-brand-on-subtle",
  submitted: "border-success/30 bg-success-subtle text-success-on-subtle",
  resubmit: "border-brand/30 bg-brand-subtle text-brand-on-subtle",
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
    warning: "border-border bg-muted text-foreground",
    danger: "border-destructive/35 bg-destructive-subtle text-destructive-on-subtle",
    info: "border-border bg-muted text-foreground",
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
          <div className="bg-brand" style={{ width: `${pct}%` }} />
          <div className="bg-destructive" style={{ width: `${overduePct}%` }} />
        </div>
      </div>
      {showLabel ? <span className="tabular shrink-0 text-xs text-muted-foreground">{done}/{total}</span> : null}
    </div>
  );
}

/** 沒事時的占位：一句話，不放插畫（Roy 2026-09-08 決定不用 AI 生成圖） */
export function QuietState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex min-h-[160px] flex-col items-center justify-center gap-1.5 rounded-[14px] border-[1.5px] border-dashed border-border px-6 text-center">
      <p className="text-[15px] font-bold">{title}</p>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
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
