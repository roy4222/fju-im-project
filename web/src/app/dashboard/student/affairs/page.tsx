import Link from 'next/link'
import { IconHistory } from '@tabler/icons-react'
import { StatusPill } from '@/app/_ui/dashboard/cards'
import { PageTitle, Panel } from '@/app/_ui/dashboard/primitives'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { STUDENT_NAV } from '@/app/dashboard/_nav'
import { formLabel } from '@/app/dashboard/_submissions/assignment-kind'
import { AffairsList, toneOf, type AffairsListEntry } from '@/app/dashboard/student/affairs/affairs-list'
import { dueText } from '@/app/dashboard/student/_todo/due-text'
import { studentItems, studentSignoff, studentTodos, todoCounts, type StudentTodo } from '@/app/dashboard/student/_todo/todos'
import type { MyRecordRow } from '@/application/submissions'
import { getSubmissionQuery } from '@/composition/submissions'
import { cn } from '@/shared/cn'
import { formatTaipeiMinute } from '@/shared/time'

export const metadata = { title: '交作業｜資管系專題平台' }

const TABS = [
  { key: 'open', label: '待交' },
  { key: 'done', label: '已交' },
  { key: 'overdue', label: '逾期' },
] as const

type TabKey = (typeof TABS)[number]['key']

/** 每個篩選收哪些狀態；跟 `todoCounts` 同一個分法（Q119：尚未開放在待交、免繳在已交）。 */
const IN_TAB: Readonly<Record<TabKey, (t: StudentTodo) => boolean>> = {
  open: (t) => t.status === 'open' || t.status === 'soon' || t.status === 'notOpen',
  done: (t) => t.status === 'done' || t.status === 'exempt',
  overdue: (t) => t.status === 'overdue',
}

/**
 * 學生「交作業」（學生規格 §3.3，ST-3；C 階段規格① §5.1 改成清單）：三個篩選（待交／已交／逾期）＋一張表
 * （名稱、形式、狀態、截止、「交作業」／「查看」），同意書也是一列。**不放成績欄**（AC-16）。
 *
 * - 清單與三個數字都來自 ST-1 的 `studentTodos`（首頁待辦、側欄徽章同一份口徑），這頁不自己判狀態。
 * - 篩選是連結（`?tab=`），不是 client state；舊的 `?tab=all` 與不認得的值都當成「待交」。
 * - 作業列保留 `affair-<itemId>`；同意書列用 `consent-<versionId>`（被移出名單後 `affair-` 要數到 0）。
 * - 「以前的紀錄」（票 22；Q121）：已經不在作業區、但本人讀得到的正式版本，只在「已交」下方，也只在那裡查。
 */
