import type { ResolvedActor } from '@/application/accounts'
import {
  describeStagePosition,
  getBusinessClockQuery,
  getCohortStatusQuery,
  getTimelineQuery,
  stageLastDate,
  stagePositionAt,
} from '@/composition/cohorts'
import { cn } from '@/shared/cn'
import { formatTaipeiDate, formatTaipeiMinute, taipeiDateOf } from '@/shared/time'

/**
 * 三角色首頁頂端的「現在階段」（票 11；S02-05）。
 *
 * 文案固定三態：尚未開始／階段 n：名稱／年度階段已結束（沒設階段時說「尚未設定階段」）。
 * 用業務鐘算：測試站把模擬鐘推開，三個角色的首頁一起變。
 * 只講時間，不講誰做完了什麼——進入期中不代表已交期中報告（產品模組 02 §4）。
 *
 * 看哪一屆：學生看自己所屬的屆別；老師與管理員看預設工作屆別（切換屆別在後面的票）。
 *
 * 外觀是原型首頁頂端的深藍歡迎色塊（`.hero`，2026-09-25 對齊）；橘色只標「現在」這一格。
 */
export async function StageBanner({
  actor,
  perspective,
  showStages = false,
}: {
  actor: ResolvedActor
  /** 學生看自己的屆別；老師與管理員（staff）看預設工作屆別。 */
  perspective: 'student' | 'staff'
  showStages?: boolean
}) {
  const cohortQuery = getCohortStatusQuery()
  const isStudent = perspective === 'student'
  const membership = actor.kind === 'authenticated' ? actor.cohortMemberships[0] : undefined
  const cohort = isStudent
    ? membership
      ? await cohortQuery.get(membership.cohortId)
      : null
    : await cohortQuery.defaultWorking()

  const clock = await getBusinessClockQuery().state()
  const today = `今天 ${formatTaipeiDate(taipeiDateOf(clock.businessNow))}${clock.latest ? `（模擬業務時間 ${formatTaipeiMinute(clock.businessNow)}）` : ''}`

  if (!cohort) {
    return (
      <section aria-label="現在階段" className="hero mb-6 px-6 py-6 md:px-8">
        <p className="text-[13px] font-semibold tabular-nums opacity-80">{today}</p>
        <p className="mt-1.5 text-[22px] leading-tight font-extrabold">
          {isStudent ? '你還沒有歸屬的屆別' : '還沒有設定預設工作屆別'}
        </p>
        <p className="mt-1.5 max-w-xl text-sm opacity-85">
          {isStudent ? '帳號核准並歸到某一屆之後，這裡會顯示那一屆現在在哪個階段。' : '系辦在屆別頁指定預設工作屆別後，這裡會顯示它現在在哪個階段。'}
        </p>
      </section>
    )
  }

  const schedule = await getTimelineQuery().schedule(cohort.id)
  const position = stagePositionAt(schedule, clock.businessNow)
  const currentSeq = position.kind === 'in_stage' ? position.seq : null

  return (
    <section aria-label="現在階段" className="hero mb-6 px-6 py-6 md:px-8">
      <p className="text-[13px] font-semibold tabular-nums opacity-80">
        {cohort.code}・{today}
      </p>
      <p className="mt-1.5 text-[26px] leading-tight font-extrabold" data-testid="stage-text">
        {describeStagePosition(position)}
      </p>
      {position.kind === 'in_stage' ? (
        <p className="mt-1.5 text-sm tabular-nums opacity-85">這個階段到 {formatTaipeiDate(position.lastDate)}</p>
      ) : position.kind === 'not_started' ? (
        <p className="mt-1.5 text-sm tabular-nums opacity-85">第 1 階段從 {formatTaipeiDate(position.firstStartDate)} 開始</p>
      ) : null}

      {showStages && schedule.yearEndDate && schedule.stages.length > 0 ? (
        <ol aria-label="本屆階段" className="mt-5 grid gap-2 sm:grid-cols-4">
          {schedule.stages.map((stage, index) => (
            <li
              key={stage.seq}
              aria-current={stage.seq === currentSeq ? 'step' : undefined}
              className={cn(
                'rounded-xl px-3.5 py-2.5 text-sm',
                stage.seq === currentSeq ? 'bg-primary text-primary-foreground' : 'bg-white/10 text-white',
              )}
            >
              <p className="font-medium">
                {stage.seq}. {stage.name}
              </p>
              <p className="text-xs tabular-nums opacity-80">
                {formatTaipeiDate(stage.startDate).slice(5)} – {formatTaipeiDate(stageLastDate(schedule.stages, schedule.yearEndDate!, index)).slice(5)}
              </p>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  )
}
