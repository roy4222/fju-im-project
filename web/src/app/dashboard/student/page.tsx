import Link from 'next/link'
import { IconChevronRight, IconSchool } from '@tabler/icons-react'
import { requireRole } from '@/app/_ui/guard'
import { daysBetween, HomeHero, loadStage, type HeroChip, type HeroNext } from '@/app/dashboard/_stage'
import { Panel, PanelEmpty } from '@/app/dashboard/_home'
import { DashboardShell } from '@/app/_ui/site-shell'
import { STUDENT_NAV } from '@/app/dashboard/_nav'
import { StudentCalendar, type CalendarEntry } from '@/app/dashboard/student/_calendar'
import { calendarEntries, upcoming } from '@/app/dashboard/student/calendar-entries'
import { getTimelineQuery } from '@/composition/cohorts'
import { getGroupQuery } from '@/composition/groups'
import { getPublicItemQuery } from '@/composition/items'
import { getSignoffQuery } from '@/composition/signoff'
import { getSubmissionQuery, pendingCount, receiverStatus } from '@/composition/submissions'
import { cn } from '@/shared/cn'
import { formatTaipeiDate, taipeiDateOf } from '@/shared/time'

export const metadata = { title: '學生首頁｜資管系專題平台' }

const BASE = '/dashboard/student'

/**
 * 學生首頁（2026-09-25 外觀對齊原型 `home-student`，區塊與順序照原型；Roy 2026-09-10：四塊壓一屏）：
 * 左欄歡迎色塊（現在階段、下一步、本屆階段、作業／組別／同意書三格）＋公告；右欄專題行事曆＋接下來。
 *
 * 讀取全部是既有、只讀本人的查詢：作業區的 `myItems`、本人可見的截止與屆別活動、本人的組別、
 * 本人組別的簽核版本、本人看得到的公告（依角色與屆別過濾）。
 */
export default async function StudentHomePage() {
  // 授權檢查在**頁面自己**：放在 layout 擋不住，App Router 會把 layout 與 page 並行渲染，
  // layout 丟掉 children 或 redirect 都來不及——那一頁已經被做出來、跟著 payload 送走了。
  const actor = await requireRole(BASE, 'student')
  const ctx = await loadStage(actor, 'student')

  // 行事曆（票 16）：屆別活動（票 11）＋收件截止（票 15），都是現有資料組出來的，不另外存。
  // 看哪一屆跟頂端的階段一樣：自己所屬的屆別。「今天」用業務鐘（測試站撥模擬鐘，月曆跟著走）。
  const cohortId = ctx.cohort?.id
  // 待繳交（票 18）：跟作業區「待繳」、管理員名單頁「未繳」同一份查詢（`myItems`）、同一個狀態函式。
  const userId = actor.kind === 'authenticated' ? actor.userId : ''
  const [activities, deadlines, myItems, groupView, signoff, news] = await Promise.all([
    cohortId ? getTimelineQuery().activities(cohortId) : Promise.resolve([]),
    getPublicItemQuery().myDeadlines(actor),
    getSubmissionQuery().myItems(userId),
    cohortId ? getGroupQuery().studentView(userId, cohortId) : Promise.resolve(null),
    getSignoffQuery().studentView(actor),
    getPublicItemQuery().list(actor, 'news', { limit: 5 }),
  ])
  const today = ctx.today
  const entries = calendarEntries(activities, deadlines)
  const next8 = upcoming(entries, today, 8)
  const pending = pendingCount(myItems, ctx.businessNow)

  // 下一步＝還沒送出、最早截止的那一份（原型 Codex S-05）。
  const nextItem = myItems
    .filter((i) => i.dueAt && receiverStatus(i, i, ctx.businessNow).pending)
    .sort((a, b) => a.dueAt!.getTime() - b.dueAt!.getTime())[0]
  const next: HeroNext | undefined = nextItem?.dueAt
    ? (() => {
        const due = taipeiDateOf(nextItem.dueAt)
        const d = daysBetween(today, due)
        return {
          title: nextItem.title,
          due: `${formatTaipeiDate(due).slice(5)} 截止・${d === 0 ? '今天' : `剩 ${d} 天`}`,
          href: `${BASE}/affairs/${nextItem.itemId}`,
          label: nextItem.hasDraft ? '繼續填寫' : '去繳交',
        }
      })()
    : undefined

  // 組員確認：已成組看組別；提案中看全員確認進度；都沒有就是還沒分組。
  const group = groupView?.group ?? null
  const proposal = groupView?.openProposal ?? null
  const groupChip: HeroChip = group
    ? { label: '我的組別', value: `${group.code}・${group.members.length} 人`, href: `${BASE}/groups` }
    : proposal
      ? {
          label: '組員確認',
          value: `${proposal.invitations.filter((i) => i.state === 'confirmed').length}/${proposal.invitations.length}`,
          href: `${BASE}/groups`,
          hot: true,
        }
      : { label: '我的組別', value: '還沒分組', href: `${BASE}/groups` }
  const collecting = signoff.versions.filter((v) => v.isCurrent && v.state === 'collecting').length

  const name = actor.kind === 'authenticated' && actor.displayName ? actor.displayName : '同學'
  const line = pending ? `作業區還有 ${pending} 件沒送出。` : '作業區沒有待繳的東西。'

  return (
    <DashboardShell roleLabel="學生" items={STUDENT_NAV} current={BASE}>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-5">
          <HomeHero
            ctx={ctx}
            perspective="student"
            name={name}
            line={line}
            next={next}
            showStages
            icon={<IconSchool strokeWidth={1.4} />}
            chips={[
              { label: '作業待繳', value: `${pending} 件`, href: `${BASE}/affairs?tab=open`, hot: pending > 0, testId: 'home-pending' },
              groupChip,
              { label: '同意書', value: collecting ? `${collecting} 份進行中` : `${signoff.versions.filter((v) => v.isCurrent).length} 份`, href: `${BASE}/signoff` },
            ]}
          />

          <Panel title="公告" action={{ href: '/news', label: '全部' }} className="min-h-0 flex-1">
            {news.length === 0 ? (
              <PanelEmpty>目前沒有公告。</PanelEmpty>
            ) : (
              <ul className="px-2 pb-2">
                {news.map((n) => {
                  const date = taipeiDateOf(n.publishedAt)
                  return (
                    <li key={n.id}>
                      <Link href={`/news/${n.id}`} className="flex items-center gap-4 rounded-xl px-3 py-2.5 transition-colors hover:bg-accent/60">
                        <span className="flex w-11 shrink-0 flex-col items-center rounded-xl bg-muted py-1.5 leading-none tabular-nums">
                          <span className="text-[10px] font-semibold text-muted-foreground">{Number(date.slice(5, 7))} 月</span>
                          <span className="mt-0.5 text-[17px] font-extrabold text-foreground">{Number(date.slice(8, 10))}</span>
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold text-foreground">{n.title}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {n.category ?? '公告'}
                          </span>
                        </span>
                        <IconChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      </Link>
                    </li>
                  )
                })}
              </ul>
            )}
          </Panel>
        </div>

        <div className="flex min-w-0 flex-col gap-5">
          {/* 「專題行事曆」只有學生看得到：pages.spec 的直接打 HTTP 回歸測試用它當指紋。 */}
          <Panel title="專題行事曆" description="系辦設定" tint="sky" className="shrink-0">
            <StudentCalendar entries={entries} today={today} />
          </Panel>

          <Panel title="接下來" action={{ href: `${BASE}/affairs`, label: '作業區' }} className="min-h-0 flex-1">
            <UpcomingList entries={next8} today={today} />
          </Panel>
        </div>
      </div>
    </DashboardShell>
  )
}

