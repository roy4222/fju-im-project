import type { Metadata } from 'next'
import type { Activity, CohortSchedule } from '@/application/cohorts'
import { requireSignedIn } from '@/app/_ui/guard'
import { PublicPage } from '@/app/_ui/public-content'
import { SiteShell } from '@/app/_ui/site-shell'
import { itemTodo, studentItems } from '@/app/dashboard/student/_todo/todos'
import { calendarEntries, type DeadlineSource } from '@/app/timeline/calendar-model'
import { FullCalendar } from '@/app/timeline/full-calendar'
import { StageRail } from '@/app/timeline/stage-rail'
import { actorHasRole } from '@/composition/accounts'
import { getBusinessClock, getCohortStatusQuery, getTimelineQuery, timelineView } from '@/composition/cohorts'
import { taipeiDateOf } from '@/shared/time'

export const metadata: Metadata = {
  title: '專題時程｜資管系專題平台',
  robots: { index: false },
  alternates: { canonical: '/timeline' },
}

const PATH = '/timeline'

type Loaded = {
  cohortName: string | null
  schedule: CohortSchedule | null
  activities: readonly Activity[]
  deadlines: readonly DeadlineSource[]
  now: Date
  perspective: 'student' | 'staff'
}

/**
 * 前台「專題時程」（學生規格 §3.7，ST-6；Q85 改、Q125）：階段軌＋整月行事曆。
 *
 * 要登入（SHW-02），訪客導登入頁；不放進前台頂部導覽（Q125），從首頁橫幅「看完整時程」進來。
 * 看的人不同，看到的不同（Q47）：
 * - 學生：**自己所屬那一屆**（`studentSchedule`，屆別由登入者推，網址帶不進來）的階段、學生看得到的活動
 *   （不含「只給老師」）、自己的作業截止（ST-1 的 `studentItems`＋`itemTodo`，補交期限優先）。
 * - 老師／系辦：後台預設查看的屆別（`defaultWorking`）的階段與全部活動；A 不列學生截止（Q125）。
 * - 其他登入者（沒有這三種角色）：不給任何屆別資料。
 */
export default async function TimelinePage() {
  const actor = await requireSignedIn(PATH)
  const data = await load(actor)
  const view = data.schedule ? timelineView(data.schedule, data.now) : null
  const entries = calendarEntries(data.activities, data.deadlines, data.perspective)

  return (
    <SiteShell current={PATH} bare>
      <PublicPage title="專題時程" description={data.cohortName ?? undefined} crumbs={[{ label: '專題時程' }]}>
        <div className="flex flex-col gap-8">
          {view ? <StageRail view={view} /> : <p className="text-sm text-muted-foreground">本屆時程還沒設定</p>}
          <FullCalendar entries={entries} today={taipeiDateOf(data.now)} perspective={data.perspective} />
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
    const [schedule, activities] = cohort ? await Promise.all([timeline.schedule(cohort.id), timeline.activities(cohort.id)]) : [null, []]
    return { cohortName: cohort?.name ?? null, schedule, activities, deadlines: [], now, perspective: 'staff' }
  }
  return { cohortName: null, schedule: null, activities: [], deadlines: [], now: await getBusinessClock().now(), perspective: 'staff' }
}
