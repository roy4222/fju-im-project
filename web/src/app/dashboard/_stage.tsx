import Link from 'next/link'
import { isValidElement, type ReactNode } from 'react'
import { IconArrowRight, IconCalendarEvent } from '@tabler/icons-react'
import { HeroTrail } from '@/app/_ui/fx/hero-trail'
import type { ResolvedActor } from '@/application/accounts'
import type { Cohort, CohortSchedule, StagePosition } from '@/application/cohorts'
import {
  cohortLabel,
  describeStagePosition,
  getBusinessClockQuery,
  getCohortStatusQuery,
  getTimelineQuery,
  stagePositionAt,
} from '@/composition/cohorts'
import { cn } from '@/shared/cn'
import { formatTaipeiDate, formatTaipeiMinute, taipeiDateOf, type TaipeiDate } from '@/shared/time'
import './_stage.css'

/**
 * 三角色首頁頂端的「現在」橫幅（票 11；S02-05；2026-10-16 共用 SH-4 照原型 v4 重寫）。
 *
 * 階段文案固定三態：尚未開始／階段 n：名稱／年度階段已結束（沒設階段時說「尚未設定階段」）。
 * 用業務鐘算：測試站把模擬鐘推開，三個角色的首頁一起變。
 * 只講時間，不講誰做完了什麼——進入期中不代表已交期中報告（產品模組 02 §4）。
 *
 * 看哪一屆：學生看自己所屬的屆別；老師與管理員看預設工作屆別（切換屆別在後面的票）。
 * 外觀是原型的深藍橫幅（`.hero`，樣式在 `_stage.css`）；橘色只給主要動作與目前這一段。
 */

export type StageContext = {
  readonly cohort: Cohort | null
  readonly schedule: CohortSchedule | null
  readonly position: StagePosition | null
  /** 業務鐘的「今天」（臺灣日期）。 */
  readonly today: TaipeiDate
  readonly businessNow: Date
  /** 測試站撥過模擬鐘：色塊上註明模擬時間。 */
  readonly simulated: boolean
}

/**
 * 首頁每次都先跑這裡，查詢盡量同時發（共用 SH-P3）：
 * 學生的屆別直接從身分拿，屆別、階段、業務鐘一起查；職員要等預設工作屆別回來才知道查哪一屆的階段。
 * 業務鐘只在測試站（模擬鐘開啟）才讀資料庫。
 */
export async function loadStage(actor: ResolvedActor, perspective: 'student' | 'staff'): Promise<StageContext> {
  const cohortQuery = getCohortStatusQuery()
  const timelineQuery = getTimelineQuery()
  const clockState = getBusinessClockQuery().state()
  let cohort: Cohort | null
  let schedule: CohortSchedule | null
  let clock: Awaited<typeof clockState>
  if (perspective === 'student') {
    const cohortId = actor.kind === 'authenticated' ? actor.cohortMemberships[0]?.cohortId : undefined
    ;[cohort, schedule, clock] = await Promise.all([
      cohortId ? cohortQuery.get(cohortId) : null,
      cohortId ? timelineQuery.schedule(cohortId) : null,
      clockState,
    ])
  } else {
    ;[cohort, clock] = await Promise.all([cohortQuery.defaultWorking(), clockState])
    schedule = cohort ? await timelineQuery.schedule(cohort.id) : null
  }
  if (!cohort) schedule = null
  return {
    cohort,
    schedule,
    position: schedule ? stagePositionAt(schedule, clock.businessNow) : null,
    today: taipeiDateOf(clock.businessNow),
    businessNow: clock.businessNow,
    simulated: Boolean(clock.latest),
  }
}

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六']

/** `8 月 17 日・星期一`（臺灣日期本身算星期，不碰瀏覽器時區）。 */
export function heroDate(date: TaipeiDate): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  return `${m} 月 ${d} 日・星期${WEEKDAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}`
}

/** 從今天到那一天還有幾天（臺灣日曆日相減）。 */
export function daysBetween(from: TaipeiDate, to: TaipeiDate): number {
  const toUtc = (s: string) => {
    const [y, m, d] = s.split('-').map(Number) as [number, number, number]
    return Date.UTC(y, m - 1, d)
  }
  return Math.round((toUtc(to) - toUtc(from)) / 86_400_000)
}

/** 本屆進度：第 1 階段開始到年度結束日，今天走到哪（整數百分比）；沒設階段是 null。 */
export function cohortProgress(ctx: StageContext): number | null {
  const s = ctx.schedule
  if (!s?.yearEndDate || s.stages.length === 0) return null
  const total = daysBetween(s.stages[0]!.startDate, s.yearEndDate) + 1
  const done = daysBetween(s.stages[0]!.startDate, ctx.today) + 1
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)))
}