export default async function StudentAffairsPage({ searchParams }: { searchParams: Promise<{ tab?: string | string[] }> }) {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  const actor = await requireRole('/dashboard/student/affairs', 'student')
  const userId = actor.kind === 'authenticated' ? actor.userId : ''
  const params = await searchParams
  const tab: TabKey = TABS.find((t) => t.key === params.tab)?.key ?? 'open'

  // 三份都是同一次請求的 `cache`：`studentTodos` 自己也讀前兩份，不會多查。
  const [todos, [rows, now], signoff, records] = await Promise.all([
    studentTodos(userId),
    studentItems(userId),
    studentSignoff(userId),
    tab === 'done' ? getSubmissionQuery().myRecords(userId) : Promise.resolve([]),
  ])
  const counts = todoCounts(todos)
  const list = todos.filter(IN_TAB[tab])
  const rowOf = new Map(rows.map((row) => [row.itemId, row]))
  // 副標是自己此刻所在的組；同意書查詢已經讀過（沒分組就不顯示）。
  const groupCode = signoff.groupCode ?? rows.find((row) => row.groupCode)?.groupCode ?? null
  const active = TABS.find((t) => t.key === tab)!

  /** 第二行：已交的作業寫第幾次，其他寫截止字（補交期限生效時「補交到 M/D」）。 */
  const secondLine = (todo: StudentTodo) => {
    const no = todo.kind === 'item' && todo.status === 'done' ? rowOf.get(todo.id)?.latestVersionNo : null
    return no ? `已交第 ${no} 次` : dueText(todo, now)
  }
  const entries: AffairsListEntry[] = list.map((todo) => {
    const row = todo.kind === 'item' ? rowOf.get(todo.id) : undefined
    return {
      testId: todo.kind === 'consent' ? `consent-${todo.id}` : `affair-${todo.id}`,
      title: todo.title,
      form: todo.kind === 'consent' ? '同意書' : formLabel(row ?? {}),
      group: todo.unit === 'group',
      status: { label: todo.label, tone: toneOf(todo) },
      due: secondLine(todo),
      href: todo.href,
      action: todo.status === 'done' || todo.status === 'exempt' ? '查看' : '交作業',
    }
  })

  return (
    <DashboardShell roleLabel="學生" items={STUDENT_NAV} current="/dashboard/student/affairs">
      <div className="flex flex-col gap-5">
        <PageTitle
          title="交作業"
          description={groupCode ?? undefined}
          actions={
            <nav aria-label="篩選作業" className="flex gap-1 rounded-full border border-border bg-card p-1">
              {TABS.map((t) => {
                const on = t.key === tab
                return (
                  <Link
                    key={t.key}
                    href={`/dashboard/student/affairs?tab=${t.key}`}
                    aria-current={on ? 'page' : undefined}
                    scroll={false}
                    className={cn(
                      'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-4 text-sm font-semibold whitespace-nowrap transition-colors',
                      on ? 'bg-ink text-ink-foreground' : 'text-foreground hover:bg-accent',
                    )}
                  >
                    {t.label}
                    <span className={cn('tabular text-xs', on ? 'text-ink-foreground/80' : 'text-muted-foreground')}>{counts[t.key]}</span>
                  </Link>
                )
              })}
            </nav>
          }
        />

        <AffairsList entries={entries} label="作業列表" empty={`沒有${active.label}的作業`} />

        {tab === 'done' && records.length > 0 ? <Records records={records} /> : null}
      </div>
    </DashboardShell>
  )
}

/**
 * 以前的紀錄（票 22；產品模組 05 SUB-20、25；Q121）：已經不在作業區、但本人讀得到的正式版本。
 * 被移出組別的人只看得到自己還在組裡時送出的版本；被移出個人收件名單的人看得到自己的回答。唯讀。
 */
function Records({ records }: { records: readonly MyRecordRow[] }) {
  return (
    <Panel title="以前的紀錄" icon={<IconHistory />} description="已經不在「交作業」裡的項目，唯讀">
      <p className="px-5 pb-3 text-[13px] text-muted-foreground">
        離開組別後，只看得到你還在組裡時送出的版本與附件；不能再填寫或送出。
      </p>
      <ul className="divide-y divide-border/70 border-t border-border/70" aria-label="以前的紀錄" data-testid="my-records">
        {records.map((r) => (
          <li key={`${r.itemId}:${r.receiverId}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3.5">
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="truncate text-[15px] font-bold">{r.title}</span>
                <StatusPill tone="neutral">唯讀</StatusPill>
              </span>
              <span className="block text-xs text-muted-foreground tabular-nums">
                {r.receiverKind === 'group' ? `整組一份（${r.groupCode ?? ''}）` : '個人一份'}・你看得到 {r.versionCount} 個版本・最後一次是第 {r.latestVersionNo} 次，
                於 {formatTaipeiMinute(r.latestReceivedAt)} 送出
              </span>
            </span>
            <Link
              href={`/dashboard/student/affairs/${r.itemId}?record=${r.receiverId}`}
              className="press inline-flex h-10 shrink-0 items-center rounded-lg border border-border bg-background px-4 text-sm font-medium transition-colors hover:bg-muted"
            >
              查看紀錄
            </Link>
          </li>
        ))}
      </ul>
    </Panel>
  )
}
