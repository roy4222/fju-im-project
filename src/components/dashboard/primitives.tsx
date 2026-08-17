import Link from "next/link";
import type { ReactNode } from "react";
import { IconArrowRight } from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { STATE_LABEL, type SubmissionState } from "@/lib/fixtures";

/** 面板：Dashboard 的基本容器。標題為名詞，右上角是唯一動作。 */
export function Panel({
  title,
  description,
  action,
  children,
  className = "",
}: {
  title: string;
  description?: string;
  action?: { href: string; label: string };
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-lg border border-border bg-card ${className}`}>
      <div className="flex items-start justify-between gap-4 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{title}</h2>
          {description ? (
            <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {action ? (
          <Link
            href={action.href}
            className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary hover:underline"
          >
            {action.label}
            <IconArrowRight className="size-3.5" />
          </Link>
        ) : null}
      </div>
      {children}
    </section>
  );
}

/**
 * 統計磚。刻意做得樸素：MOC §3.6 明確禁止營收／訂閱假數據，
 * §10.4 要求 Dashboard 先回答「我現在要做什麼」，統計排在後面。
 */
export function StatTile({
  label,
  value,
  unit,
  tone = "default",
  hint,
  href,
}: {
  label: string;
  value: string | number;
  unit?: string;
  tone?: "default" | "warning" | "danger" | "success";
  hint?: string;
  href?: string;
}) {
  const toneClass = {
    default: "text-foreground",
    warning: "text-warning-on-subtle",
    danger: "text-destructive",
    success: "text-success-on-subtle",
  }[tone];

  const body = (
    <>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`tabular mt-1 text-2xl font-semibold leading-none ${toneClass}`}>
        {value}
        {unit ? (
          <span className="ml-1 text-sm font-normal text-muted-foreground">{unit}</span>
        ) : null}
      </p>
      {hint ? <p className="mt-1.5 text-xs text-muted-foreground">{hint}</p> : null}
    </>
  );

  if (href) {
    return (
      <Link
        href={href}
        className="rounded-lg border border-border bg-card p-4 transition-colors hover:border-primary/40 hover:bg-accent/40"
      >
        {body}
      </Link>
    );
  }
  return <div className="rounded-lg border border-border bg-card p-4">{body}</div>;
}

const STATE_STYLE: Record<SubmissionState, string> = {
  todo: "border-border bg-muted text-muted-foreground",
  draft: "border-info/30 bg-info-subtle text-info-on-subtle",
  submitted: "border-success/30 bg-success-subtle text-success-on-subtle",
  resubmit: "border-warning/35 bg-warning-subtle text-warning-on-subtle",
  overdue: "border-destructive/35 bg-destructive-subtle text-destructive-on-subtle",
  locked: "border-border bg-muted text-muted-foreground",
};

export function StateBadge({ state }: { state: SubmissionState }) {
  return (
    <Badge variant="outline" className={`shrink-0 text-[11px] ${STATE_STYLE[state]}`}>
      {STATE_LABEL[state]}
    </Badge>
  );
}

/** 進度條。用於完成率，不用圖表庫（MOC §14.3：Dashboard 不載入無關圖表庫）。 */
export function ProgressBar({
  done,
  total,
  overdue = 0,
}: {
  done: number;
  total: number;
  overdue?: number;
}) {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  const overduePct = total === 0 ? 0 : Math.round((overdue / total) * 100);
  return (
    <div className="flex items-center gap-2.5">
      <div
        className="h-1.5 min-w-16 flex-1 overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={`完成 ${done} 組，共 ${total} 組${overdue ? `，逾期 ${overdue} 組` : ""}`}
      >
        <div className="flex h-full">
          <div className="bg-success" style={{ width: `${pct}%` }} />
          <div className="bg-destructive" style={{ width: `${overduePct}%` }} />
        </div>
      </div>
      <span className="tabular shrink-0 text-xs text-muted-foreground">
        {done}/{total}
      </span>
    </div>
  );
}

/** 空狀態。MOC §10.3 要求空白／載入／錯誤／無權限／無搜尋結果彼此不同。 */
export function EmptyState({
  title,
  hint,
  icon,
}: {
  title: string;
  hint?: string;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
      {icon ? <div className="text-muted-foreground">{icon}</div> : null}
      <p className="text-sm font-medium">{title}</p>
      {hint ? (
        <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
