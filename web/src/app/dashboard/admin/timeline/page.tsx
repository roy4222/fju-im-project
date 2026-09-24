import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { Card, EmptyState, PageHeader } from '@/app/_ui/primitives'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import {
  ActivityActions,
  CreateActivityForm,
  ScheduleEditor,
  type AudienceOption,
} from '@/app/dashboard/admin/timeline/timeline-forms'
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
  STAGE_NAME_MAX_LENGTH,
  stageLastDate,
  stagePositionAt,
} from '@/composition/cohorts'
import { cn } from '@/shared/cn'
import { formatTaipeiDate, formatTaipeiSecond } from '@/shared/time'

export const metadata = { title: '時間軸｜資管系專題平台' }

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

  const shell = (children: React.ReactNode) => (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current="/dashboard/admin/timeline">
      <PageHeader title="時間軸" description="屆別的四個階段與獨立活動。學生、老師首頁的「現在階段」都照這份設定。" />
      {children}
    </DashboardShell>
  )

  if (!cohort) {
    return shell(
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
  const position = stagePositionAt(schedule, clock.businessNow)
  const currentSeq = position.kind === 'in_stage' ? position.seq : null

  const stageDrafts = Array.from({ length: STAGE_COUNT }, (_, i) => {
    const stage = schedule.stages.find((s) => s.seq === i + 1)
    return { name: stage?.name ?? '', startDate: stage?.startDate ?? '' }
  })
  const audiences: AudienceOption[] = ACTIVITY_AUDIENCES.map((value) => ({ value, label: ACTIVITY_AUDIENCE_LABEL[value] }))
  const limits = {
    audiences,
    titleMaxLength: ACTIVITY_TITLE_MAX_LENGTH,
    descriptionMaxLength: ACTIVITY_DESCRIPTION_MAX_LENGTH,
  }
  const scheduled = activities.filter((a) => a.status === 'scheduled')
  const cancelled = activities.filter((a) => a.status === 'cancelled')

  return shell(
    <>
      {cohorts.length > 1 ? (
        <nav aria-label="選擇屆別" className="mb-4 flex flex-wrap gap-2">
          {cohorts.map((c) => (
            <Link
              key={c.id}
              href={`/dashboard/admin/timeline?cohort=${c.id}`}
              aria-current={c.id === cohort.id ? 'page' : undefined}
              className={cn(
                'rounded-full border px-3 py-1 text-sm',
                c.id === cohort.id ? 'border-primary bg-primary-subtle text-primary-on-subtle' : 'border-border text-ink hover:bg-muted',
              )}
            >
              {c.code}
            </Link>
          ))}
        </nav>
      ) : null}

      <section
        aria-label="目前階段"
        className="mb-6 flex flex-wrap items-center justify-between gap-4 rounded-card border border-border bg-background px-5 py-4"
      >
        <div>
          <p className="text-xs font-semibold text-primary">
            {cohort.code}・{COHORT_STATUS_LABEL[cohort.status]}
          </p>
          <p className="mt-0.5 text-xl font-semibold text-ink">{describeStagePosition(position)}</p>
          <p className="mt-0.5 text-sm text-muted-foreground tabular-nums">
            業務時間 {formatTaipeiSecond(clock.businessNow)}
            {clock.latest ? '（模擬中）' : ''}
            {schedule.yearEndDate ? `・年度結束日 ${formatTaipeiDate(schedule.yearEndDate)}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {businessClockOverrideEnabled() ? (
            <Link href="/dashboard/admin/clock" className="text-sm font-medium text-primary hover:underline">
              調整模擬業務鐘
            </Link>
          ) : null}
          <ScheduleEditor
            cohortId={cohort.id}
            cohortCode={cohort.code}
            revision={cohort.revision}
            requestId={randomUUID()}
            stages={stageDrafts}
            yearEndDate={schedule.yearEndDate ?? ''}
            nameMaxLength={STAGE_NAME_MAX_LENGTH}
          />
        </div>
      </section>

      {schedule.stages.length === 0 || !schedule.yearEndDate ? (
        <div className="mb-8">
          <EmptyState
            title="這一屆還沒設定階段"
            description={`按「編輯階段與日期」填 ${STAGE_COUNT} 個階段的名稱與開始日，以及年度結束日。設好之後才能在屆別頁轉為進行中。`}
          />
        </div>
      ) : (
        <ol aria-label="階段" className="mb-8 space-y-3 border-l-2 border-border pl-5">
          {schedule.stages.map((stage, index) => {
            const isCurrent = stage.seq === currentSeq
            const isPast =
              position.kind === 'ended' || (currentSeq !== null && stage.seq < currentSeq)
            const status = isCurrent ? '現在' : isPast ? '已過' : '尚未開始'
            return (
              <li
                key={stage.seq}
                className={cn(
                  'relative rounded-card border bg-background px-4 py-3',
                  isCurrent ? 'border-primary' : 'border-border',
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    'absolute top-4 -left-[1.6rem] size-3 rounded-full border-2',
                    isCurrent ? 'border-primary bg-primary' : isPast ? 'border-ink bg-ink' : 'border-border bg-background',
                  )}
                />
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-semibold text-ink">
                    第 {stage.seq} 階段：{stage.name}
                  </p>
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-xs font-medium',
                      isCurrent ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
                    )}
                  >
                    {status}
                  </span>
                </div>
                <p className="mt-0.5 text-sm text-muted-foreground tabular-nums">
                  {formatTaipeiDate(stage.startDate)} – {formatTaipeiDate(stageLastDate(schedule.stages, schedule.yearEndDate!, index))}
                </p>
              </li>
            )
          })}
        </ol>
      )}

      <Card title="獨立活動" description="說明會、成果發表這類活動。作業截止會從收件項目自動帶進日曆，不用在這裡加。" className="mb-6">
        <CreateActivityForm cohortId={cohort.id} requestId={randomUUID()} {...limits} />
      </Card>

      <section aria-label="已排定的活動" className="mb-6 space-y-3">
        <h2 className="text-base font-semibold text-ink">已排定的活動</h2>
        {scheduled.length === 0 ? (
          <p className="text-sm text-muted-foreground">還沒有活動。</p>
        ) : (
          <ul className="space-y-3">
            {scheduled.map((activity) => (
              <li
                key={activity.id}
                className="flex flex-wrap items-start justify-between gap-3 rounded-card border border-border bg-background px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="font-medium text-ink">{activity.title}</p>
                  <p className="text-sm text-muted-foreground tabular-nums">
                    {formatActivityWhen(activity)}・{ACTIVITY_AUDIENCE_LABEL[activity.audienceKind]}
                  </p>
                  {activity.description ? <p className="mt-1 text-sm text-ink">{activity.description}</p> : null}
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
      </section>

      {cancelled.length > 0 ? (
        <section aria-label="已取消的活動" className="space-y-2">
          <h2 className="text-base font-semibold text-ink">已取消</h2>
          <ul className="space-y-2">
            {cancelled.map((activity) => (
              <li key={activity.id} className="rounded-card border border-dashed border-border px-4 py-2 text-sm text-muted-foreground">
                <span className="mr-2 rounded-full bg-muted px-2 py-0.5 text-xs font-medium">已取消</span>
                <span className="line-through">{activity.title}</span>・{formatActivityWhen(activity)}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>,
  )
}
