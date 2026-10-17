import Link from 'next/link'
import { redirect } from 'next/navigation'
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { TEACHER_NAV } from '@/app/dashboard/_nav'
import { VersionContent } from '@/app/dashboard/_submissions/version-parts'
import { BackLink, OUTLINE_BUTTON, PageTitle, Pill } from '@/app/dashboard/teacher/_ui/dash'
import type { BenchSnapshot, NeighbourLink } from '@/app/dashboard/teacher/grading/[groupId]/bench-types'
import { GroupSubmissions } from '@/app/dashboard/teacher/grading/[groupId]/submissions'
import { filterQueue, neighbours, parseFilter } from '@/app/dashboard/teacher/grading/filter'
import { GradingBench } from '@/app/dashboard/teacher/grading/grading-bench'
import { myStatusOf } from '@/app/dashboard/teacher/grading/rules'
import type { ResolvedActor } from '@/application/accounts'
import type { BenchEntry } from '@/application/grading'
import { cohortLabel } from '@/composition/cohorts'
import { getGradingQuery } from '@/composition/grading'
import { getAdvisorSubmissionQuery } from '@/composition/submissions'
import { cn } from '@/shared/cn'
import { formatTaipeiMinute, formatTaipeiSecond } from '@/shared/time'

export const metadata = { title: '評分｜資管系專題平台' }

type Search = { stage?: string | string[]; filter?: string | string[]; item?: string | string[]; version?: string | string[] }

const BASE = '/dashboard/teacher/grading'

/**
 * 一頁一個讀取入口：`teacherBenchPage` 一次並行讀齊評閱桌、隊列、本組正式繳交與附件（TE-11，固定 10 句）。
 * 只有老師主動點開某一版（`?item=&version=`，而且是本組讀得到的版本）時，才多讀一次 `receiverVersion`（既有行為；
 * A 階段這條支線約 19 句，設計方案 §5 記為已知超出，B 再優化）。
 */
async function loadBenchPage(actor: ResolvedActor, groupId: string, search: Search) {
  const page = await getGradingQuery().teacherBenchPage(actor, groupId)
  if (!page.ok) return null
  const item = typeof search.item === 'string' ? search.item : null
  const version = typeof search.version === 'string' ? Number(search.version) : null
  const opened =
    item && version && page.receipt.submissions.some((v) => v.itemId === item && v.versionNo === version)
      ? await getAdvisorSubmissionQuery().receiverVersion(actor, item, groupId, version)
      : null
  return { page: page.receipt, opened }
}

/**
 * 評分卡排序快照、確認收據用的版本（Review #584 第 4 輪）：這個指派在資料庫裡每一筆寫入的時間戳取最大——
 * 暫存／送出的 `submitted_real_at`（`savedAt`、`submittedAt`、每一次送出紀錄）、退回事件的 `real_at`（`returnedAt`）。
 * 每次寫入都在組別＋指派的列鎖內取 `realAt` 再寫進只能 insert 的表，所以同一指派的寫入順序就是這些戳記的順序，
 * 隨每次寫入嚴格變大；它**不是**這次讀頁面的時間（那是 `serverTime`，兩次讀取可能同一毫秒）。退回後最新暫存可能比
 * 退回的那筆舊，所以不能只看 `savedAt`。結算／解除不寫評分列、不改這個版本（評分卡對那一軸只在同版本時比 `serverTime`）。
 * 沒有任何寫入時是空字串（任何寫入都比它大）。
 */
function benchVersionOf(entry: BenchEntry): string {
  const stamps = [entry.savedAt, entry.submittedAt, entry.returned?.returnedAt ?? null, ...entry.submissionHistory.map((h) => h.at)]
  let latest = 0
  for (const stamp of stamps) if (stamp && stamp.getTime() > latest) latest = stamp.getTime()
  return latest === 0 ? '' : new Date(latest).toISOString()
}

/** 評分卡一次收到的伺服器事實（見 `BenchSnapshot`）。 */
function benchSnapshotOf(entry: BenchEntry, serverTime: string): BenchSnapshot {
  return {
    version: benchVersionOf(entry),
    serverTime,
    scores: entry.scores,
    comment: entry.comment,
    hasFinal: entry.state === 'counted',
    readOnly: entry.settled !== null || (entry.state === 'counted' && !entry.resubmittable),
    settledAtText: entry.settled ? formatTaipeiMinute(entry.settled.settledAt) : null,
    draftAfterFinal: entry.draftAfterFinal,
    submissionHistory: entry.submissionHistory.map((h) => ({ no: h.no, atText: formatTaipeiSecond(h.at) })),
    savedAtText: entry.savedAt ? formatTaipeiMinute(entry.savedAt) : null,
    finalScore: entry.finalScore,
    draftFromOlderVersion: entry.draftFromOlderVersion,
  }
}

/**
 * 老師的單組評分頁（票 23、37；TE-06b 照 Q78 重做）：桌機兩欄，左欄「本組正式繳交」（附件清單＋在新分頁開啟 PDF），
 * 右欄固定的評分卡；頁首是自己的狀態與上一組／下一組。手機兩欄變上下，評分卡在下、動作列固定在底部。
 *
 * 只給**本人在這一組的有效指派**：沒有被指派（或指派已結束、組別不存在）一律導到 `/403`「找不到這個頁面」，
 * 不說原因、不透露這一組的任何評分資料（2026-10-12 Roy Q35）。同一組被指派多個階段時，用評分卡上方的階段切換。
 *
 * 被系辦退回、還沒重新送出：評分卡上方顯示退回理由與時間，退回前的分數預填回表單（票 24）。
 * 正式送出後仍可改、重新送出（B 階段 TE-B1）；系辦結算這一階段後整張唯讀（TE-B2b）。哪些能改由 `BenchEntry` 決定。
 */
