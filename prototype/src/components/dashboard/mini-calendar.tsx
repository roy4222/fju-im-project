"use client";

import { useState } from "react";
import Link from "next/link";
import { IconCalendarPlus, IconChevronDown, IconChevronLeft, IconChevronRight } from "@tabler/icons-react";
import { CALENDAR_KIND_LABEL, daysUntil, type CalendarEvent } from "@/lib/fixtures";

/**
 * 專題行事曆（首頁右欄）。系辦設定的截止、活動、比賽都在這；點日期看當天；「訂閱到 Google 日曆」給 .ics 網址。
 */
const WEEK = ["一", "二", "三", "四", "五", "六", "日"];
const DOT: Record<CalendarEvent["kind"], string> = { deadline: "bg-brand", event: "bg-primary", competition: "bg-success" };
const TINT: Record<CalendarEvent["kind"], string> = { deadline: "bg-brand-subtle text-brand-on-subtle", event: "bg-[oklch(0.93_0.03_253)] text-primary", competition: "bg-success-subtle text-success-on-subtle" };

function ymd(d: Date) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }

export function MiniCalendar({ events, today, canEdit = false, compactOnMobile = false }: { events: CalendarEvent[]; today: string; canEdit?: boolean; /** 手機預設縮成近期三筆，可展開整月（Codex 09-10 S-05） */ compactOnMobile?: boolean }) {
  const t = new Date(`${today}T00:00:00`);
  const [view, setView] = useState({ y: t.getFullYear(), m: t.getMonth() });
  const [picked, setPicked] = useState<string>(today);
  const [expanded, setExpanded] = useState(!compactOnMobile);
  const soon = events.filter((e) => e.date >= today).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 3);
  const monthCls = compactOnMobile && !expanded ? "max-md:hidden" : "";
  const first = new Date(view.y, view.m, 1);
  const offset = (first.getDay() + 6) % 7; // 週一開頭
  const days = new Date(view.y, view.m + 1, 0).getDate();
  const cells: (Date | null)[] = [...Array.from({ length: offset }, () => null), ...Array.from({ length: days }, (_, i) => new Date(view.y, view.m, i + 1))];
  const byDay = new Map<string, CalendarEvent[]>();
  for (const e of events) byDay.set(e.date, [...(byDay.get(e.date) ?? []), e]);
  const dayEvents = byDay.get(picked) ?? [];
  const pickedDate = new Date(`${picked}T00:00:00`);

  return (
    <div className="flex flex-col">
      {compactOnMobile ? (
        <div className="md:hidden">
          {!expanded ? (
            <ul className="flex flex-col divide-y divide-border/70 px-4 pt-1">
              {soon.map((e) => {
                const d = daysUntil(e.date);
                return (
                  <li key={e.id}>
                    <Link href={e.href ?? "#"} className="flex min-h-11 items-center gap-3 py-2 text-sm transition-colors hover:bg-accent/60">
                      <span className="tabular w-12 shrink-0 text-[13px] font-bold">{e.date.slice(5).replace("-", "/")}</span>
                      <span className="min-w-0 flex-1 truncate font-medium">{e.title}</span>
                      <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-bold ${TINT[e.kind]}`}>{d === 0 ? "今天" : `${d} 天`}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          ) : null}
          <button type="button" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded} className="flex h-11 w-full items-center justify-center gap-1 text-[13px] font-semibold text-primary transition-colors hover:bg-accent/60">
            {expanded ? "收合成近期三筆" : "展開整月"}<IconChevronDown className={`size-4 transition-transform ${expanded ? "rotate-180" : ""}`} />
          </button>
        </div>
      ) : null}
      <div className={`flex flex-col ${monthCls}`}>
      <div className="flex items-center justify-between px-4 pt-3 pb-1">
        <button type="button" onClick={() => setView((v) => (v.m === 0 ? { y: v.y - 1, m: 11 } : { y: v.y, m: v.m - 1 }))} className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="上個月"><IconChevronLeft className="size-4" /></button>
        <span className="tabular text-sm font-bold">{view.y} 年 {view.m + 1} 月</span>
        <button type="button" onClick={() => setView((v) => (v.m === 11 ? { y: v.y + 1, m: 0 } : { y: v.y, m: v.m + 1 }))} className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="下個月"><IconChevronRight className="size-4" /></button>
      </div>
      <div className="grid grid-cols-7 px-3 text-center text-[11px] font-semibold text-muted-foreground">{WEEK.map((w) => <span key={w} className="py-1">{w}</span>)}</div>
      <div className="grid grid-cols-7 gap-y-0.5 px-3 pb-2">
        {cells.map((d, i) => {
          if (!d) return <span key={`e${i}`} />;
          const key = ymd(d);
          const evs = byDay.get(key) ?? [];
          const isToday = key === today, isPicked = key === picked;
          return (
            <button key={key} type="button" onClick={() => setPicked(key)} className={`group relative mx-auto flex h-8 w-8 flex-col items-center justify-center rounded-full text-[13px] transition-colors ${isPicked ? "bg-primary font-bold text-primary-foreground" : isToday ? "bg-brand-subtle font-bold text-brand-on-subtle" : "hover:bg-accent"}`} aria-label={`${key}${evs.length ? `，${evs.length} 件` : ""}`} aria-pressed={isPicked}>
              <span className="tabular leading-none">{d.getDate()}</span>
              {evs.length ? <span className="mt-0.5 flex gap-0.5">{evs.slice(0, 3).map((e) => <span key={e.id} className={`size-1 rounded-full ${isPicked ? "bg-primary-foreground" : DOT[e.kind]}`} />)}</span> : <span className="mt-0.5 h-1" />}
            </button>
          );
        })}
      </div>
      <div className="border-t border-border/70 px-4 py-3">
        <p className="tabular text-xs font-bold text-muted-foreground">{pickedDate.getMonth() + 1} 月 {pickedDate.getDate()} 日{picked === today ? "・今天" : ""}</p>
        {dayEvents.length === 0 ? <p className="mt-1 text-sm text-muted-foreground">沒有活動。</p> : (
          <ul className="mt-1.5 flex flex-col gap-1.5">
            {dayEvents.map((e) => (
              <li key={e.id}>
                <Link href={e.href ?? "#"} className="flex items-center gap-2.5 rounded-lg px-1 py-1 text-sm transition-colors hover:bg-accent/60">
                  <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-bold ${TINT[e.kind]}`}>{CALENDAR_KIND_LABEL[e.kind]}</span>
                  <span className="min-w-0 flex-1 truncate font-medium">{e.title}</span>
                  {e.time ? <span className="tabular shrink-0 text-xs text-muted-foreground">{e.time}</span> : null}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex items-center gap-3 border-t border-border/70 px-4 py-2.5 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1"><span className="size-1.5 rounded-full bg-brand" />截止</span>
        <span className="inline-flex items-center gap-1"><span className="size-1.5 rounded-full bg-primary" />活動</span>
        <span className="inline-flex items-center gap-1"><span className="size-1.5 rounded-full bg-success" />競賽</span>
        <a href="/api/calendar" className="ml-auto inline-flex items-center gap-1 font-semibold text-primary hover:underline"><IconCalendarPlus className="size-3.5" />訂閱到 Google 日曆</a>
        {canEdit ? <Link href="/dashboard/admin/editor/new" className="font-semibold text-brand hover:underline">新增活動</Link> : null}
      </div>
      </div>
    </div>
  );
}
