import Link from 'next/link'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { EmptyState, PageHeader } from '@/app/_ui/primitives'
import { TEACHER_NAV } from '@/app/dashboard/_nav'
import { GradingBench } from '@/app/dashboard/teacher/grading/grading-bench'
import { GradingQueue } from '@/app/dashboard/teacher/grading/queue'
import { VersionContent } from '@/app/dashboard/_submissions/version-parts'
import { getGradingQuery } from '@/composition/grading'
import { getAdvisorSubmissionQuery } from '@/composition/submissions'
import { cn } from '@/shared/cn'
import { formatTaipeiMinute, formatTaipeiSecond } from '@/shared/time'

export const metadata = { title: '評閱桌｜資管系專題平台' }

/**
 * 老師的評閱桌（票 23；原型 `/dashboard/teacher/grading/[groupId]`）：左邊是本人的評分佇列，右邊是這一組的評分表。
 *
 * 只給**本人在這一組的有效指派**：沒有被指派（或指派已結束）就只顯示「你沒有被指派評這一組」，
 * 不透露這一組的任何評分資料。同一組被指派多個階段時，用上方的階段切換。
 *
 * 票 24：
 * - 被系辦退回、還沒重新送出：上方顯示退回理由與時間，退回前的分數預填回表單，改完再正式送出。
 * - 「本組正式繳交」（S10-03）：評分要看作品——本組有效評分指派的老師讀得到這一組每一份整組收件的正式版本與附件
 *   （和組員、主指導同一段查詢、同一個授權；附件每次下載都重新授權）。草稿、個人回答不給。
 */
export default async function TeacherGradingGroupPage({
  params,
  searchParams,
}: {
  params: Promise<{ groupId: string }>
  searchParams: Promise<{ stage?: string | string[]; item?: string | string[]; version?: string | string[] }>
}) {
  const { groupId } = await params
  const actor = await requireRole(`/dashboard/teacher/grading/${groupId}`, 'teacher')
  const [bench, queue] = await Promise.all([getGradingQuery().teacherBench(actor, groupId), getGradingQuery().teacherQueue(actor)])

  const shell = (children: React.ReactNode) => (
    <DashboardShell roleLabel="老師" items={TEACHER_NAV} current="/dashboard/teacher/grading">
      <PageHeader title="評分工作台" description="只有你被指派的組別。暫存只有你和系辦看得到，正式送出後鎖定。" />
      {children}
    </DashboardShell>
  )

  if (!bench.ok) {
    return shell(
      <EmptyState
        title="你沒有被指派評這一組"
        description={bench.message}
        action={{ href: '/dashboard/teacher/grading', label: '回評分工作台' }}
      />,
    )
  }

  const { entries, groupCode, cohortCode, memberNames, versionNo } = bench.receipt
  const search = await searchParams
  const wanted = search.stage
  const entry = entries.find((e) => e.stage.key === wanted) ?? entries[0]!
  const submissions = getAdvisorSubmissionQuery()
  const versions = (await submissions.groupVersions(actor, groupId)) ?? []
  const latestByItem = versions.filter((v, i) => versions.findIndex((x) => x.itemId === v.itemId) === i)
  const itemParam = typeof search.item === 'string' ? search.item : null
  const versionParam = typeof search.version === 'string' ? Number(search.version) : null
  const opened =
    itemParam && versionParam && versions.some((v) => v.itemId === itemParam && v.versionNo === versionParam)
      ? await submissions.receiverVersion(actor, itemParam, groupId, versionParam)
      : null
  const benchHref = `/dashboard/teacher/grading/${groupId}?stage=${entry.stage.key}`

  return shell(
    <div className="grid items-start gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
      <aside className="hidden lg:block">
        <GradingQueue entries={queue} currentGroupId={groupId} />
      </aside>
      <div className="space-y-3">
        <Link href="/dashboard/teacher/grading" className="text-sm font-medium text-primary underline-offset-2 hover:underline lg:hidden">
          ← 全部評分指派
        </Link>
        <div>
          <p className="text-xs font-semibold text-muted-foreground tabular-nums">
            {cohortCode}・評分方案 v{versionNo}
          </p>
          <h2 className="text-lg font-semibold text-primary">{groupCode}</h2>
          <p className="text-xs text-muted-foreground">{memberNames.join('、')}</p>
        </div>
        {entries.length > 1 ? (
          <nav aria-label="選擇階段" className="flex flex-wrap gap-2">
            {entries.map((e) => (
              <Link
                key={e.assignmentId}
                href={`/dashboard/teacher/grading/${groupId}?stage=${e.stage.key}`}
                aria-current={e.assignmentId === entry.assignmentId ? 'page' : undefined}
                className={cn(
                  'rounded-full border px-3 py-1 text-sm',
                  e.assignmentId === entry.assignmentId
                    ? 'border-primary bg-primary-subtle text-primary-on-subtle'
                    : 'border-border text-ink hover:bg-muted',
                )}
              >
                {e.stage.name}
              </Link>
            ))}
          </nav>
        ) : null}
        {entry.returned ? (
          <p role="status" data-testid="returned-notice" className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-on-subtle">
            系辦在 {formatTaipeiMinute(entry.returned.returnedAt)} 退回了這一份評分：{entry.returned.reason}
            。退回前的分數已經填回表單，修改後請重新正式送出。
          </p>
        ) : null}
        <GradingBench
          key={entry.assignmentId}
          assignmentId={entry.assignmentId}
          groupCode={groupCode}
          stage={entry.stage}
          initialScores={entry.scores}
          locked={entry.state === 'counted'}
          savedAtText={entry.savedAt ? formatTaipeiMinute(entry.savedAt) : null}
          finalScore={entry.finalScore}
          submittedAtText={entry.submittedAt ? formatTaipeiSecond(entry.submittedAt) : null}
          draftFromOlderVersion={entry.draftFromOlderVersion}
        />
        <section aria-label="本組正式繳交" className="rounded-card border border-border bg-background p-5">
          <h3 className="text-base font-semibold text-ink">本組正式繳交</h3>
          <p className="mt-1 text-sm text-muted-foreground">評分用：這一組每份整組收件最新一次正式送出（草稿看不到）。附件每次下載都重新確認你還是評分老師。</p>
          {opened ? (
            <div className="mt-4">
              <VersionContent version={opened} backHref={benchHref} backLabel="本組正式繳交" title={`${groupCode} 組`} />
            </div>
          ) : latestByItem.length === 0 ? (
            <p className="mt-4 text-sm text-muted-foreground">這一組還沒有正式送出任何整組收件。</p>
          ) : (
            <ul className="mt-4 divide-y divide-border">
              {latestByItem.map((v) => (
                <li key={v.itemId} className="flex flex-wrap items-baseline justify-between gap-2 py-2 text-sm">
                  <Link href={`${benchHref}&item=${v.itemId}&version=${v.versionNo}`} className="font-medium text-primary underline-offset-2 hover:underline">
                    {v.title}
                  </Link>
                  <span className="tabular-nums text-muted-foreground">
                    第 {v.versionNo} 次送出・{formatTaipeiMinute(v.receivedBusinessAt)}・{v.submittedByName}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>,
  )
}