export default async function TeacherGradingGroupPage({
  params,
  searchParams,
}: {
  params: Promise<{ groupId: string }>
  searchParams: Promise<Search>
}) {
  const { groupId } = await params
  const actor = await requireRole(`${BASE}/${groupId}`, 'teacher')
  const search = await searchParams
  const loaded = await loadBenchPage(actor, groupId, search)
  if (!loaded) redirect('/403')
  const { page, opened } = loaded

  const { entries, groupCode, cohortCode, cohortName, memberNames, versionNo, leaderName, queue } = page
  const entry = entries.find((e) => e.stage.key === search.stage) ?? entries[0]!
  const stageKey = entry.stage.key
  const filter = parseFilter(search.filter)
  const hrefOf = (id: string) => `${BASE}/${id}?stage=${encodeURIComponent(stageKey)}${filter === 'all' ? '' : `&filter=${filter}`}`
  const benchHref = hrefOf(groupId)

  // 上一組／下一組：同階段、同篩選（從總覽帶來的 `?filter=`）的前後一組；這一組已不在篩選裡（例如剛送出）就看同階段全部。
  const sameStage = queue.filter((e) => e.stageKey === stageKey)
  const filtered = filterQueue(sameStage, filter)
  const around = neighbours(filtered.some((e) => e.groupId === groupId) ? filtered : sameStage, groupId)
  const link = (e: (typeof queue)[number] | null): NeighbourLink => (e ? { href: hrefOf(e.groupId), groupCode: e.groupCode } : null)
  const mine = queue.find((e) => e.groupId === groupId && e.stageKey === stageKey)
  const status = mine ? myStatusOf(mine) : null

  return (
    <DashboardShell roleLabel="老師" items={TEACHER_NAV} current={BASE}>
      <div className="flex flex-col gap-5 pb-48 lg:pb-0">
        <BackLink href={filter === 'all' ? `${BASE}?stage=${encodeURIComponent(stageKey)}` : `${BASE}?stage=${encodeURIComponent(stageKey)}&filter=${filter}`}>
          評分總覽
        </BackLink>
        <PageTitle
          eyebrow={`${cohortLabel({ name: cohortName, code: cohortCode })}・${entry.stage.name}`}
          title={leaderName ? `${groupCode}・${leaderName}` : groupCode}
          description={
            status ? (
              <Pill tone={status.tone} testId="my-status">
                {status.text}
              </Pill>
            ) : null
          }
          actions={
            <nav aria-label="切換組別" className="flex items-center gap-2">
              <NeighbourButton side="prev" link={link(around.prev)} />
              <NeighbourButton side="next" link={link(around.next)} />
            </nav>
          }
        />

        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
          <GroupSubmissions
            rows={page.submissions}
            benchHref={benchHref}
            opened={opened ? <VersionContent version={opened} backHref={benchHref} backLabel="本組正式繳交" title={`${groupCode} 組`} /> : null}
          />
          <div className="min-w-0 lg:sticky lg:top-[4.5rem] lg:max-h-[calc(100dvh-5.5rem)] lg:overflow-y-auto lg:rounded-[18px]">
            <GradingBench
              key={entry.assignmentId}
              assignmentId={entry.assignmentId}
              groupCode={groupCode}
              stage={entry.stage}
              snapshot={benchSnapshotOf(entry, page.serverTime)}
              eyebrow={`${cohortLabel({ name: cohortName, code: cohortCode })}・${entry.stage.name}・評分規則第 ${versionNo} 版`}
              members={memberNames.join('、')}
            >
              {entries.length > 1 ? (
                <nav aria-label="選擇階段" className="inline-flex w-fit max-w-full flex-wrap gap-1 rounded-xl border border-border bg-card p-1">
                  {entries.map((e) => (
                    <Link
                      key={e.assignmentId}
                      href={`${BASE}/${groupId}?stage=${encodeURIComponent(e.stage.key)}`}
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
          </div>
        </div>
      </div>
    </DashboardShell>
  )
}

/**
 * 上一組／下一組。換組用整頁導向（一般 `<a>`，不是 client 端路由）：評分卡還有沒存的輸入時，
 * 瀏覽器的「離開此頁？」提示（評分卡掛的 beforeunload）才會跳出來。第一組／最後一組那一邊停用。
 */
function NeighbourButton({ side, link }: { side: 'prev' | 'next'; link: NeighbourLink }) {
  const label = side === 'prev' ? '上一組' : '下一組'
  const content =
    side === 'prev' ? (
      <>
        <IconChevronLeft aria-hidden />
        {label}
      </>
    ) : (
      <>
        {label}
        <IconChevronRight aria-hidden />
      </>
    )
  if (!link) {
    return (
      <a role="link" aria-disabled="true" className={cn(OUTLINE_BUTTON, 'pointer-events-none h-10 px-3 opacity-50')}>
        {content}
      </a>
    )
  }
  return (
    <a href={link.href} title={`${label}：${link.groupCode}`} className={cn(OUTLINE_BUTTON, 'h-10 px-3')}>
      {content}
      <span className="sr-only">：{link.groupCode}</span>
    </a>
  )
}