/** 職員視角沒有預設屆別時的那一句（AC-SH-68：不再叫人去「屆別」頁，側欄已經沒有那一項）。 */
const NO_COHORT = {
  student: '你還沒有歸屬的屆別；帳號核准並歸到某一屆之後，這裡會顯示現在的階段。',
  staff: '還沒有設定後台預設查看的屆別。',
} as const

/**
 * 橫幅的大字：現在在哪一段（e2e 用 `stage-text` 斷言，內容是 `describeStagePosition` 的字，例如「階段 2：期中」）。
 * 還沒有屆別或沒排階段時改成一句說明，字小一號。`text` 是角色頁自己給的字（`stage` prop），沒給就從業務鐘算。
 */
function StageSentence({ ctx, perspective, text }: { ctx: StageContext; perspective: 'student' | 'staff'; text?: string }) {
  if (!ctx.cohort || !ctx.position) {
    return <p className="mt-2 max-w-[40ch] text-[18px] leading-snug font-bold md:text-[20px]">{NO_COHORT[perspective]}</p>
  }
  return (
    <p className="mt-2 text-[32px] leading-tight font-black tracking-tight break-keep md:text-[40px]">
      <span className="text-primary" data-testid="stage-text">
        {text ?? describeStagePosition(ctx.position)}
      </span>
    </p>
  )
}

/** 大字下面那行：這一段的日期與剩幾天；尚未開始時說第 1 階段哪天開始。`daysLeft` 是 null 就不寫天數。 */
function stageDetail(ctx: StageContext, stage?: { daysLeft: number | null }): string | null {
  const p = ctx.position
  const daysLeft = stage ? stage.daysLeft : daysLeftOf(ctx)
  const days = daysLeft === null ? null : daysLeft === 0 ? '今天是最後一天' : `還有 ${daysLeft} 天`
  if (p?.kind === 'in_stage') {
    const start = ctx.schedule?.stages.find((s) => s.seq === p.seq)?.startDate
    const range = start ? `${formatTaipeiDate(start).slice(5)} – ${formatTaipeiDate(p.lastDate).slice(5)}` : null
    return [range, days].filter(Boolean).join('・') || null
  }
  // 角色頁自己給了天數就照它說；否則尚未開始時說第 1 階段哪天開始。
  if (p?.kind === 'not_started' && !stage) return `第 1 階段 ${formatTaipeiDate(p.firstStartDate).slice(5)} 開始`
  return days
}

/** 這一段還剩幾天（最後一天是 0）；不在某一段裡就是 null。 */
function daysLeftOf(ctx: StageContext): number | null {
  return ctx.position?.kind === 'in_stage' ? daysBetween(ctx.today, ctx.position.lastDate) : null
}

/** @deprecated SH-4 起橫幅不畫小格，傳了也不會顯示；三角色首頁改完後刪。 */
export type HeroChip = { label: string; value: string; href: string; hot?: boolean; testId?: string }
export type HeroNext = { title: string; due: string; href: string; label: string }

function isHeroNext(next: HeroNext | ReactNode): next is HeroNext {
  return typeof next === 'object' && next !== null && !isValidElement(next) && typeof (next as { href?: unknown }).href === 'string'
}

/** 右欄白卡：學生是「下一件要交的」，職員是「下一步」；角色頁要別的樣子就直接傳 ReactNode。 */
function NextCard({ next, perspective }: { next: HeroNext; perspective: 'student' | 'staff' }) {
  return (
    <>
      <p className="text-[12px] font-bold tracking-[0.06em] text-primary-on-subtle">{perspective === 'student' ? '下一件要交的' : '下一步'}</p>
      <p className="mt-1.5 text-[18px] leading-snug font-extrabold">{next.title}</p>
      <p className="mt-2 flex items-center gap-1.5 text-[14px] text-muted-foreground tabular-nums">
        <IconCalendarEvent className="size-4 shrink-0" aria-hidden />
        {next.due}
      </p>
      <Link href={next.href} className="btn-fju mt-4 h-11 rounded-lg px-5 text-[14px] max-sm:w-full">
        {next.label}
        <IconArrowRight className="size-4" aria-hidden />
      </Link>
    </>
  )
}

