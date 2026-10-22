import type { Metadata } from 'next'
import type { Activity, CohortSchedule } from '@/application/cohorts'
import { requireSignedIn } from '@/app/_ui/guard'
import { PublicPage } from '@/app/_ui/public-content'
import { SiteShell } from '@/app/_ui/site-shell'
import { itemTodo, studentItems } from '@/app/dashboard/student/_todo/todos'
import { ActivityList } from '@/app/timeline/activity-list'
import {
  ganttActivity,
  ganttDeadlines,
  staffDeadlines,
  timelineEntries,
  visibleActivities,
  type DeadlineSource,
} from '@/app/timeline/activity-visibility'
import { GanttView } from '@/app/timeline/gantt-view'
import { StageRail } from '@/app/timeline/stage-rail'
import { actorHasRole } from '@/composition/accounts'
import {
  ACTIVITY_AUDIENCE_LABEL,
  formatActivityWhen,
  getBusinessClock,
  getCohortStatusQuery,
  getTimelineQuery,
  timelineView,
} from '@/composition/cohorts'
import { getItemQuery } from '@/composition/items'
import { taipeiDateOf } from '@/shared/time'

export const metadata: Metadata = {
  title: '專題時程｜資管系專題平台',
  robots: { index: false },
  alternates: { canonical: '/timeline' },
}

const PATH = '/timeline'

const ENTRY_FORMAT = { when: formatActivityWhen, audience: (kind: Activity['audienceKind']) => ACTIVITY_AUDIENCE_LABEL[kind] }

type Loaded = {
  cohortId: string | null
  cohortName: string | null
  schedule: CohortSchedule | null
  activities: readonly Activity[]
  deadlines: readonly DeadlineSource[]
  now: Date
  perspective: 'student' | 'staff'
}

/**
 * 前台「專題時程」（學生規格 §3.7，ST-6；規格③ §9.5）：階段卡 → 唯讀甘特（電腦版）→ 活動清單。
 *
 * 要登入（SHW-02），訪客導登入頁。手機（< 768px）不載甘特，只有階段卡與依月份分組的清單（`GanttView`）。
 * 看的人不同，看到的不同（Q47）：
 * - 學生：**自己所屬那一屆**（`studentSchedule`，屆別由登入者推，網址帶不進來）的階段、學生看得到的活動
 *   （不含「只給老師」）、自己的作業截止（ST-1 的 `studentItems`＋`itemTodo`，補交期限優先）。
 * - 老師／系辦：後台預設查看的屆別（`defaultWorking`）的階段、全部活動，與該屆已發布作業的「學生截止」
 *   （Q125 B 案、B15；`ItemQuery.list`，連到老師／系辦的公告與作業列表）。
 * - 其他登入者（沒有這三種角色）：不給任何屆別資料。
 */
export default async function TimelinePage() {
  const actor = await requireSignedIn(PATH)
  const data = await load(actor)
  const view = data.schedule ? timelineView(data.schedule, data.now) : null
  const today = taipeiDateOf(data.now)
  const deadlineVersions = new Map(data.schedule?.stages.map((s) => [s.seq, s.deadlineVersion]))

  return (
    <SiteShell current={PATH} bare>
      <PublicPage title="專題時程" description={data.cohortName ?? undefined} crumbs={[{ label: '專題時程' }]}>
        <div className="flex flex-col gap-8">
          {view ? <StageRail view={view} /> : <p className="text-sm text-muted-foreground">本屆時程還沒設定</p>}
          {view && data.cohortId ? (
            <GanttView
              cohortId={data.cohortId}
              stages={view.stages.map((s) => ({
                seq: s.seq,
                name: s.name,
                startDate: s.startDate,
                lastDate: s.lastDate,
                deadlineVersion: deadlineVersions.get(s.seq) ?? 1,
              }))}
              yearEndDate={data.schedule?.yearEndDate ?? null}
              activities={visibleActivities(data.activities, data.perspective).map(ganttActivity)}
              deadlines={ganttDeadlines(data.deadlines)}
              today={today}
            />
          ) : null}
          <ActivityList entries={timelineEntries(data.activities, data.deadlines, data.perspective, ENTRY_FORMAT)} />
        </div>
      </PublicPage>
    </SiteShell>
  )
}

async function load(actor: Awaited<ReturnType<typeof requireSignedIn>>): Promise<Loaded> {
  const timeline = getTimelineQuery()
  if (actor.kind === 'authenticated' && actorHasRole(actor, 'student')) {
    const [mine, [rows, now]] = await Promise.all([timeline.studentSchedule(actor), studentItems(actor.userId)])
    const activities = mine ? await timeline.activities(mine.cohortId) : []
    return {
      cohortId: mine?.cohortId ?? null,
      cohortName: mine?.cohortName ?? null,
      schedule: mine?.schedule ?? null,
      activities,
      deadlines: rows.map((row) => itemTodo(row, now)),
      now,
      perspective: 'student',
    }
  }
  if (actorHasRole(actor, 'teacher') || actorHasRole(actor, 'admin')) {
    const [cohort, now] = await Promise.all([getCohortStatusQuery().defaultWorking(), getBusinessClock().now()])
    if (!cohort) return { cohortId: null, cohortName: null, schedule: null, activities: [], deadlines: [], now, perspective: 'staff' }
    const [schedule, activities, items] = await Promise.all([
      timeline.schedule(cohort.id),
      timeline.activities(cohort.id),
      getItemQuery().list(cohort.id),
    ])
    const href = actorHasRole(actor, 'admin') ? `/dashboard/admin/affairs?cohort=${cohort.id}&placement=all` : '/dashboard/teacher/affairs'
    return { cohortId: cohort.id, cohortName: cohort.name, schedule, activities, deadlines: staffDeadlines(items, href), now, perspective: 'staff' }
  }
  return { cohortId: null, cohortName: null, schedule: null, activities: [], deadlines: [], now: await getBusinessClock().now(), perspective: 'staff' }
}
