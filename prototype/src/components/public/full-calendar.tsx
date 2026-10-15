"use client";

import Link from "next/link";
import { useState } from "react";
import { IconChevronLeft, IconChevronRight } from "@tabler/icons-react";

/**
 * 完整月曆（原型第 3 輪，Roy 2026-10-15）：「看完整時程」頁下半部。
 * 月曆上標截止日與活動；桌機格子裡直接寫事件名，手機只打點。右邊（手機在下面）是本月清單，點日期只看那天。
 * 之後會跟 Google 日曆連動，這版不做也不放佔位。
 */
export type CalItem = { id: string; date: string; title: string; tone: Tone; tag: string; href?: string; time?: string };
export type Tone = "deadline" | "overdue" | "done" | "event" | "competition";

const TONE: Record<Tone, { dot: string; chip: string }> = {
  deadline: { dot: "bg-brand", chip: "bg-brand-subtle text-brand-on-subtle" },
  overdue: { dot: "bg-destructive", chip: "bg-destructive-subtle text-destructive-on-subtle" },
  done: { dot: "bg-success", chip: "bg-success-subtle text-success-on-subtle" },
  event: { dot: "bg-primary", chip: "bg-accent text-primary" },
  competition: { dot: "bg-[oklch(0.55_0.17_300)]", chip: "bg-[oklch(0.95_0.03_300)] text-[oklch(0.42_0.15_300)] dark:bg-[oklch(0.3_0.06_300)] dark:text-[oklch(0.88_0.06_300)]" },
};
const LEGEND: { tone: Tone; label: string }[] = [
  { tone: "deadline", label: "截止" },
  { tone: "event", label: "活動" },
  { tone: "competition", label: "競賽" },
];
const WEEK = ["一", "二", "三", "四", "五", "六", "日"];