/**
 * 三角色首頁頂端的「現在」橫幅（共用 SH-4；原型 v4 home-student／home-teacher-v2）。
 * 左欄：歡迎（h1）、小字「現在」＋角色自己的一句、大字階段、日期與剩幾天、「看完整時程」＋主要動作（只一顆）。
 * 右欄：`next` 白卡（`hero-next`）；沒有 `next` 時左欄佔滿。
 * `trail`（學生、老師）在橫幅底下掛金屬像素拖尾；手機、觸控、減少動態不載入。
 * 舊版的進度條、階段四格、小格、插圖、compact 都拿掉了：那幾個 props 只為了三角色首頁還沒改前能編譯，傳了會被忽略。
 */
export function HomeHero({
  ctx,
  perspective,
  name,
  line,
  stage,
  cta,
  timelineHref,
  next,
  trail = false,
}: {
  ctx: StageContext
  perspective: 'student' | 'staff'
  name: string
  /** 「現在」旁邊角色自己的一句，例如「還有 2 件作業要交」。 */
  line: ReactNode
  /** 大字與天數改用角色頁給的；沒給就從 `ctx` 算。 */
  stage?: { text: string; daysLeft: number | null }
  /** 主要動作，整個橫幅只有這一顆。 */
  cta?: { label: string; href: string }
  /** 「看完整時程」連到哪；沒給就不顯示。 */
  timelineHref?: string
  next?: HeroNext | ReactNode
  trail?: boolean
  /** @deprecated 傳了會被忽略 */
  chips?: readonly HeroChip[]
  /** @deprecated 傳了會被忽略 */
  icon?: ReactNode
  /** @deprecated 傳了會被忽略 */
  showStages?: boolean
  /** @deprecated 傳了會被忽略 */
  showProgress?: boolean
  /** @deprecated 傳了會被忽略 */
  compact?: boolean
}) {
  const eyebrow = [heroDate(ctx.today), ctx.cohort ? cohortLabel(ctx.cohort) : null].filter(Boolean).join('・')
  // 測試站撥過模擬鐘時註明（短，免得手機上換行）。
  const simulated = ctx.simulated ? `・模擬鐘 ${formatTaipeiMinute(ctx.businessNow).slice(5)}` : ''
  // 沒有屆別時只有那一句說明，`stage` 也不顯示（沒有「現在」可說）。
  const detail = ctx.cohort && ctx.position ? stageDetail(ctx, stage) : null
  // `next={n && <卡/>}` 這類寫法 n 是 0 或空字串時不畫空白卡。
  const hasNext = next != null && next !== false && next !== true && next !== 0 && next !== ''

  return (
    <section aria-label="現在階段" className="hero">
      {trail ? <HeroTrail /> : null}
      <div className={cn('grid gap-6 p-6 md:p-8', hasNext && 'md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] md:items-center')}>
        <div className="min-w-0">
          <h1 className="text-[15px] font-bold text-white/85">歡迎回來，{name}</h1>
          <p className="mt-0.5 text-[12px] font-semibold text-white/70 tabular-nums">
            {eyebrow}
            {simulated}
          </p>
          <p className="mt-5 text-[14px] font-bold">
            <span>現在</span>
            <span aria-hidden className="mx-3 inline-block h-px w-10 bg-white/70 align-middle" />
            {line ? <span className="font-semibold text-white/85">{line}</span> : null}
          </p>
          <StageSentence ctx={ctx} perspective={perspective} text={stage?.text} />
          {detail ? <p className="mt-2 text-[16px] font-semibold tabular-nums">{detail}</p> : null}
          {timelineHref || cta ? (
            <div className="mt-5 flex flex-wrap items-center gap-3">
              {timelineHref ? (
                <Link
                  href={timelineHref}
                  className="hero-pill inline-flex h-11 items-center gap-1.5 rounded-full px-5 text-[15px] font-extrabold shadow-sm transition-transform hover:-translate-y-0.5 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-white/70"
                >
                  看完整時程
                  <IconArrowRight className="size-4" aria-hidden />
                </Link>
              ) : null}
              {cta ? (
                <Link href={cta.href} className="btn-fju h-11 rounded-full px-5 text-[15px]">
                  {cta.label}
                  <IconArrowRight className="size-4" aria-hidden />
                </Link>
              ) : null}
            </div>
          ) : null}
        </div>
        {hasNext ? (
          <div className="min-w-0 rounded-2xl bg-card p-5 text-card-foreground shadow-[0_10px_30px_rgba(0,20,50,0.25)]" data-testid="hero-next">
            {isHeroNext(next) ? <NextCard next={next} perspective={perspective} /> : next}
          </div>
        ) : null}
      </div>
    </section>
  )
}
