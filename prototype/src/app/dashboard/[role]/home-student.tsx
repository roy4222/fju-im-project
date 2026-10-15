import Link from "next/link";
import { IconArrowRight, IconCalendarEvent } from "@tabler/icons-react";
import { NewsList, SectionHead, TodoRow, dueText, md } from "@/components/dashboard/student-v1";
import { DueCalendar } from "@/components/dashboard/due-calendar";
import { CURRENT_USERS, NEWS, TODAY_YMD, currentStage, daysUntil } from "@/lib/fixtures";
import { nextDue, studentTodos } from "@/lib/student-v1";

/**
 * 學生首頁 v1（Roy 2026-10-15，Q71）：「現在」卡（.hero 花紋）、待辦＋小月曆、公告。
 * 不要學期進度條、階段四格、三個小格、「接下來」、任何表格；月曆只打點截止日（第 2 輪）。
 * 「下一件要交的」與待辦、交作業、側欄徽章同一個口徑（lib/student-v1.ts）。
 */
const HOME_TODOS = 5;
const HOME_NEWS = 5;

export function StudentHome() {
  const base = "/dashboard/student";
  const stage = currentStage();
  const left = daysUntil(stage.to);
  const next = nextDue();
  const todos = studentTodos().slice(0, HOME_TODOS);
  /* 公告：置頂在前，其餘新到舊（AC-V10：置頂順序要保留）；老師限定的不給學生看 */
  const news = NEWS.filter((n) => n.audience !== "teachers")
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.date.localeCompare(a.date))
    .slice(0, HOME_NEWS);
  const name = CURRENT_USERS.student.name;

  return (
    <div className="flex flex-col gap-7">
      {/* 1. 現在 */}
      <section aria-labelledby="now-title" data-region="now" className="hero text-primary-foreground">
        <div className="grid gap-6 p-6 md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] md:items-center md:p-8">
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-primary-foreground/75">{name}，你好</p>
            <h1 id="now-title" className="mt-2 text-[26px] leading-tight font-extrabold tracking-tight md:text-[30px]">
              現在是<span className="text-brand">「{stage.title}」</span>階段
            </h1>
            <p className="tabular mt-2 text-[15px] text-primary-foreground/80">{md(stage.from)} – {md(stage.to)}・還有 {left} 天</p>
            <Link href="/timeline" className="mt-5 inline-flex h-10 items-center gap-1.5 rounded-full bg-white/12 px-4 text-sm font-bold ring-1 ring-white/25 transition-colors hover:bg-white/20 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-white/60">
              看完整時程 <IconArrowRight className="size-4" />
            </Link>
          </div>
          {next ? (
            <Link href={base + next.href} className="group block rounded-2xl bg-card p-5 text-card-foreground shadow-[0_10px_30px_rgba(0,20,50,0.25)] transition-transform hover:-translate-y-0.5 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-white/70">
              <span className="text-[12px] font-bold tracking-[0.06em] text-brand-on-subtle">下一件要交的</span>
              <span className="mt-1.5 block text-[18px] leading-snug font-extrabold">{next.title}</span>
              <span className="tabular mt-2 flex items-center gap-1.5 text-sm text-muted-foreground">
                <IconCalendarEvent className="size-4" />
                {dueText(next).date}
                {dueText(next).rel ? <span className="font-bold text-brand-on-subtle">・{dueText(next).rel}</span> : null}
              </span>
              <span className="mt-4 inline-flex items-center gap-1 text-sm font-bold text-primary">
                {next.draft ? "繼續填寫" : "去交"}
                <IconArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
              </span>
            </Link>
          ) : (
            <div className="rounded-2xl bg-card p-5 text-card-foreground">
              <span className="text-[12px] font-bold tracking-[0.06em] text-success-on-subtle">下一件要交的</span>
              <span className="mt-1.5 block text-[18px] font-extrabold">目前沒有要交的</span>
            </div>
          )}
        </div>
      </section>

      <div className="grid items-start gap-7 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        {/* 2. 待辦 */}
        <section aria-labelledby="todo-title" data-region="todo">
          <SectionHead id="todo-title" title="待辦" href={`${base}/affairs`} link="全部作業" />
          <ul className="flex flex-col gap-2.5">
            {todos.map((t) => <TodoRow key={t.id} todo={t} base={base} />)}
          </ul>
        </section>

        {/* 3. 月曆：只打點截止日 */}
        <section aria-labelledby="cal-title">
          <SectionHead id="cal-title" title="截止日" />
          <DueCalendar todos={studentTodos()} today={TODAY_YMD} base={base} />
        </section>
      </div>

      {/* 4. 公告 */}
      <section aria-labelledby="news-title" data-region="news">
        <SectionHead id="news-title" title="公告" href="/news" link="全部公告" />
        <NewsList news={news} />
      </section>
    </div>
  );
}
