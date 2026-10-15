"use client";

import { useState } from "react";
import Link from "next/link";
import { IconChevronLeft, IconChevronRight } from "@tabler/icons-react";
import { TodoTag } from "@/components/dashboard/student-v1";
import type { StudentTodo, TodoStatus } from "@/lib/student-v1";

/**
 * 學生首頁小月曆（Roy 2026-10-15）：只打點有截止日的日子，點日期列出當天要交的。
 * 資料只吃 studentTodos()（和待辦、交作業同一個口徑），不放活動、競賽、訂閱連結。
 */
const WEEK = ["一", "二", "三", "四", "五", "六", "日"];
const DOT: Record<TodoStatus, string> = { overdue: "bg-destructive", soon: "bg-brand", open: "bg-primary", done: "bg-success" };

function ymd(y: number, m: number, d: number) {
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function DueCalendar({ todos, today, base }: { todos: StudentTodo[]; today: string; base: string }) {
  const [view, setView] = useState({ y: Number(today.slice(0, 4)), m: Number(today.slice(5, 7)) - 1 });
  const byDay = new Map<string, StudentTodo[]>();
  for (const t of todos) if (t.due) byDay.set(t.due, [...(byDay.get(t.due) ?? []), t]);
  /* 預設選今天之後最近一個有截止的日子，打開就看得到東西 */
  const firstDue = [...byDay.keys()].filter((d) => d >= today).sort()[0] ?? today;
  const [picked, setPicked] = useState(firstDue);
  const offset = (new Date(view.y, view.m, 1).getDay() + 6) % 7;
  const days = new Date(view.y, view.m + 1, 0).getDate();
  const list = byDay.get(picked) ?? [];
  const move = (n: number) => setView((v) => { const m = v.m + n; return { y: v.y + Math.floor(m / 12), m: ((m % 12) + 12) % 12 }; });

  return (
    <div className="rounded-3xl border border-border/80 bg-card p-4" data-region="calendar">
      <div className="flex items-center justify-between">
        <button type="button" onClick={() => move(-1)} aria-label="上個月" className="inline-flex size-9 items-center justify-center rounded-xl text-muted-foreground hover:bg-accent hover:text-foreground"><IconChevronLeft className="size-4" /></button>
        <span className="tabular text-[15px] font-extrabold">{view.y} 年 {view.m + 1} 月</span>
        <button type="button" onClick={() => move(1)} aria-label="下個月" className="inline-flex size-9 items-center justify-center rounded-xl text-muted-foreground hover:bg-accent hover:text-foreground"><IconChevronRight className="size-4" /></button>
      </div>
      <div className="mt-2 grid grid-cols-7 text-center text-[11px] font-semibold text-muted-foreground">{WEEK.map((w) => <span key={w} className="py-1">{w}</span>)}</div>
      <div className="grid grid-cols-7 gap-y-1">
        {Array.from({ length: offset }, (_, i) => <span key={`e${i}`} />)}
        {Array.from({ length: days }, (_, i) => {
          const key = ymd(view.y, view.m, i + 1);
          const evs = byDay.get(key) ?? [];
          const on = key === picked;
          const isToday = key === today;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setPicked(key)}
              aria-pressed={on}
              aria-label={`${view.m + 1} 月 ${i + 1} 日${evs.length ? `，${evs.length} 件要交` : ""}`}
              data-due={evs.length ? key : undefined}
              className={`mx-auto flex size-9 flex-col items-center justify-center rounded-xl text-[13px] transition-colors focus-visible:outline-3 focus-visible:outline-offset-1 focus-visible:outline-ring/40 ${on ? "bg-primary font-bold text-primary-foreground" : isToday ? "bg-brand-subtle font-bold text-brand-on-subtle" : evs.length ? "font-bold hover:bg-accent" : "text-muted-foreground hover:bg-accent"}`}
            >
              <span className="tabular leading-none">{i + 1}</span>
              <span className="mt-1 flex h-1.5 gap-0.5">{evs.slice(0, 3).map((e) => <span key={e.id} className={`size-1.5 rounded-full ${on ? "bg-primary-foreground" : DOT[e.status]}`} />)}</span>
            </button>
          );
        })}
      </div>
      <div className="mt-3 border-t border-border/70 pt-3" aria-live="polite">
        <p className="tabular text-[12px] font-bold text-muted-foreground">{Number(picked.slice(5, 7))}/{Number(picked.slice(8, 10))}{picked === today ? "・今天" : ""}</p>
        {list.length === 0 ? (
          <p className="mt-1 text-sm text-muted-foreground">這天沒有要交的</p>
        ) : (
          <ul className="mt-1.5 flex flex-col gap-1">
            {list.map((t) => (
              <li key={t.id}>
                <Link href={base + t.href} className="flex items-center gap-2 rounded-xl px-2 py-2 text-sm font-bold transition-colors hover:bg-accent">
                  <span className="min-w-0 flex-1 truncate">{t.title}</span>
                  <TodoTag todo={t} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
