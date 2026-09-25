import Link from 'next/link'
import type { ReactNode } from 'react'
import { IconArrowRight } from '@tabler/icons-react'
import type { ResolvedActor } from '@/application/accounts'
import type { Cohort, CohortSchedule, StagePosition } from '@/application/cohorts'
import {
  describeStagePosition,
  getBusinessClockQuery,
  getCohortStatusQuery,
  getTimelineQuery,
  stageLastDate,
  stagePositionAt,
} from '@/composition/cohorts'
import { cn } from '@/shared/cn'
import { formatTaipeiDate, formatTaipeiMinute, taipeiDateOf, type TaipeiDate } from '@/shared/time'

/**
 * 三角色首頁頂端的歡迎色塊＋「現在階段」（票 11；S02-05；外觀 2026-09-25 對齊原型 `HeroWelcome`）。
 *
 * 階段文案固定三態：尚未開始／階段 n：名稱／年度階段已結束（沒設階段時說「尚未設定階段」）。
 * 用業務鐘算：測試站把模擬鐘推開，三個角色的首頁一起變。
 * 只講時間，不講誰做完了什麼——進入期中不代表已交期中報告（產品模組 02 §4）。
 *
 * 看哪一屆：學生看自己所屬的屆別；老師與管理員看預設工作屆別（切換屆別在後面的票）。
 * 外觀是原型的深藍歡迎色塊（`.hero`）；橘色只給主要動作、「下一步」與目前這一段。
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

export async function loadStage(actor: ResolvedActor, perspective: 'student' | 'staff'): Promise<StageContext> {
  const cohortQuery = getCohortStatusQuery()
  const membership = actor.kind === 'authenticated' ? actor.cohortMemberships[0] : undefined
  const [cohort, clock] = await Promise.all([
    perspective === 'student' ? (membership ? cohortQuery.get(membership.cohortId) : Promise.resolve(null)) : cohortQuery.defaultWorking(),
    getBusinessClockQuery().state(),
  ])
  const schedule = cohort ? await getTimelineQuery().schedule(cohort.id) : null
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

/** 「現在是『階段 2：期中』。」這一句裡的階段字（e2e 用 `stage-text` 斷言）。 */
function StageSentence({ ctx, perspective }: { ctx: StageContext; perspective: 'student' | 'staff' }) {
  if (!ctx.cohort || !ctx.position) {
    return <>{perspective === 'student' ? '你還沒有歸屬的屆別；帳號核准並歸到某一屆之後，這裡會顯示現在的階段。' : '還沒有設定預設工作屆別；到「屆別」頁指定後，這裡會顯示現在的階段。'}</>
  }
  const p = ctx.position
  return (
    <>
      現在是「<span data-testid="stage-text">{describeStagePosition(p)}</span>」
      {p.kind === 'in_stage' ? `，到 ${formatTaipeiDate(p.lastDate).slice(5)}` : p.kind === 'not_started' ? `，第 1 階段 ${formatTaipeiDate(p.firstStartDate).slice(5)} 開始` : ''}。
    </>
  )
}

export type HeroChip = { label: string; value: string; href: string; hot?: boolean; testId?: string }
export type HeroNext = { title: string; due: string; href: string; label: string }

/**
 * 歡迎色塊。`compact`＝管理員版（一列、不放插圖，原型 home-admin：別讓歡迎語把待處理推下去）。
 * 學生版多一條「本屆階段」（四段，現在這段是橘色）；老師版是本屆進度條。
 */
