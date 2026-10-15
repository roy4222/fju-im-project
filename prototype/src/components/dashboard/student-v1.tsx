import Link from "next/link";
import type { ReactNode } from "react";
import { IconAlertTriangle, IconCheck, IconChevronRight, IconClock, IconFileText, IconPin, IconSignature, IconSpeakerphone } from "@tabler/icons-react";
import { CardFx } from "@/components/dashboard/card-fx";
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

/** 狀態色（第 3 輪首頁卡片：彩色邊框＋大圖示＋實心狀態膠囊）。白字都 ≥4.5:1，所以橘用深橘 */
export const TINT: Record<TodoStatus, string> = {
  overdue: "var(--destructive)",
  soon: "var(--brand-deep)",
  done: "var(--success)",
  open: "oklch(0.52 0.03 253)",
};

/** 首頁待辦卡：名稱、截止日、狀態，其他都不放；滑過有漣漪 */
export function TodoCard({ todo, base }: { todo: StudentTodo; base: string }) {
  const due = dueText(todo);
  const tint = TINT[todo.status];
  const Icon = todo.kind === "consent" ? IconSignature : IconFileText;
  return (
    <li>
      <Link
        href={base + todo.href}
        data-todo={todo.status}
        className="fx-card dash-card-hover group flex h-full flex-col rounded-2xl border-2 p-4 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ring/40"
        style={{ borderColor: `color-mix(in oklch, ${tint} 42%, transparent)`, background: `color-mix(in oklch, ${tint} 6%, var(--card))` }}
      >
        <CardFx tint={tint} />
        <span className="flex items-start justify-between gap-2">
          <span className="inline-flex size-12 items-center justify-center rounded-full text-white" style={{ background: tint }}><Icon className="size-6" strokeWidth={1.8} /></span>
          <span className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-[12.5px] font-bold whitespace-nowrap text-white" style={{ background: tint }}>
            {TAG[todo.status].icon}
            {tagLabel(todo)}
          </span>
        </span>
        <span className="mt-3.5 line-clamp-2 text-[16px] leading-snug font-extrabold">{todo.title}</span>
        <span className="tabular mt-auto pt-2 text-[14px] font-bold text-muted-foreground">
          {due.date}
          {due.rel ? <span style={{ color: todo.status === "overdue" || todo.status === "soon" ? tint : undefined }}>・{due.rel}</span> : null}
        </span>
      </Link>
    </li>
  );
}

/** 區塊標題（第 3 輪）：大而粗的名詞，後面接一條細線，最右邊一個「全部 →」 */
export function SectionHead({ id, title, href, link, count }: { id: string; title: string; href?: string; link?: string; count?: number }) {
  return (
    <div className="mb-4 flex items-center gap-4">
      <h2 id={id} className="section-title shrink-0">
        {title}
        {count !== undefined ? <span className="tabular ml-2 text-base font-bold text-muted-foreground">{count}</span> : null}
      </h2>
      <span aria-hidden className="h-px min-w-6 flex-1 bg-border" />
      {href ? (
        <Link href={href} className="inline-flex shrink-0 items-center gap-0.5 rounded-md text-[14px] font-bold text-primary transition-colors hover:text-brand">
          {link}
          <IconChevronRight className="size-4" />
        </Link>
      ) : null}
    </div>
  );
}

/** 頁面大標題（第 3 輪，學生、老師共用） */
export function PageTitle({ title, sub, children }: { title: string; sub?: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="page-title">{title}</h1>
        {sub ? <p className="tabular mt-1.5 text-[15px] font-semibold text-muted-foreground">{sub}</p> : null}
      </div>
      {children}
    </div>
  );
}

/** 首頁公告（學生、老師共用）：一張清單，喇叭圖示＋標題＋日期 */
export function NewsList({ news }: { news: NewsItem[] }) {
  return (
    <ul className="overflow-hidden rounded-2xl border border-border/80 bg-card">
      {news.map((n) => (
        <li key={n.id} className="border-b border-border/70 last:border-0">
          <Link href={`/news/${n.id}`} className="group flex items-center gap-3.5 px-4 py-3.5 transition-colors hover:bg-accent/50 focus-visible:outline-3 focus-visible:outline-offset-[-3px] focus-visible:outline-ring/40 md:px-5">
            <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-subtle text-brand-on-subtle"><IconSpeakerphone className="size-[18px]" /></span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5 text-[12px] font-semibold text-muted-foreground">
                {n.pinned ? <span className="inline-flex items-center gap-0.5 rounded-full bg-brand-subtle px-1.5 py-px text-brand-on-subtle"><IconPin className="size-3" />置頂</span> : null}
                {n.category}
              </span>
              <span className="mt-0.5 block truncate text-[15px] font-bold">{n.title}</span>
            </span>
            <span className="tabular hidden shrink-0 text-[13px] text-muted-foreground sm:inline">{n.date.replaceAll("-", "/")}</span>
            <IconChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
          </Link>
        </li>
      ))}
    </ul>
  );
}
