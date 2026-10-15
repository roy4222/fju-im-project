"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { IconAlertTriangle, IconArrowRight, IconChecklist, IconChevronRight, IconSignature } from "@tabler/icons-react";
import { NewsList, PageTitle, SectionHead } from "@/components/dashboard/student-v1";
import { CardFx } from "@/components/dashboard/card-fx";
import { NEWS } from "@/lib/fixtures";
import { useGradeRecords } from "@/lib/grading-store";
import { GRADING_GROUPS, TEACHER_BASE as base, consentsWaitingForMe, gradingCounts, groupsMissingWork, nextToGrade, shortTitle } from "@/lib/teacher-v2";

/**
 * 老師首頁 v2（Roy 2026-10-15，Q77～Q78）：「現在」卡（待評 N 組＋繼續評分，只出現一次）、三張待辦卡、公告。
 * 不要進度圓環、四個小格、重複清單。數字都從 lib/teacher-v2.ts。
 * 第 3 輪：與學生同一套——大標題、深橘「現在」橫幅、彩框待辦卡（滑過有漣漪）、公告清單。
 */
export function TeacherHome() {
  const records = useGradeRecords();
  const counts = gradingCounts(records);
  const next = nextToGrade(records);
  const consents = consentsWaitingForMe();
  const missing = groupsMissingWork();
  const news = NEWS.filter((n) => n.audience !== "students")
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.date.localeCompare(a.date))
    .slice(0, 4);

  return (
    <div className="flex flex-col gap-8">
      <PageTitle title="首頁" />

      {/* 1. 現在 */}
      <section aria-labelledby="now-title" data-region="now" className="hero text-white">
        <div className="grid gap-6 p-6 md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] md:items-center md:p-8">
          <div className="min-w-0">
            <p className="text-[14px] font-bold text-white">現在<span aria-hidden className="ml-3 inline-block h-px w-10 bg-white/70 align-middle" /></p>
            <h2 id="now-title" className="mt-2 text-[30px] leading-tight font-black tracking-tight md:text-[40px]">
              {counts.remaining ? <>系統驗收待評 <span className="tabular">{counts.remaining}</span> 組</> : "系統驗收都評完了"}
            </h2>
            <p className="tabular mt-2 text-[16px] font-semibold text-white">已評 {counts.submitted}／{counts.total} 組</p>
            <Link href="/timeline" className="mt-5 inline-flex h-11 items-center gap-1.5 rounded-full bg-white px-5 text-[15px] font-extrabold text-[var(--navy)] shadow-sm transition-transform hover:-translate-y-0.5 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-white/70">
              看完整時程 <IconArrowRight className="size-4" />
            </Link>
          </div>
          {next ? (
            <Link href={`${base}/grading/${next.groupId}`} className="group block rounded-2xl bg-card p-5 text-card-foreground shadow-[0_10px_30px_rgba(80,30,0,0.25)] transition-transform hover:-translate-y-0.5 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-white/70" data-next-group={next.groupId}>
              <span className="tabular text-[12px] font-bold tracking-[0.06em] text-brand-on-subtle">{next.no}</span>
              <span className="mt-1.5 block text-[18px] leading-snug font-extrabold">{next.title}</span>
              <span className="mt-4 inline-flex items-center gap-1 text-sm font-bold text-primary">
                繼續評分
                <IconArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
              </span>
            </Link>
          ) : null}
        </div>
      </section>

      {/* 2. 待辦 */}
      <section aria-labelledby="todo-title" data-region="todo">
        <SectionHead id="todo-title" title="待辦" />
        <ul className="grid gap-4 md:grid-cols-3">
          <TodoCard href={`${base}/grading`} tint="var(--brand-deep)" icon={<IconChecklist className="size-6" />} label="待評分" count={counts.remaining} unit="組" names={GRADING_GROUPS.filter((g) => (records[g.groupId] ?? g.seed).state !== "submitted").map((g) => `${g.no}・${g.title}`)} />
          <TodoCard href={`${base}/affairs?tab=consent`} tint="oklch(0.58 0.17 300)" icon={<IconSignature className="size-6" />} label="待我同意的同意書" count={consents.length} unit="份" names={consents.map((c) => `${c.groupNo}・${shortTitle(c.title)}`)} />
          <TodoCard href={`${base}/affairs`} tint="oklch(0.6 0.2 25)" icon={<IconAlertTriangle className="size-6" />} label="缺件的組" count={missing.length} unit="組" names={missing.map((g) => `${g.no}・${shortTitle(g.title)}`)} />
        </ul>
      </section>

      {/* 3. 公告 */}
      <section aria-labelledby="news-title" data-region="news">
        <SectionHead id="news-title" title="公告" href="/news" link="全部公告" />
        <NewsList news={news} />
      </section>
    </div>
  );
}

function TodoCard({ href, tint, icon, label, count, unit, names }: { href: string; tint: string; icon: ReactNode; label: string; count: number; unit: string; names: string[] }) {
  const zero = count === 0;
  const c = zero ? "oklch(0.52 0.03 253)" : tint;
  return (
    <li>
      <Link
        href={href}
        data-todo-card={label}
        className="fx-card dash-card-hover group flex h-full flex-col rounded-2xl border-2 p-5 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ring/40"
        style={{ borderColor: `color-mix(in oklch, ${c} ${zero ? 22 : 42}%, transparent)`, background: zero ? "var(--card)" : `color-mix(in oklch, ${c} 6%, var(--card))` }}
      >
        <CardFx tint={c} />
        <div className="flex items-center gap-3.5">
          <span className="inline-flex size-12 shrink-0 items-center justify-center rounded-full text-white" style={{ background: c }}>{icon}</span>
          <span className="min-w-0 flex-1">
            <span className="block text-[15px] font-extrabold">{label}</span>
            <span className="tabular block text-[28px] leading-tight font-black">{count}<span className="ml-1 text-[15px] font-bold text-muted-foreground">{unit}</span></span>
          </span>
          <IconChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
        </div>
        {names.length ? (
          <ul className="mt-3 flex flex-col gap-1 border-t pt-3 text-[13.5px] font-semibold" style={{ borderColor: `color-mix(in oklch, ${c} 20%, transparent)` }}>
            {names.slice(0, 3).map((n) => <li key={n} className="truncate">{n}</li>)}
          </ul>
        ) : null}
      </Link>
    </li>
  );
}