export function HomeHero({
  ctx,
  perspective,
  name,
  line,
  cta,
  chips,
  next,
  icon,
  showStages = false,
  showProgress = false,
  compact = false,
}: {
  ctx: StageContext
  perspective: 'student' | 'staff'
  name: string
  line?: string
  cta?: { href: string; label: string }
  chips?: readonly HeroChip[]
  next?: HeroNext
  icon?: ReactNode
  showStages?: boolean
  showProgress?: boolean
  compact?: boolean
}) {
  const eyebrow = [heroDate(ctx.today), ctx.cohort?.code].filter(Boolean).join('・')
  const simulated = ctx.simulated ? `（模擬業務時間 ${formatTaipeiMinute(ctx.businessNow)}）` : ''
  const ctaLink = cta ? (
    <Link href={cta.href} className="btn-fju h-10 shrink-0 rounded-xl px-4 text-[14px]">
      {cta.label}
      <IconArrowRight className="size-4" aria-hidden />
    </Link>
  ) : null

  if (compact) {
    return (
      <section aria-label="現在階段" className="hero flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-6 py-5">
        <div className="min-w-0">
          <p className="text-[12px] font-semibold text-white/75 tabular-nums">
            {eyebrow}
            {simulated}
          </p>
          <h1 className="mt-1 text-[22px] leading-tight font-extrabold tracking-tight">歡迎回來，{name}</h1>
          <p className="mt-0.5 text-[13px] text-white/85">
            <StageSentence ctx={ctx} perspective={perspective} />
            {line}
          </p>
        </div>
        {ctaLink}
      </section>
    )
  }

  const progress = showProgress ? cohortProgress(ctx) : null
  const schedule = ctx.schedule
  const currentSeq = ctx.position?.kind === 'in_stage' ? ctx.position.seq : null

  return (
    <section aria-label="現在階段" className="hero flex min-h-[220px] items-stretch">
      <div className="flex min-w-0 flex-1 flex-col justify-between gap-5 p-6 md:p-7">
        <div>
          <p className="text-[13px] font-semibold text-white/75 tabular-nums">
            {eyebrow}
            {simulated}
          </p>
          <h1 className="mt-2 text-[28px] leading-tight font-extrabold tracking-tight md:text-[32px]">歡迎回來，{name}</h1>
          <p className="mt-2 max-w-[46ch] text-[15px] text-white/85">
            <StageSentence ctx={ctx} perspective={perspective} />
            {line}
          </p>
        </div>

        {next ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl bg-white/10 px-4 py-3" data-testid="hero-next">
            <div className="min-w-0 flex-1 basis-[14rem]">
              <p className="text-[11px] font-bold tracking-[0.06em] text-primary">下一步</p>
              <p className="truncate text-[15px] font-bold">{next.title}</p>
              <p className="text-[13px] text-white/80 tabular-nums">{next.due}</p>
            </div>
            <Link href={next.href} className="btn-fju h-11 rounded-lg px-5 text-[14px] max-sm:w-full">
              {next.label}
              <IconArrowRight className="size-4" aria-hidden />
            </Link>
          </div>
        ) : null}

        {showStages && schedule?.yearEndDate && schedule.stages.length > 0 ? (
          <div>
            <p className="mb-1.5 text-[12px] font-semibold text-white/80">{ctx.cohort?.code} 本屆階段</p>
            <ol aria-label="本屆階段" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {schedule.stages.map((stage, index) => (
                <li
                  key={stage.seq}
                  aria-current={stage.seq === currentSeq ? 'step' : undefined}
                  className={cn(
                    'rounded-xl px-3 py-2 text-[13px] leading-snug',
                    stage.seq === currentSeq ? 'bg-primary text-primary-foreground' : 'bg-white/10 text-white/90',
                  )}
                >
                  <p className="font-semibold">
                    {stage.seq}. {stage.name}
                  </p>
                  <p className="text-[11px] tabular-nums opacity-80">
                    {formatTaipeiDate(stage.startDate).slice(5)} – {formatTaipeiDate(stageLastDate(schedule.stages, schedule.yearEndDate!, index)).slice(5)}
                  </p>
                </li>
              ))}
            </ol>
          </div>
        ) : null}

        {progress !== null || cta ? (
          <div className="flex flex-wrap items-center gap-4">
            {progress !== null ? (
              <div className="min-w-[220px] flex-1">
                <div className="mb-1.5 flex items-baseline justify-between text-[12px] font-semibold text-white/80">
                  <span>{ctx.cohort?.code} 本屆進度</span>
                  <span className="text-[15px] font-extrabold text-white tabular-nums">{progress}%</span>
                </div>
                {/* 進度條用 SVG 屬性畫寬度：正式站 CSP 不收 style 屬性。 */}
                <svg className="block h-2.5 w-full" role="img" aria-label={`本屆進度 ${progress}%`}>
                  <rect width="100%" height="100%" rx="5" fill="rgb(255 255 255 / 0.18)" />
                  <rect width={`${Math.max(progress, 2)}%`} height="100%" rx="5" fill="var(--primary)" />
                </svg>
              </div>
            ) : null}
            {ctaLink}
          </div>
        ) : null}

        {chips?.length ? (
          <div className="flex flex-wrap gap-2">
            {chips.map((c) => (
              <Link
                key={c.label}
                href={c.href}
                className={cn(
                  'inline-flex h-9 items-center gap-2 rounded-xl px-3 text-[13px] transition-colors',
                  c.hot ? 'bg-primary text-primary-foreground hover:bg-[oklch(0.7_0.16_55)]' : 'bg-white/12 text-white/90 hover:bg-white/20',
                )}
              >
                <span className="font-medium">{c.label}</span>
                <span className="font-extrabold tabular-nums" data-testid={c.testId}>
                  {c.value}
                </span>
              </Link>
            ))}
          </div>
        ) : null}
      </div>
      {icon ? (
        <div className="hidden w-[260px] shrink-0 items-center justify-center pr-6 md:flex" aria-hidden>
          <span className="spot size-[150px] [&_svg]:size-16">{icon}</span>
        </div>
      ) : null}
    </section>
  )
}
