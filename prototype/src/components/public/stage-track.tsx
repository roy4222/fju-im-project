import Link from "next/link";
import { IconCheck, IconChevronRight, IconFlag } from "@tabler/icons-react";
import { daysUntil, stageTasksFor, type Role, type Stage } from "@/lib/fixtures";

/**
 * 前台「專題時程」里程碑（學生後台 v1，Roy 2026-10-15）：不用表格。
 * 桌機（≥1024px）橫向鋸齒——卡片上下交錯掛在一條橫線上；寬度不夠時整條可以橫向捲動。
 * 手機與平板：單側直線，標記在左。
 * 每段列出「我」在這段要交的收件（依身分），目前那段用橘色。
 */
function md(d: string) {
  return `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
}
function range(from: string, to: string) {
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  return sameYear ? `${md(from)} – ${md(to)}` : `${from.slice(0, 4)}/${md(from)} – ${to.slice(0, 4)}/${md(to)}`;
}
const WORD = { done: "已完成", current: "進行中", upcoming: "還沒開始" } as const;
const CHIP = { done: "bg-success-subtle text-success-on-subtle", current: "bg-brand text-brand-foreground", upcoming: "bg-muted text-muted-foreground" } as const;

function StageCard({ s, role }: { s: Stage; role: Role }) {
  const tasks = stageTasksFor(s, role);
  const cur = s.status === "current";
  return (
    <article data-stage={s.id} data-status={s.status} className={`relative rounded-2xl border p-4 ${cur ? "border-brand bg-brand-subtle shadow-[0_12px_30px_-14px_color-mix(in_oklch,var(--brand)_60%,transparent)]" : s.status === "done" ? "border-border bg-card" : "border-border bg-card/80"}`}>
      <div className="flex items-center justify-between gap-2">
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${CHIP[s.status]}`}>{cur ? "現在" : WORD[s.status]}</span>
        {s.tag ? <span className="truncate text-[11px] font-semibold text-muted-foreground">{s.tag}</span> : null}
      </div>
      <h3 className={`mt-2 text-[16px] leading-snug font-extrabold ${s.status === "upcoming" ? "text-foreground/80" : ""}`}>{s.title}</h3>
      <p className="tabular text-[12px] text-muted-foreground">{range(s.from, s.to)}{cur ? `・還有 ${daysUntil(s.to)} 天` : ""}</p>
      {cur ? <p className="mt-2 text-[13px] leading-relaxed">{s.summary}</p> : null}
      {tasks.length ? (
        <ul className="mt-3 flex flex-col gap-1.5 border-t border-border/70 pt-3">
          {tasks.map((t) => (
            <li key={t.label}>
              <Link href={t.href} className="group flex items-start gap-2 rounded-md text-[13px] leading-snug hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring/50">
                <span className={`mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full ${t.done ? "bg-success text-success-foreground" : "border-2 border-border bg-card"}`}>{t.done ? <IconCheck className="size-2.5" strokeWidth={3} /> : null}</span>
                <span className={`min-w-0 flex-1 ${t.done ? "text-muted-foreground line-through decoration-border" : "font-semibold"}`}>{t.label}</span>
                {t.due ? <span className="tabular shrink-0 text-[12px] text-muted-foreground">{md(t.due)}</span> : null}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

export function StageTrack({ stages, role }: { stages: Stage[]; role: Role }) {
  const n = stages.length;
  const curIdx = Math.max(0, stages.findIndex((s) => s.status === "current"));
  /* 第 i 個標記在第 i+1 欄與第 i+2 欄的交界：(i+1)/(n+1) */
  const fill = ((curIdx + 1) / (n + 1)) * 100;

  return (
    <>
      {/* 桌機：橫向鋸齒 */}
      <div className="hidden overflow-x-auto pb-4 lg:block" data-track="horizontal">
        <ol className="grid min-w-[1080px] gap-x-2" style={{ gridTemplateColumns: `repeat(${n + 1}, minmax(0, 1fr))`, gridTemplateRows: "auto 56px auto" }}>
          {/* 橫線：已走過的段落用綠，到目前階段為止 */}
          <li aria-hidden className="relative self-center" style={{ gridColumn: "1 / -1", gridRow: 2 }}>
            <span className="block h-1.5 rounded-full bg-border" />
            <span className="absolute inset-y-0 left-0 rounded-full bg-[linear-gradient(90deg,var(--success),var(--brand))]" style={{ width: `${fill}%` }} />
          </li>
          {stages.map((s, i) => {
            const top = i % 2 === 0;
            const col = `${i + 1} / span 2`;
            return (
              <li key={s.id} className="contents">
                <div className={`flex flex-col ${top ? "justify-end" : "justify-start"} px-1.5`} style={{ gridColumn: col, gridRow: top ? 1 : 3 }}>
                  {!top ? <span aria-hidden className="mx-auto mb-0 h-4 w-0.5 bg-border" /> : null}
                  <StageCard s={s} role={role} />
                  {top ? <span aria-hidden className="mx-auto h-4 w-0.5 bg-border" /> : null}
                </div>
                <span aria-hidden className={`z-10 place-self-center inline-flex items-center justify-center rounded-full ring-4 ring-background ${s.status === "current" ? "size-7 bg-brand text-brand-foreground" : s.status === "done" ? "size-5 bg-success text-success-foreground" : "size-5 border-[3px] border-border bg-card"}`} style={{ gridColumn: col, gridRow: 2 }}>
                  {s.status === "done" ? <IconCheck className="size-3" strokeWidth={3} /> : s.status === "current" ? <IconFlag className="size-3.5" /> : null}
                </span>
              </li>
            );
          })}
        </ol>
      </div>

      {/* 手機、平板：直線 */}
      <ol className="relative flex flex-col gap-4 before:absolute before:top-3 before:bottom-3 before:left-[11px] before:w-1 before:rounded-full before:bg-border lg:hidden" data-track="vertical">
        {stages.map((s) => (
          <li key={s.id} className="relative pl-10">
            <span aria-hidden className={`absolute top-4 left-0 inline-flex size-[26px] items-center justify-center rounded-full ring-4 ring-background ${s.status === "current" ? "bg-brand text-brand-foreground" : s.status === "done" ? "bg-success text-success-foreground" : "border-[3px] border-border bg-card"}`}>
              {s.status === "done" ? <IconCheck className="size-3.5" strokeWidth={3} /> : s.status === "current" ? <IconFlag className="size-3.5" /> : null}
            </span>
            <StageCard s={s} role={role} />
          </li>
        ))}
      </ol>
    </>
  );
}

export function NowStrip({ stage, nextLabel }: { stage: Stage; nextLabel?: { label: string; href: string } }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl bg-primary px-5 py-4 text-primary-foreground">
      <span className="rounded-full bg-brand px-2.5 py-0.5 text-[12px] font-bold text-brand-foreground">現在</span>
      <span className="text-[18px] font-extrabold">{stage.title}</span>
      <span className="tabular text-sm text-primary-foreground/80">{range(stage.from, stage.to)}・還有 {daysUntil(stage.to)} 天</span>
      {nextLabel ? (
        <Link href={nextLabel.href} className="ml-auto inline-flex h-10 items-center gap-1 rounded-full bg-white/12 px-4 text-sm font-bold ring-1 ring-white/25 transition-colors hover:bg-white/20">
          {nextLabel.label}
          <IconChevronRight className="size-4" />
        </Link>
      ) : null}
    </div>
  );
}

/**
 * 精簡階段軸（原型第 3 輪，「看完整時程」頁上方）：只有階段名、日期、目前在哪；各階段要交的東西在下面的月曆。
 * 桌機橫的、手機直的。過去綠勾、現在深橘、未來灰。
 */
export function StageRail({ stages }: { stages: Stage[] }) {
  const dot = (s: Stage) =>
    s.status === "current" ? "size-8 bg-[var(--brand-deep)] text-white shadow-[0_0_0_6px_color-mix(in_oklch,var(--brand-deep)_18%,transparent)]" : s.status === "done" ? "size-6 bg-success text-success-foreground" : "size-6 border-[3px] border-border bg-card";
  const icon = (s: Stage) => (s.status === "done" ? <IconCheck className="size-3.5" strokeWidth={3} /> : s.status === "current" ? <IconFlag className="size-4" /> : null);
  return (
    <>
      <ol className="hidden rounded-3xl border border-border bg-card px-4 pt-6 pb-5 lg:grid" style={{ gridTemplateColumns: `repeat(${stages.length}, minmax(0, 1fr))` }} data-track="horizontal">
        {stages.map((s, i) => (
          <li key={s.id} data-status={s.status} className="relative flex flex-col items-center px-1 text-center">
            {i > 0 ? <span aria-hidden className={`absolute top-4 right-1/2 left-[-50%] h-1 -translate-y-1/2 ${s.status === "upcoming" ? "bg-border" : "bg-success"}`} /> : null}
            <span className="flex h-8 items-center"><span className={`relative z-10 inline-flex items-center justify-center rounded-full ${dot(s)}`}>{icon(s)}</span></span>
            {s.status === "current" ? <span className="mt-2 rounded-full bg-[var(--brand-deep)] px-2 py-px text-[11px] font-bold text-white">現在</span> : <span className="mt-2 h-[18px]" />}
            <span className={`mt-1 text-[15px] leading-snug font-extrabold ${s.status === "upcoming" ? "text-muted-foreground" : ""}`}>{s.title}</span>
            <span className="tabular text-[12px] text-muted-foreground">{range(s.from, s.to)}</span>
            {s.status === "current" ? <span className="tabular text-[12px] font-bold text-brand-on-subtle">還有 {daysUntil(s.to)} 天</span> : null}
          </li>
        ))}
      </ol>
      <ol className="relative flex flex-col gap-3 rounded-3xl border border-border bg-card p-4 before:absolute before:top-7 before:bottom-7 before:left-[31px] before:w-1 before:rounded-full before:bg-border lg:hidden" data-track="vertical">
        {stages.map((s) => (
          <li key={s.id} data-status={s.status} className="relative flex min-h-8 items-center gap-3">
            <span className="flex w-8 shrink-0 justify-center"><span className={`relative z-10 inline-flex items-center justify-center rounded-full ring-4 ring-card ${dot(s)}`}>{icon(s)}</span></span>
            <span className="min-w-0 flex-1">
              <span className={`text-[15px] font-extrabold ${s.status === "upcoming" ? "text-muted-foreground" : ""}`}>{s.title}</span>
              {s.status === "current" ? <span className="ml-2 rounded-full bg-[var(--brand-deep)] px-2 py-px align-middle text-[11px] font-bold text-white">現在</span> : null}
            </span>
            <span className="tabular shrink-0 text-[12px] text-muted-foreground">{range(s.from, s.to)}</span>
          </li>
        ))}
      </ol>
    </>
  );
}
