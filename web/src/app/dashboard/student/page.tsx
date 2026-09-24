import { requireRole } from '@/app/_ui/guard'
import { StageBanner } from '@/app/dashboard/_stage'
import { DashboardShell } from '@/app/_ui/site-shell'
import { PageHeader, Tile } from '@/app/_ui/primitives'
import { STUDENT_NAV } from '@/app/dashboard/_nav'
import { StudentCalendar } from '@/app/dashboard/student/_calendar'
import { calendarEntries, upcoming } from '@/app/dashboard/student/calendar-entries'
import { getBusinessClock, getTimelineQuery } from '@/composition/cohorts'
import { getPublicItemQuery } from '@/composition/items'
import { getSubmissionQuery, pendingCount } from '@/composition/submissions'
import { formatTaipeiDate, taipeiDateOf } from '@/shared/time'

export const metadata = { title: '學生首頁｜資管系專題平台' }

export default async function StudentHomePage() {
  // 授權檢查在**頁面自己**：放在 layout 擋不住，App Router 會把 layout 與 page 並行渲染，
  // layout 丟掉 children 或 redirect 都來不及——那一頁已經被做出來、跟著 payload 送走了。
  const actor = await requireRole('/dashboard/student', 'student')

  // 行事曆（票 16）：屆別活動（票 11）＋收件截止（票 15），都是現有資料組出來的，不另外存。
  // 看哪一屆跟頂端的階段一樣：自己所屬的屆別。「今天」用業務鐘（測試站撥模擬鐘，月曆跟著走）。
  const cohortId =
    actor.kind === 'authenticated'
      ? (actor.cohortMemberships.find((m) => m.role === 'student') ?? actor.cohortMemberships[0])?.cohortId
      : undefined
  // 待繳交（票 18）：跟作業區「待繳」、管理員名單頁「未繳」同一份查詢（`myItems`）、同一個狀態函式。
  const userId = actor.kind === 'authenticated' ? actor.userId : ''
  const [activities, deadlines, myItems, now] = await Promise.all([
    cohortId ? getTimelineQuery().activities(cohortId) : Promise.resolve([]),
    getPublicItemQuery().myDeadlines(actor),
    getSubmissionQuery().myItems(userId),
    getBusinessClock().now(),
  ])
  const today = taipeiDateOf(now)
  const entries = calendarEntries(activities, deadlines)
  const next = upcoming(entries, today)
  const pending = pendingCount(myItems, now)

  return (
    <DashboardShell roleLabel="學生" items={STUDENT_NAV} current="/dashboard/student">
      <PageHeader title="我的專題" description="組別、要交的東西與截止日都會出現在這裡。" />
      <StageBanner actor={actor} perspective="student" showStages />
      <div className="grid gap-4 sm:grid-cols-2">
        <Tile label="我的組別" value="—" hint="分組功能開放後會顯示" />
        <Tile
          label="待繳交"
          value={<span data-testid="home-pending">{pending} 件</span>}
          hint="還在開放、還沒正式送出的收件；點進作業區看每一份"
          href="/dashboard/student/affairs?tab=open"
        />
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <section aria-labelledby="calendar-title" className="rounded-card border border-border bg-background">
          <h2 id="calendar-title" className="px-4 pt-4 text-base font-semibold text-ink">
            專題行事曆
          </h2>
          <StudentCalendar entries={entries} today={today} />
        </section>
        <section aria-labelledby="upcoming-title" className="rounded-card border border-border bg-background p-4">
          <h2 id="upcoming-title" className="text-base font-semibold text-ink">
            接下來
          </h2>
          {next.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">最近沒有收件截止或活動。系辦排上活動、發布收件後會出現在這裡。</p>
          ) : (
            <ul className="mt-2 divide-y divide-border" data-testid="upcoming">
              {next.map((e) => (
                <li key={e.id} className="flex items-center gap-3 py-2 text-sm">
                  <span className="w-20 shrink-0 font-semibold text-ink tabular-nums">{formatTaipeiDate(e.date).slice(5)}</span>
                  <span
                    className={
                      e.kind === 'deadline'
                        ? 'shrink-0 rounded bg-primary-subtle px-1.5 py-0.5 text-[10px] font-bold text-primary-on-subtle'
                        : 'shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-bold text-ink'
                    }
                  >
                    {e.kind === 'deadline' ? '截止' : '活動'}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-medium text-ink">{e.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{e.time}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </DashboardShell>
  )
}
