import Link from "next/link";
import { HeroTrail } from "@/components/dashboard/hero-trail";
import { IconArrowRight, IconCalendarEvent } from "@tabler/icons-react";
import { NewsList, PageTitle, SectionHead, TodoCard, dueText, md } from "@/components/dashboard/student-v1";
import { NEWS, currentStage, daysUntil } from "@/lib/fixtures";
import { nextDue, studentTodos } from "@/lib/student-v1";

/**
 * 學生首頁 v1（Roy 2026-10-15，Q71）：「現在」卡（.hero 花紋）、待辦、公告。
 * 不要學期進度條、階段四格、三個小格、「接下來」、任何表格。
 * 第 3 輪：大標題、待辦改彩框卡片；小月曆拿掉，搬到「看完整時程」（/timeline）。
 * 第 4 輪：「現在」橫幅顏色回到深藍＋藍圓花紋，滑鼠在上面移動留下金屬像素拖尾（HeroTrail）；卡片漣漪拿掉。
 * 「下一件要交的」與待辦、交作業、側欄徽章同一個口徑（lib/student-v1.ts）。
 */
const HOME_TODOS = 5;
const HOME_NEWS = 4;

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

  return (
    <div className="flex flex-col gap-8">
      <PageTitle title="首頁" />

      {/* 1. 現在 */}
      <section aria-labelledby="now-title" data-region="now" className="hero text-white">
        <HeroTrail />
        <div className="grid gap-6 p-6 md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] md:items-center md:p-8">
          <div className="min-w-0">
            <p className="text-[14px] font-bold text-white">現在<span aria-hidden className="ml-3 inline-block h-px w-10 bg-white/70 align-middle" /></p>
            <h2 id="now-title" className="mt-2 text-[30px] leading-tight font-black tracking-tight md:text-[40px]"><span className="text-brand">{stage.title}</span>階段</h2>
            <p className="tabular mt-2 text-[16px] font-semibold text-white">{md(stage.from)} – {md(stage.to)}・還有 {left} 天</p>
            <Link href="/timeline" className="mt-5 inline-flex h-11 items-center gap-1.5 rounded-full bg-white px-5 text-[15px] font-extrabold text-[var(--navy)] shadow-sm transition-transform hover:-translate-y-0.5 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-white/70">
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

      {/* 2. 待辦 */}
      <section aria-labelledby="todo-title" data-region="todo">
        <SectionHead id="todo-title" title="待辦" href={`${base}/affairs`} link="全部作業" />
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {todos.map((t) => <TodoCard key={t.id} todo={t} base={base} />)}
        </ul>
      </section>

      {/* 4. 公告 */}
      <section aria-labelledby="news-title" data-region="news">
        <SectionHead id="news-title" title="公告" href="/news" link="全部公告" />
        <NewsList news={news} />
      </section>
    </div>
  );
}
