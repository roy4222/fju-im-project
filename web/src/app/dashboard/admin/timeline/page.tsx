import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import { IconCalendarEvent, IconCalendarOff, IconClock } from '@tabler/icons-react'
import { BTN_OUTLINE, PageTitle, Panel, Pill, pillClass } from '@/app/_ui/dashboard-kit'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { EmptyState } from '@/app/_ui/primitives'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { ActivityActions, CreateActivityForm, type AudienceOption } from '@/app/dashboard/admin/timeline/timeline-forms'
import type { TimelineSummary } from '@/app/dashboard/_timeline/timeline-zigzag'
import { AdminTimeline, type AdminStage } from '@/app/dashboard/admin/timeline/timeline-zigzag'
import {
  ACTIVITY_AUDIENCE_LABEL,
  ACTIVITY_AUDIENCES,
  ACTIVITY_DESCRIPTION_MAX_LENGTH,
  ACTIVITY_TITLE_MAX_LENGTH,
  activityFormValues,
  businessClockOverrideEnabled,
  COHORT_STATUS_LABEL,
  describeStagePosition,
  formatActivityWhen,
  getBusinessClockQuery,
  getCohortStatusQuery,
  getTimelineQuery,
  STAGE_COUNT,
  STAGE_DESCRIPTION_MAX_LENGTH,
  STAGE_NAME_MAX_LENGTH,
  stageLastDate,
  stagePositionAt,
} from '@/composition/cohorts'
import { cn } from '@/shared/cn'
import { formatTaipeiDate, formatTaipeiSecond, taipeiDayEndExclusive, taipeiDayStart } from '@/shared/time'

const DAY = 86_400_000

export const metadata = { title: '時間軸設定｜資管系專題平台' }

/**
 * 時間軸設定（票 11；原型 `/dashboard/admin/timeline`）。
 *
 * 一屆四個階段：只填開始日，下一段開始日就是上一段的結束；另填年度結束日（含當天）。
 * 「現在第幾階段」用業務鐘算——測試站把模擬鐘推開，這裡與三角色首頁一起變。
 * 下半頁是獨立活動（說明會、成果發表）：新增、改期、取消，取消的留在「已取消」。
 */
