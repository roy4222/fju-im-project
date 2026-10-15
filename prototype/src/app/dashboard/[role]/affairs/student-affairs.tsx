import Link from "next/link";
import { IconCalendarEvent, IconChecklist, IconFileText, IconSignature } from "@tabler/icons-react";
import { TodoTag, dueText } from "@/components/dashboard/student-v1";
import { MY_GROUP } from "@/lib/fixtures";
import { TODO_TABS, studentTodos, type TodoTab } from "@/lib/student-v1";

/**
 * 學生：交作業 v1（Roy 2026-10-15，Q72）。
 * 上方篩選 待交／已交／逾期 → 卡片清單（名稱、截止、狀態，其他都進詳情頁）；同意書也是一張卡。
 * 數字口徑：studentTodos()（與首頁待辦、側欄徽章同一個函式）。
 */
const TONE: Record<TodoTab, { on: string; dot: string }> = {
  open: { on: "bg-primary text-primary-foreground", dot: "bg-brand" },
  done: { on: "bg-success text-success-foreground", dot: "bg-success" },
  overdue: { on: "bg-destructive text-white", dot: "bg-destructive" },
};

export function StudentAffairs({ tab = "open" }: { tab?: string }) {
  const base = "/dashboard/student";
  const all = studentTodos();
  const active = TODO_TABS.find((t) => t.key === tab) ?? TODO_TABS[0];
  const list = all.filter(active.match);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[26px] font-extrabold tracking-tight">交作業</h1>
          <p className="mt-1 text-sm text-muted-foreground">{MY_GROUP.no}・點卡片看說明與上傳</p>
        </div>
        <nav aria-label="篩選" className="inline-flex rounded-2xl bg-card p-1.5 ring-1 ring-border/80" data-filter>
          {TODO_TABS.map((t) => {
            const on = t.key === active.key;
            const n = all.filter(t.match).length;
            return (
              <Link
                key={t.key}
                href={`${base}/affairs${t.key === "open" ? "" : `?tab=${t.key}`}`}
                scroll={false}
                aria-current={on ? "page" : undefined}
                className={`inline-flex h-10 items-center gap-2 rounded-xl px-4 text-sm font-bold transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ring/40 ${on ? TONE[t.key].on : "text-muted-foreground hover:bg-accent hover:text-foreground"}`}
              >
                {!on ? <span aria-hidden className={`size-1.5 rounded-full ${TONE[t.key].dot}`} /> : null}
                {t.label}
                <span className={`tabular text-xs ${on ? "opacity-80" : ""}`}>{n}</span>
              </Link>
            );
          })}
        </nav>
      </div>

      {list.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-3xl border border-dashed border-border bg-card/60 px-6 py-16 text-center">
          <IconChecklist className="size-8 text-muted-foreground" />
          <p className="text-[15px] font-bold">沒有{active.label}的作業</p>
          {active.key === "overdue" ? <p className="text-sm text-muted-foreground">很好，沒有漏交的。</p> : null}
        </div>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" data-cards>
          {list.map((t) => {
            const due = dueText(t);
            const consent = t.kind === "consent";
            return (
              <li key={t.id}>
                <Link
                  href={base + t.href}
                  data-card={t.id}
                  className={`dash-card-hover group flex h-full flex-col rounded-3xl border p-5 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ring/40 ${consent ? "border-primary/15 bg-accent/70" : "border-border/80 bg-card"}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <span className={`inline-flex size-11 items-center justify-center rounded-2xl ${consent ? "bg-primary text-primary-foreground" : t.status === "overdue" ? "bg-destructive-subtle text-destructive-on-subtle" : t.status === "done" ? "bg-success-subtle text-success-on-subtle" : "bg-brand-subtle text-brand-on-subtle"}`}>
                      {consent ? <IconSignature className="size-5" /> : <IconFileText className="size-5" />}
                    </span>
                    <TodoTag todo={t} />
                  </div>
                  <p className="mt-4 text-[12px] font-bold tracking-[0.06em] text-muted-foreground">{consent ? "同意書" : "作業"}</p>
                  <h2 className="mt-0.5 text-[17px] leading-snug font-extrabold">{t.title}</h2>
                  <p className="tabular mt-auto flex items-center gap-1.5 pt-4 text-[13px] text-muted-foreground">
                    <IconCalendarEvent className="size-4" />
                    {due.date}
                    {due.rel ? <span className={t.status === "overdue" ? "font-semibold text-destructive" : t.status === "soon" ? "font-semibold text-brand-on-subtle" : ""}>・{due.rel}</span> : null}
                  </p>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