function ymd(y: number, m: number, d: number) {
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
function md(d: string) {
  return `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
}

export function FullCalendar({ items, today }: { items: CalItem[]; today: string }) {
  const [view, setView] = useState({ y: Number(today.slice(0, 4)), m: Number(today.slice(5, 7)) - 1 });
  const [picked, setPicked] = useState<string | null>(null);
  const byDay = new Map<string, CalItem[]>();
  for (const it of items) byDay.set(it.date, [...(byDay.get(it.date) ?? []), it]);
  const offset = (new Date(view.y, view.m, 1).getDay() + 6) % 7;
  const days = new Date(view.y, view.m + 1, 0).getDate();
  const cells = Math.ceil((offset + days) / 7) * 7;
  const prefix = `${view.y}-${String(view.m + 1).padStart(2, "0")}`;
  const month = items.filter((i) => i.date.startsWith(prefix)).sort((a, b) => a.date.localeCompare(b.date));
  const list = picked ? byDay.get(picked) ?? [] : month;
  const move = (n: number) => {
    setPicked(null);
    setView((v) => { const m = v.m + n; return { y: v.y + Math.floor(m / 12), m: ((m % 12) + 12) % 12 }; });
  };

  return (
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_19rem]" data-region="calendar">
      <div className="rounded-3xl border border-border bg-card p-4 md:p-5">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="tabular mr-auto text-[22px] font-black tracking-tight text-[var(--navy)] dark:text-foreground">{view.y} 年 {view.m + 1} 月</h2>
          <ul className="flex items-center gap-3 text-[13px] font-semibold text-muted-foreground" aria-label="圖例">
            {LEGEND.map((l) => <li key={l.tone} className="inline-flex items-center gap-1.5"><span className={`size-2.5 rounded-full ${TONE[l.tone].dot}`} />{l.label}</li>)}
          </ul>
          <div className="flex gap-1">
            <button type="button" onClick={() => move(-1)} aria-label="上個月" className="inline-flex size-10 items-center justify-center rounded-xl ring-1 ring-border transition-colors hover:bg-accent"><IconChevronLeft className="size-4" /></button>
            <button type="button" onClick={() => move(1)} aria-label="下個月" className="inline-flex size-10 items-center justify-center rounded-xl ring-1 ring-border transition-colors hover:bg-accent"><IconChevronRight className="size-4" /></button>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-7 text-center text-[12px] font-bold text-muted-foreground">{WEEK.map((w) => <span key={w} className="pb-2">{w}</span>)}</div>
        <div className="grid grid-cols-7 overflow-hidden rounded-2xl border border-border/70 bg-border/70 [gap:1px]">
          {Array.from({ length: cells }, (_, i) => {
            const d = i - offset + 1;
            if (d < 1 || d > days) return <span key={`e${i}`} className="bg-muted/40" />;
            const key = ymd(view.y, view.m, d);
            const evs = byDay.get(key) ?? [];
            const on = key === picked;
            const isToday = key === today;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setPicked(on ? null : key)}
                aria-pressed={on}
                aria-label={`${view.m + 1} 月 ${d} 日${evs.length ? `，${evs.length} 件` : ""}`}
                data-due={evs.length ? key : undefined}
                className={`flex min-h-14 flex-col items-stretch gap-1 p-1.5 text-left transition-colors focus-visible:relative focus-visible:z-10 focus-visible:outline-3 focus-visible:outline-ring/50 md:min-h-[6.5rem] md:p-2 ${on ? "bg-accent" : "bg-card hover:bg-accent/50"}`}
              >
                <span className={`tabular inline-flex size-7 items-center justify-center self-center rounded-full text-[13px] md:self-start ${isToday ? "bg-brand font-extrabold text-brand-foreground" : evs.length ? "font-extrabold" : "text-muted-foreground"}`}>{d}</span>
                {/* 手機：只打點 */}
                <span className="flex justify-center gap-0.5 md:hidden">{evs.slice(0, 3).map((e) => <span key={e.id} className={`size-1.5 rounded-full ${TONE[e.tone].dot}`} />)}</span>
                {/* 桌機：寫事件名 */}
                <span className="hidden flex-col gap-1 md:flex">
                  {evs.slice(0, 2).map((e) => <span key={e.id} className={`truncate rounded-md px-1.5 py-0.5 text-[11.5px] font-bold ${TONE[e.tone].chip}`}>{e.title}</span>)}
                  {evs.length > 2 ? <span className="px-1.5 text-[11px] font-bold text-muted-foreground">還有 {evs.length - 2} 件</span> : null}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <section aria-live="polite" aria-labelledby="cal-list-title" className="rounded-3xl border border-border bg-card p-5 lg:sticky lg:top-24">
        <div className="flex items-baseline justify-between gap-2">
          <h3 id="cal-list-title" className="tabular text-[17px] font-extrabold">{picked ? `${md(picked)}${picked === today ? "・今天" : ""}` : `${view.m + 1} 月`}</h3>
          {picked ? <button type="button" onClick={() => setPicked(null)} className="text-[13px] font-bold text-primary hover:text-brand">看整個月</button> : null}
        </div>
        {list.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">{picked ? "這天沒有安排" : "這個月沒有安排"}</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-1">
            {list.map((e) => {
              const body = (
                <>
                  <span className="tabular w-10 shrink-0 pt-0.5 text-[13px] font-bold text-muted-foreground">{md(e.date)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[14px] leading-snug font-bold">{e.title}</span>
                    <span className="mt-1 flex items-center gap-1.5">
                      <span className={`rounded-full px-2 py-px text-[11.5px] font-bold ${TONE[e.tone].chip}`}>{e.tag}</span>
                      {e.time ? <span className="tabular text-[12px] text-muted-foreground">{e.time}</span> : null}
                    </span>
                  </span>
                </>
              );
              return (
                <li key={e.id}>
                  {e.href ? (
                    <Link href={e.href} className="flex gap-3 rounded-xl px-2 py-2.5 transition-colors hover:bg-accent">{body}</Link>
                  ) : (
                    <div className="flex gap-3 px-2 py-2.5">{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