/** 接下來（原型 UpcomingCard）：本週／之後兩段，左邊是「還有幾天」的色塊。 */
function UpcomingList({ entries, today }: { entries: readonly CalendarEntry[]; today: string }) {
  if (entries.length === 0) {
    return <PanelEmpty>最近沒有收件截止或活動。系辦排上活動、發布收件後會出現在這裡。</PanelEmpty>
  }
  const withDays = entries.map((e) => ({ ...e, days: daysBetween(today, e.date) }))
  const groups = [
    { label: '本週', items: withDays.filter((e) => e.days <= 7) },
    { label: '之後', items: withDays.filter((e) => e.days > 7) },
  ].filter((g) => g.items.length > 0)
  return (
    <div className="flex flex-col gap-1 px-3 pb-3" data-testid="upcoming">
      {groups.map((g) => (
        <div key={g.label}>
          <p className="px-2 pt-1 pb-1 text-[11px] font-bold tracking-[0.06em] text-muted-foreground">{g.label}</p>
          <ul className="flex flex-col gap-1">
            {g.items.map((e) => {
              const body = (
                <>
                  <span
                    className={cn(
                      'tint spot size-11 shrink-0 rounded-xl text-[13px] font-extrabold tabular-nums',
                      e.kind === 'deadline' ? 'tint-peach' : 'tint-sky',
                    )}
                  >
                    {e.days === 0 ? '今' : `${e.days}天`}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-bold text-foreground">{e.title}</span>
                    <span className="block truncate text-xs text-muted-foreground tabular-nums">
                      {e.kind === 'deadline' ? '截止' : '活動'}・{formatTaipeiDate(e.date).slice(5)} {e.time}
                    </span>
                  </span>
                  {e.href ? <IconChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden /> : null}
                </>
              )
              return (
                <li key={e.id}>
                  {e.href ? (
                    <Link href={e.href} className="flex items-center gap-3 rounded-xl px-2 py-2 transition-colors hover:bg-accent/60">
                      {body}
                    </Link>
                  ) : (
                    <div className="flex items-center gap-3 rounded-xl px-2 py-2">{body}</div>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </div>
  )
}
