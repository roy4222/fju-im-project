import Link from "next/link";
import type { ReactNode } from "react";
import { IconAlertTriangle, IconCheck, IconChevronRight, IconClock, IconPin, IconSignature } from "@tabler/icons-react";
import { daysUntil, type NewsItem } from "@/lib/fixtures";
import type { StudentTodo, TodoStatus } from "@/lib/student-v1";

/**
 * 學生後台 v1 共用小元件（Roy 2026-10-15）。
 * 狀態標籤只有四種：快到期橘、逾期紅、已交綠勾、其他是灰色的「待交」。同意書沒有截止日。
 */
export function md(d: string) {
  return `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
}

/** 「8/26 截止」 + 「剩 9 天」／「逾期 3 天」 */
export function dueText(t: StudentTodo): { date: string; rel?: string } {
  if (!t.due) return { date: "沒有截止日" };
  const d = daysUntil(t.due);
  if (t.status === "done") return { date: `${md(t.due)} 截止` };
  if (d < 0) return { date: `${md(t.due)} 截止`, rel: `逾期 ${-d} 天` };
  if (d === 0) return { date: `${md(t.due)} 截止`, rel: "今天截止" };
  return { date: `${md(t.due)} 截止`, rel: `剩 ${d} 天` };
}

const TAG: Record<TodoStatus, { cls: string; icon?: ReactNode }> = {
  soon: { cls: "bg-brand-subtle text-brand-on-subtle", icon: <IconClock className="size-3.5" /> },
  overdue: { cls: "bg-destructive-subtle text-destructive-on-subtle", icon: <IconAlertTriangle className="size-3.5" /> },
  done: { cls: "bg-success-subtle text-success-on-subtle", icon: <IconCheck className="size-3.5" strokeWidth={3} /> },
  open: { cls: "bg-muted text-muted-foreground" },
};

export function tagLabel(t: StudentTodo): string {
  if (t.kind === "consent") return t.status === "done" ? "已同意" : "待你同意";
  return { soon: "快到期", overdue: "逾期", done: "已交", open: "待交" }[t.status];
}

export function TodoTag({ todo }: { todo: StudentTodo }) {
  const tag = TAG[todo.status];
  return (
    <span className={`inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2.5 text-[12px] font-bold whitespace-nowrap ${tag.cls}`}>
      {tag.icon}
      {tagLabel(todo)}
    </span>
  );
}

/** 左邊色條：一眼看出狀態 */
export const STRIP: Record<TodoStatus, string> = {
  soon: "before:bg-brand",
  overdue: "before:bg-destructive",
  done: "before:bg-success",
  open: "before:bg-border",
};

/** 首頁待辦一列：名稱、截止日、狀態標籤，其他都不放 */
export function TodoRow({ todo, base }: { todo: StudentTodo; base: string }) {
  const due = dueText(todo);
  return (
    <li>
      <Link
        href={base + todo.href}
        data-todo={todo.status}
        className={`dash-card-hover group relative flex items-center gap-3 overflow-hidden rounded-2xl border border-border/80 bg-card py-3.5 pr-3 pl-5 before:absolute before:inset-y-0 before:left-0 before:w-1.5 ${STRIP[todo.status]} focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ring/40`}
      >
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            {todo.kind === "consent" ? <IconSignature className="size-4 shrink-0 text-primary" aria-label="同意書" /> : null}
            <span className={`truncate text-[15px] font-bold ${todo.status === "done" ? "text-muted-foreground" : ""}`}>{todo.title}</span>
          </span>
          <span className="tabular mt-0.5 block text-[13px] text-muted-foreground">
            {due.date}
            {due.rel ? <span className={todo.status === "overdue" ? "text-destructive" : todo.status === "soon" ? "font-semibold text-brand-on-subtle" : ""}>・{due.rel}</span> : null}
          </span>
        </span>
        <TodoTag todo={todo} />
        <IconChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
      </Link>
    </li>
  );
}

/** 區塊標題：名詞＋右邊一個「全部 →」 */
export function SectionHead({ id, title, href, link, count }: { id: string; title: string; href?: string; link?: string; count?: number }) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-3">
      <h2 id={id} className="text-[17px] font-extrabold tracking-tight">
        {title}
        {count !== undefined ? <span className="tabular ml-2 text-sm font-semibold text-muted-foreground">{count}</span> : null}
      </h2>
      {href ? (
        <Link href={href} className="inline-flex shrink-0 items-center gap-0.5 rounded-md text-[13px] font-semibold text-primary transition-colors hover:text-brand">
          {link}
          <IconChevronRight className="size-3.5" />
        </Link>
      ) : null}
    </div>
  );
}

/** 首頁公告卡片（學生、老師共用）：日期方塊＋分類＋標題，兩欄 */
export function NewsList({ news }: { news: NewsItem[] }) {
  return (
    <ul className="grid gap-2.5 md:grid-cols-2">
        {news.map((n) => (
          <li key={n.id}>
            <Link href={`/news/${n.id}`} className="dash-card-hover flex items-start gap-3.5 rounded-2xl border border-border/80 bg-card p-3.5 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ring/40">
              <span className="tabular flex size-12 shrink-0 flex-col items-center justify-center rounded-xl bg-accent text-primary">
                <span className="text-[11px] leading-none font-semibold">{Number(n.date.slice(5, 7))} 月</span>
                <span className="mt-0.5 text-[18px] leading-none font-extrabold">{Number(n.date.slice(8, 10))}</span>
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-[12px] font-semibold text-muted-foreground">
                  {n.pinned ? <span className="inline-flex items-center gap-0.5 rounded-full bg-brand-subtle px-1.5 py-px text-brand-on-subtle"><IconPin className="size-3" />置頂</span> : null}
                  {n.category}
                </span>
                <span className="mt-0.5 line-clamp-2 text-[14.5px] leading-snug font-bold">{n.title}</span>
              </span>
            </Link>
          </li>
        ))}
    </ul>
  );
}
