import Link from 'next/link'
import { requireRole } from '@/app/_ui/guard'
import { EmptyState, PageHeader } from '@/app/_ui/primitives'
import { DashboardShell } from '@/app/_ui/site-shell'
import { TEACHER_NAV } from '@/app/dashboard/_nav'
import { TONE_CLASS } from '@/app/dashboard/student/affairs/tone'
import type { AdvisorMatrixCell, AdvisorMatrixItem } from '@/application/submissions'
import { getBusinessClock } from '@/composition/cohorts'
import { GROUP_TYPE_LABEL } from '@/composition/groups'
import { categoryOf, getAdvisorSubmissionQuery, receiverStatus } from '@/composition/submissions'
import { cn } from '@/shared/cn'
import { formatTaipeiMinute } from '@/shared/time'

export const metadata = { title: '各組繳交狀態｜資管系專題平台' }

/**
 * 老師「各組繳交狀態」（票 22；原型 `/dashboard/teacher/affairs` 的「指導組別 × 收件項目」矩陣）。
 *
 * 只列老師**此刻**指導的組別（換掉的組下一次打開就不見了），欄是那些組所在屆別、發布中、整組一份的收件；
 * 每格是那一組的狀態（跟學生作業區、系辦名單頁同一個 `receiverStatus`），點進去看版本與內容。
 * 老師看不到共用草稿，所以沒交的格子一律是「未繳」，不會出現「草稿已存」。
 * 下面另列系辦開了主指導閱覽的個人收件（沒開的個人收件老師看不到，產品模組 05 §4）。
 */
export default async function TeacherAffairsPage() {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  const actor = await requireRole('/dashboard/teacher/affairs', 'teacher')
  const [matrix, businessNow] = await Promise.all([getAdvisorSubmissionQuery().matrix(actor), getBusinessClock().now()])
  const groups = matrix?.groups ?? []
  const items = matrix?.items ?? []
  const individual = matrix?.individualItems ?? []
  const cellOf = new Map((matrix?.cells ?? []).map((c) => [`${c.groupId}:${c.itemId}`, c]))

  return (
    <DashboardShell roleLabel="老師" items={TEACHER_NAV} current="/dashboard/teacher/affairs">
      <PageHeader title="各組繳交狀態" description={`我的 ${groups.length} 個指導組別 × ${items.length} 個整組收件。點狀態看每一次正式送出的版本與內容。`} />

      {groups.length === 0 ? (
        <EmptyState
          title="你目前沒有指導的組別"
          description="系辦指派或你在「分組」認領產學組之後，那些組的繳交狀態會出現在這裡。換老師後，原本的組就不會再出現。"
          action={{ href: '/dashboard/teacher/groups', label: '到分組' }}
        />
      ) : items.length === 0 ? (
        <EmptyState title="還沒有整組一份的收件" description="系辦發布整組一份的收件之後，會在這裡列出你指導的每一組交了沒。" />
      ) : (
        <section aria-labelledby="matrix-title" className="rounded-card border border-border bg-background">
          <h2 id="matrix-title" className="px-5 pt-4 text-base font-semibold text-ink">
            繳交矩陣
          </h2>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm" aria-label="繳交矩陣" data-testid="teacher-matrix">
              <thead className="bg-muted text-left text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="sticky left-0 bg-muted px-4 py-2 font-medium">
                    組別
                  </th>
                  {items.map((item) => (
                    <th key={item.itemId} scope="col" className="min-w-[10rem] px-4 py-2 font-medium">
                      <span className="block truncate text-ink">{item.title}</span>
                      <span className="block font-normal tabular-nums">{item.dueAt ? `${formatTaipeiMinute(item.dueAt)} 截止` : '無截止'}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => (
                  <tr key={group.groupId} className="border-t border-border" data-testid={`matrix-row-${group.code}`}>
                    <th scope="row" className="sticky left-0 bg-background px-4 py-3 text-left align-top font-normal">
                      <span className="block font-semibold tabular-nums text-ink">{group.code}</span>
                      <span className="block text-xs text-muted-foreground">
                        {group.cohortCode}・{GROUP_TYPE_LABEL[group.groupType]}
                      </span>
                      <span className="block max-w-[14rem] truncate text-xs text-muted-foreground">{group.memberNames.join('、')}</span>
                    </th>
                    {items.map((item) => (
                      <td key={item.itemId} className="px-4 py-3 align-top">
                        <Cell item={item} groupId={group.groupId} cell={item.cohortId === group.cohortId ? cellOf.get(`${group.groupId}:${item.itemId}`) : undefined} businessNow={businessNow} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {individual.length > 0 ? (
        <section aria-labelledby="individual-title" className="mt-6 space-y-2">
          <h2 id="individual-title" className="text-base font-semibold text-ink">
            開放主指導閱覽的個人收件
          </h2>
          <p className="text-sm text-muted-foreground">系辦開了主指導閱覽的個人收件，你看得到自己指導的學生正式送出的回答（草稿不給）。</p>
          <ul className="divide-y divide-border rounded-card border border-border bg-background" data-testid="individual-items">
            {individual.map((item) => (
              <li key={item.itemId} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold text-ink">{item.title}</span>
                  <span className="block text-xs text-muted-foreground tabular-nums">
                    {item.dueAt ? `${formatTaipeiMinute(item.dueAt)} 截止` : '無截止'}・欄位第 {item.effectiveFromVersionNo} 版起開放
                  </span>
                </span>
                <span className="text-sm font-semibold tabular-nums">
                  已繳 {item.submitted}／{item.required} 位
                </span>
                <Link
                  href={`/dashboard/teacher/affairs/${item.itemId}`}
                  className="inline-flex h-10 items-center rounded-md border border-border px-3 text-sm font-medium text-ink hover:bg-muted"
                >
                  查看
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </DashboardShell>
  )
}

function Cell({
  item,
  groupId,
  cell,
  businessNow,
}: {
  item: AdvisorMatrixItem
  groupId: string
  cell: AdvisorMatrixCell | undefined
  businessNow: Date
}) {
  if (!cell) return <span className="text-xs text-muted-foreground">不在名單</span>
  const category = categoryOf(cell)
  const status = receiverStatus(item, { exempt: cell.exempt, hasDraft: false, latestVersionNo: cell.latestVersionNo }, businessNow)
  const headline = category === 'removed' ? '已移出名單' : status.headline
  const tone = category === 'current' ? TONE_CLASS[status.tone] : 'text-muted-foreground'
  let detail = ''
  if (cell.latestVersionNo !== null && cell.latestReceivedAt) {
    detail = `${cell.latestSubmittedByName ?? ''}・${formatTaipeiMinute(cell.latestReceivedAt)}`
  } else if (category === 'current' && status.headline === '尚未開放') {
    detail = status.detail
  } else if (category === 'current' && !status.overdue) {
    detail = '還沒正式送出'
  }
  return (
    <Link href={`/dashboard/teacher/affairs/${item.itemId}?group=${groupId}`} className="group block rounded-md px-1 py-0.5 hover:bg-muted" data-testid="matrix-cell">
      <span className={cn('block font-semibold', tone)}>{headline}</span>
      {detail ? <span className="block text-xs text-muted-foreground tabular-nums">{detail}</span> : null}
    </Link>
  )
}
