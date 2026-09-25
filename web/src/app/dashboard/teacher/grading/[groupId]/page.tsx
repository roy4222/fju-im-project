import Link from 'next/link'
import { IconChecklist, IconPaperclip } from '@tabler/icons-react'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { TEACHER_NAV } from '@/app/dashboard/_nav'
import { VersionContent } from '@/app/dashboard/_submissions/version-parts'
import { PageTitle, Panel, PanelEmpty } from '@/app/dashboard/teacher/_ui/dash'
import { GradingBench } from '@/app/dashboard/teacher/grading/grading-bench'
import { GradingQueue } from '@/app/dashboard/teacher/grading/queue'
import { QueueSelect } from '@/app/dashboard/teacher/grading/queue-select'
import { getGradingQuery } from '@/composition/grading'
import { getAdvisorSubmissionQuery } from '@/composition/submissions'
import { cn } from '@/shared/cn'
import { formatTaipeiMinute, formatTaipeiSecond } from '@/shared/time'

export const metadata = { title: '評閱桌｜資管系專題平台' }

/**
 * 老師的評閱桌（票 23；票 37 照原型 `/dashboard/teacher/grading/[groupId]`）：左邊是本人的評分佇列（手機收成下拉），右邊是這一組的評分表。
 *
 * 只給**本人在這一組的有效指派**：沒有被指派（或指派已結束）就只顯示「你沒有被指派評這一組」，
 * 不透露這一組的任何評分資料。同一組被指派多個階段時，用評分表上方的階段切換。
 *
 * 票 24：
 * - 被系辦退回、還沒重新送出：評分表上方顯示退回理由與時間，退回前的分數預填回表單，改完再正式送出。
 * - 「本組正式繳交」（S10-03）：評分要看作品——本組有效評分指派的老師讀得到這一組每一份整組收件的正式版本與附件
 *   （和組員、主指導同一段查詢、同一個授權；附件每次下載都重新授權）。草稿、個人回答不給。原型沒有這一塊，放在評分表下面。
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
      <div className="flex flex-col gap-5">
        <PageTitle title="評分工作台" description="只有你被指派的組別。暫存只有你和系辦看得到，正式送出後鎖定。" />
        {children}
      </div>
    </DashboardShell>
  )

  if (!bench.ok) {
    return shell(
      <Panel title="評分表" icon={<IconChecklist />}>
        <PanelEmpty
          icon={<IconChecklist />}
          title="你沒有被指派評這一組"
          hint={bench.message}
          action={{ href: '/dashboard/teacher/grading', label: '回評分工作台' }}
        />
      </Panel>,
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
  const current = { groupId, stageKey: entry.stage.key }
  const pending = queue.filter((e) => e.state !== 'counted').length
  const stateText = (e: (typeof queue)[number]) =>
    e.state === 'counted' ? '已送出' : e.returned ? '已退回' : e.state === 'draft' ? '草稿' : '未開始'

  return shell(
    <div className="grid items-start gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
      <QueueSelect
        value={`${groupId}:${entry.stage.key}`}
        options={queue.map((e) => ({
          value: `${e.groupId}:${e.stageKey}`,
          href: `/dashboard/teacher/grading/${e.groupId}?stage=${e.stageKey}`,
          label: `${e.groupCode}・${e.stageName}（${stateText(e)}）`,
        }))}
      />
      <aside className="hidden lg:block">
        <GradingQueue
          entries={queue}
          current={current}
          heading={{ title: entry.stage.name, detail: `我的 ${queue.length} 份・${pending} 份未送出・占總成績 ${entry.stage.weight}%` }}
        />
      </aside>
      <div className="flex min-w-0 flex-col gap-4">
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
          eyebrow={`${cohortCode}・${entry.stage.name}・方案 v${versionNo}`}
          members={memberNames.join('、')}
        >
          {entries.length > 1 ? (
            <nav aria-label="選擇階段" className="inline-flex w-fit max-w-full flex-wrap gap-1 rounded-xl border border-border bg-card p-1">
              {entries.map((e) => (
                <Link
                  key={e.assignmentId}
                  href={`/dashboard/teacher/grading/${groupId}?stage=${e.stage.key}`}
                  aria-current={e.assignmentId === entry.assignmentId ? 'page' : undefined}
                  className={cn(
                    'inline-flex h-8 items-center rounded-lg px-3 text-sm font-semibold transition-colors',
                    e.assignmentId === entry.assignmentId ? 'bg-ink text-ink-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                  )}
                >
                  {e.stage.name}
                </Link>
              ))}
            </nav>
          ) : null}
          {entry.returned ? (
            <p role="status" data-testid="returned-notice" className="rounded-lg bg-destructive-subtle px-3 py-2 text-sm text-destructive-on-subtle">
              系辦在 {formatTaipeiMinute(entry.returned.returnedAt)} 退回了這一份評分：{entry.returned.reason}
              。退回前的分數已經填回表單，修改後請重新正式送出。
            </p>
          ) : null}
        </GradingBench>

        <Panel title="本組正式繳交" icon={<IconPaperclip />} description="評分用：每份整組收件最新一次正式送出">
          {opened ? (
            <div className="border-t border-border px-5 py-4">
              <VersionContent version={opened} backHref={benchHref} backLabel="本組正式繳交" title={`${groupCode} 組`} />
            </div>
          ) : latestByItem.length === 0 ? (
            <PanelEmpty icon={<IconPaperclip />} title="這一組還沒有正式送出任何整組收件" hint="草稿看不到；附件每次下載都重新確認你還是評分老師。" />
          ) : (
            <ul className="divide-y divide-border">
              {latestByItem.map((v) => (
                <li key={v.itemId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 transition-colors hover:bg-accent/40">
                  <Link
                    href={`${benchHref}&item=${v.itemId}&version=${v.versionNo}`}
                    className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground underline-offset-2 hover:underline"
                  >
                    {v.title}
                  </Link>
                  <span className="tabular text-xs text-muted-foreground">
                    v{v.versionNo}・{v.submittedByName}・{formatTaipeiMinute(v.receivedBusinessAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>,
  )
}
