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
      <section aria-label="現在階段" className="mb-6 rounded-card border border-border bg-background px-5 py-4">
        <p className="text-xs text-muted-foreground tabular-nums">{today}</p>
        <p className="mt-1 text-base font-medium text-ink">
          {isStudent ? '你還沒有歸屬的屆別' : '還沒有設定預設工作屆別'}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {isStudent ? '帳號核准並歸到某一屆之後，這裡會顯示那一屆現在在哪個階段。' : '系辦在屆別頁指定預設工作屆別後，這裡會顯示它現在在哪個階段。'}
        </p>
      </section>
    )
  }

  const schedule = await getTimelineQuery().schedule(cohort.id)
  const position = stagePositionAt(schedule, clock.businessNow)
  const currentSeq = position.kind === 'in_stage' ? position.seq : null

  return (
    <section aria-label="現在階段" className="mb-6 rounded-card border border-border bg-background px-5 py-4">
      <p className="text-xs text-muted-foreground tabular-nums">
        {cohort.code}・{today}
      </p>
      <p className="mt-1 text-xl font-semibold text-ink" data-testid="stage-text">
        {describeStagePosition(position)}
      </p>
      {position.kind === 'in_stage' ? (
        <p className="mt-0.5 text-sm text-muted-foreground tabular-nums">這個階段到 {formatTaipeiDate(position.lastDate)}</p>
      ) : position.kind === 'not_started' ? (
        <p className="mt-0.5 text-sm text-muted-foreground tabular-nums">第 1 階段從 {formatTaipeiDate(position.firstStartDate)} 開始</p>
      ) : null}

      {showStages && schedule.yearEndDate && schedule.stages.length > 0 ? (
        <ol aria-label="本屆階段" className="mt-3 grid gap-2 sm:grid-cols-4">
          {schedule.stages.map((stage, index) => (
            <li
              key={stage.seq}
              aria-current={stage.seq === currentSeq ? 'step' : undefined}
              className={cn(
                'rounded-md border px-3 py-2 text-sm',
                stage.seq === currentSeq ? 'border-primary bg-primary-subtle text-primary-on-subtle' : 'border-border text-ink',
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