export default async function AdminTimelinePage({
  searchParams,
}: {
  searchParams: Promise<{ cohort?: string | string[] }>
}) {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  await requireRole('/dashboard/admin/timeline', 'admin')

  const cohorts = (await getCohortStatusQuery().list()).filter((c) => c.status !== 'archived')
  const wanted = (await searchParams).cohort
  const cohort =
    cohorts.find((c) => c.id === wanted) ?? cohorts.find((c) => c.isDefaultWorking) ?? cohorts[0] ?? null

  const shell = (description: string, children: React.ReactNode, actions?: React.ReactNode) => (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current="/dashboard/admin/timeline">
      <div className="flex flex-col gap-5">
        <PageTitle title="時間軸設定" description={description} actions={actions} />
        {children}
      </div>
    </DashboardShell>
  )

  if (!cohort) {
    return shell(
      '屆別的四個階段與獨立活動。學生、老師首頁的「現在階段」都照這份設定。',
      <EmptyState
        title="還沒有可以設定的屆別"
        description="先到屆別頁新增一屆，再回來設定它的階段與活動。"
        action={{ href: '/dashboard/admin/cohorts', label: '前往屆別' }}
      />,
    )
  }

  const clock = await getBusinessClockQuery().state()
  const [schedule, activities] = await Promise.all([
    getTimelineQuery().schedule(cohort.id),
    getTimelineQuery().activities(cohort.id),
  ])
  const now = clock.businessNow
  const position = stagePositionAt(schedule, now)
  const currentSeq = position.kind === 'in_stage' ? position.seq : null

  const stageDrafts = Array.from({ length: STAGE_COUNT }, (_, i) => {
    const stage = schedule.stages.find((s) => s.seq === i + 1)
    return { name: stage?.name ?? '', startDate: stage?.startDate ?? '', description: stage?.description ?? '' }
  })
  const audiences: AudienceOption[] = ACTIVITY_AUDIENCES.map((value) => ({ value, label: ACTIVITY_AUDIENCE_LABEL[value] }))
  const limits = {
    audiences,
    titleMaxLength: ACTIVITY_TITLE_MAX_LENGTH,
    descriptionMaxLength: ACTIVITY_DESCRIPTION_MAX_LENGTH,
  }
  const scheduled = activities.filter((a) => a.status === 'scheduled')
  const cancelled = activities.filter((a) => a.status === 'cancelled')

  // 各階段的狀態與日期（伺服器用業務鐘算好；卡片只負責畫）。
  const configured = schedule.stages.length > 0 && schedule.yearEndDate !== null
  const stages: AdminStage[] = configured
    ? schedule.stages.map((stage, index) => {
        const last = stageLastDate(schedule.stages, schedule.yearEndDate!, index)
        const isCurrent = stage.seq === currentSeq
        const isPast = position.kind === 'ended' || (currentSeq !== null && stage.seq < currentSeq)
        const start = taipeiDayStart(stage.startDate)
        const end = taipeiDayEndExclusive(last)
        const days = Math.round((end.getTime() - start.getTime()) / DAY)
        const detail = isCurrent
          ? `共 ${days} 天，剩 ${Math.max(0, Math.floor((end.getTime() - now.getTime()) / DAY))} 天`
          : isPast
            ? `共 ${days} 天，已結束`
            : `共 ${days} 天，還有 ${Math.max(0, Math.ceil((start.getTime() - now.getTime()) / DAY))} 天開始`
        return {
          seq: stage.seq,
          name: stage.name,
          description: stage.description,
          range: `${formatTaipeiDate(stage.startDate)} – ${formatTaipeiDate(last)}`,
          status: isCurrent ? 'current' : isPast ? 'done' : 'upcoming',
          detail,
        }
      })
    : []
  const current = stages.find((s) => s.status === 'current')
  const currentIndex = current ? schedule.stages.findIndex((s) => s.seq === current.seq) : -1
  let progress: string | undefined
  if (current && currentIndex >= 0) {
    const start = taipeiDayStart(schedule.stages[currentIndex]!.startDate).getTime()
    const end = taipeiDayEndExclusive(stageLastDate(schedule.stages, schedule.yearEndDate!, currentIndex)).getTime()
    const elapsed = Math.min(100, Math.max(0, Math.round(((now.getTime() - start) / (end - start)) * 100)))
    progress = `時間已過 ${elapsed}%・剩 ${Math.max(0, Math.floor((end - now.getTime()) / DAY))} 天`
  }
  const done = stages.filter((s) => s.status === 'done').length
  const summary: TimelineSummary = {
    label: `目前・${cohort.code}・${COHORT_STATUS_LABEL[cohort.status]}`,
    title: current ? current.name : describeStagePosition(position),
    rangeText: current?.range,
    progressText: progress,
  }
  const meta = `業務時間 ${formatTaipeiSecond(now)}${clock.latest ? '（模擬中）' : ''}${
    schedule.yearEndDate ? `・年度結束日 ${formatTaipeiDate(schedule.yearEndDate)}` : ''
  }`

  return shell(
    `${configured ? `${cohort.code}・${stages.length} 個階段，已過 ${done} 個` : `${cohort.code}・還沒設定階段`}・${meta}`,
    <>
      {cohorts.length > 1 ? (
        <nav aria-label="選擇屆別" className="flex flex-wrap gap-1.5">
          {cohorts.map((c) => (
            <Link
              key={c.id}
              href={`/dashboard/admin/timeline?cohort=${c.id}`}
              aria-current={c.id === cohort.id ? 'page' : undefined}
              className={pillClass(c.id === cohort.id)}
            >
              {c.code}
            </Link>
          ))}
        </nav>
      ) : null}

      <AdminTimeline
        stages={stages}
        summary={summary}
        editor={{
          cohortId: cohort.id,
          cohortCode: cohort.code,
          revision: cohort.revision,
          requestId: randomUUID(),
          stages: stageDrafts,
          yearEndDate: schedule.yearEndDate ?? '',
          nameMaxLength: STAGE_NAME_MAX_LENGTH,
          descriptionMaxLength: STAGE_DESCRIPTION_MAX_LENGTH,
        }}
        extraActions={
          businessClockOverrideEnabled() ? (
            <Link href="/dashboard/admin/clock" className={cn(BTN_OUTLINE, 'h-11 px-3.5')}>
              <IconClock aria-hidden /> 調整模擬業務鐘
            </Link>
          ) : null
        }
        empty={
          <EmptyState
            title="這一屆還沒設定階段"
            description={`按「編輯階段與日期」填 ${STAGE_COUNT} 個階段的名稱與開始日，以及年度結束日。設好之後才能在屆別頁轉為進行中。`}
          />
        }
      />

      <Panel
        title="已排定的活動"
        icon={<IconCalendarEvent />}
        description={`${scheduled.length} 個・說明會、成果發表這類獨立活動`}
        aria-label="已排定的活動"
      >
        {scheduled.length === 0 ? (
          <p className="border-t border-border px-5 py-8 text-center text-sm text-muted-foreground">還沒有活動。</p>
        ) : (
          <ul className="divide-y divide-border border-t border-border">
            {scheduled.map((activity) => (
              <li
                key={activity.id}
                className="flex flex-wrap items-start justify-between gap-3 px-5 py-3 transition-colors hover:bg-accent/40"
              >
                <div className="min-w-0">
                  <p className="text-[15px] font-bold">{activity.title}</p>
                  <p className="text-sm text-muted-foreground tabular-nums">
                    {formatActivityWhen(activity)}・{ACTIVITY_AUDIENCE_LABEL[activity.audienceKind]}
                  </p>
                  {activity.description ? <p className="mt-1 text-sm">{activity.description}</p> : null}
                </div>
                <ActivityActions
                  activityId={activity.id}
                  title={activity.title}
                  revision={activity.revision}
                  requestIds={{ update: randomUUID(), cancel: randomUUID() }}
                  values={activityFormValues(activity)}
                  {...limits}
                />
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {cancelled.length > 0 ? (
        <Panel title="已取消" icon={<IconCalendarOff />} description={`${cancelled.length} 個`} aria-label="已取消的活動">
          <ul className="divide-y divide-border border-t border-border">
            {cancelled.map((activity) => (
              <li key={activity.id} className="flex flex-wrap items-center gap-2 px-5 py-3 text-sm text-muted-foreground">
                <Pill>已取消</Pill>
                <span className="line-through">{activity.title}</span>
                <span className="tabular-nums">・{formatActivityWhen(activity)}</span>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </>,
    // 新增活動（獨立活動）：原型頁面上的動作都是開對話框；回饋留在按鈕旁邊，不混進活動清單。
    <CreateActivityForm cohortId={cohort.id} requestId={randomUUID()} {...limits} />,
  )
}
