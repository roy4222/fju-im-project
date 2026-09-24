import Link from 'next/link'
import { requireRole } from '@/app/_ui/guard'
import { EmptyState, PageHeader } from '@/app/_ui/primitives'
import { DashboardShell } from '@/app/_ui/site-shell'
import { STUDENT_NAV } from '@/app/dashboard/_nav'
import { TONE_CLASS } from '@/app/dashboard/student/affairs/tone'
import type { MyItemRow } from '@/application/submissions'
import { getBusinessClock } from '@/composition/cohorts'
import { getSubmissionQuery, receiverStatus } from '@/composition/submissions'
import { cn } from '@/shared/cn'
import { formatTaipeiMinute } from '@/shared/time'

export const metadata = { title: '作業區｜資管系專題平台' }

const TABS = [
  { key: 'all', label: '全部' },
  { key: 'open', label: '待繳' },
  { key: 'done', label: '已繳交' },
  { key: 'overdue', label: '逾期未繳' },
] as const

type TabKey = (typeof TABS)[number]['key']

/**
 * 學生作業區（票 17；原型 `/dashboard/student/affairs`）：一列一件，欄位是「作業名稱／形式／狀態／截止」。
 *
 * 只列**自己在目前收件名單上**的收件（發布中）：個人一份看本人、整組一份看自己此刻所在的組（票 21）。
 * 狀態字（尚未開放／未繳／已繳 vN／逾期未繳）由 application 的 `statusOf` 算，列表與內容頁同一個口徑；
 * 開放與截止都看業務時鐘（測試站可以撥）。整組一份時任一位組員送出，全組的這一列都變成已繳。
 */
export default async function StudentAffairsPage({ searchParams }: { searchParams: Promise<{ tab?: string | string[] }> }) {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  const actor = await requireRole('/dashboard/student/affairs', 'student')
  const userId = actor.kind === 'authenticated' ? actor.userId : ''
  const params = await searchParams
  const tab: TabKey = TABS.find((t) => t.key === params.tab)?.key ?? 'all'

  const [rows, businessNow] = await Promise.all([getSubmissionQuery().myItems(userId), getBusinessClock().now()])
  // 狀態字與首頁待繳數、管理員名單頁同一個函式（票 18）。
  const items = rows.map((row) => ({ row, status: receiverStatus(row, row, businessNow) }))
  const inTab = (key: TabKey) =>
    items.filter(({ status }) =>
      key === 'open' ? status.pending : key === 'done' ? status.submitted : key === 'overdue' ? status.overdue : true,
    )
  const list = inTab(tab)
  const count = (key: TabKey) => inTab(key).length

  const dueText = (dueAt: Date | null) => (dueAt ? formatTaipeiMinute(dueAt) : '無截止')

  return (
    <DashboardShell roleLabel="學生" items={STUDENT_NAV} current="/dashboard/student/affairs">
      <PageHeader
        title="作業區"
        description={`你在收件名單上的每一份收件、狀態與截止。待繳 ${count('open')}・已繳交 ${count('done')}${
          count('overdue') ? `・逾期未繳 ${count('overdue')}` : ''
        }`}
      />

      <nav aria-label="篩選" className="mb-4 flex gap-2 overflow-x-auto pb-1">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={t.key === 'all' ? '/dashboard/student/affairs' : `/dashboard/student/affairs?tab=${t.key}`}
            aria-current={t.key === tab ? 'page' : undefined}
            className={cn(
              'inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full border px-4 text-sm font-medium',
              t.key === tab ? 'border-primary bg-primary text-primary-foreground' : 'border-border text-ink hover:bg-muted',
            )}
          >
            {t.label}
            <span className="tabular-nums text-xs opacity-80">{count(t.key)}</span>
          </Link>
        ))}
      </nav>

      {list.length === 0 ? (
        <EmptyState
          title={tab === 'all' ? '目前沒有要交的收件' : `沒有${TABS.find((t) => t.key === tab)!.label}的收件`}
          description="系辦發布收件、而且你（或你的組別）在收件名單上時，會出現在這裡；有新收件時通知匣也會有一則。整組一份的收件要先成立組別。"
        />
      ) : (
        <>
          {/* 手機：一件一張卡 */}
          <ul className="divide-y divide-border rounded-card border border-border bg-background sm:hidden" aria-label="收件列表">
            {list.map(({ row, status }) => (
              <li key={row.itemId} className="flex flex-col gap-2 px-4 py-4">
                <Link href={`/dashboard/student/affairs/${row.itemId}`} className="text-base font-semibold text-ink">
                  {row.title}
                </Link>
                <p className="text-sm">
                  <span className={cn('font-semibold', TONE_CLASS[status.tone])}>{status.headline}</span>
                  <span className="ml-2 text-muted-foreground">{status.detail}</span>
                </p>
                <div className="flex items-center gap-3">
                  <span className="min-w-0 flex-1 text-xs text-muted-foreground tabular-nums">
                    截止 {dueText(row.dueAt)}・{unitText(row)}
                  </span>
                  <ActionLink itemId={row.itemId} label={status.action} primary={status.pending} />
                </div>
              </li>
            ))}
          </ul>

          {/* 桌面：表格 */}
          <div className="hidden overflow-x-auto rounded-card border border-border bg-background sm:block">
            <table className="w-full min-w-[40rem] text-sm">
              <thead className="bg-muted text-left text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">
                    作業名稱
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    形式
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    狀態
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    截止
                  </th>
                  <th scope="col" className="px-4 py-2">
                    <span className="sr-only">動作</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.map(({ row, status }) => (
                  <tr key={row.itemId} className="border-t border-border" data-testid={`affair-${row.itemId}`}>
                    <td className="px-4 py-3">
                      <Link href={`/dashboard/student/affairs/${row.itemId}`} className="block font-semibold text-ink">
                        {row.title}
                      </Link>
                      <span className="text-xs text-muted-foreground">
                        階段：{row.stageName ?? '未指定'}
                        {row.attachmentCount > 0 ? `・${row.attachmentCount} 個附件` : ''}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">{unitText(row)}</td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <span className={cn('block font-semibold', TONE_CLASS[status.tone])}>{status.headline}</span>
                      <span className="block text-xs text-muted-foreground">{status.detail}</span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 tabular-nums">
                      {dueText(row.dueAt)}
                      {row.dueAt ? <span className="block text-xs text-muted-foreground">含此分鐘，臺灣時間</span> : null}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <ActionLink itemId={row.itemId} label={status.action} primary={status.pending} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </DashboardShell>
  )
}

function ActionLink({ itemId, label, primary }: { itemId: string; label: string; primary: boolean }) {
  return (
    <Link
      href={`/dashboard/student/affairs/${itemId}`}
      className={cn(
        'inline-flex h-10 shrink-0 items-center rounded-md px-4 text-sm font-medium',
        primary ? 'bg-primary text-primary-foreground hover:bg-primary/90' : 'border border-border text-ink hover:bg-muted',
      )}
    >
      {label}
    </Link>
  )
}

/** 形式欄：個人一份，或整組一份（帶自己組別的代號）。 */
function unitText(row: MyItemRow): string {
  return row.receiverUnit === 'group' ? `整組一份${row.groupCode ? `（${row.groupCode}）` : ''}` : '個人一份'
}
