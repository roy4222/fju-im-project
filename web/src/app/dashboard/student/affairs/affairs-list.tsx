import Link from 'next/link'
import { StatusPill, type Tone } from '@/app/_ui/dashboard/cards'
import { TableScroll } from '@/app/_ui/ui/table'
import type { StudentTodo } from '@/app/dashboard/student/_todo/todos'
import { cn } from '@/shared/cn'

/** 清單的一列（學生「交作業」與老師「作業區 › 我的作業」共用；狀態字、截止字由各自的頁面算好）。 */
export type AffairsListEntry = {
  /** 列的 `data-testid`（學生作業 `affair-<itemId>`、同意書 `consent-<versionId>`）。 */
  testId: string
  title: string
  /** 形式：檔案／表單／表單＋檔案／同意書（`formLabel`）。 */
  form: string
  /** 整組一份 → 形式後面多寫「・整組」。 */
  group: boolean
  status: { label: string; tone: Tone }
  /** 截止字（「10/31 23:59 截止」「補交到 11/2」「已交第 2 次」）。 */
  due: string
  href: string
  /** 還要交 → 「交作業」；已交、免繳、輪不到你 → 「查看」。 */
  action: '交作業' | '查看'
}

/** 狀態膠囊顏色（學生規格 §3.2 的對應）：同意書待你同意是紫色，其他照狀態。 */
export function toneOf(todo: Pick<StudentTodo, 'kind' | 'status'>): Tone {
  if (todo.kind === 'consent' && todo.status === 'open') return 'violet'
  switch (todo.status) {
    case 'overdue':
      return 'overdue'
    case 'soon':
      return 'soon'
    case 'open':
      return 'open'
    case 'notOpen':
      return 'neutral'
    default:
      return 'done'
  }
}

const ACTION_PRIMARY = 'btn-fju h-11 rounded-lg px-4 text-sm whitespace-nowrap'
const ACTION_SECONDARY =
  'press inline-flex h-11 items-center justify-center rounded-lg border border-border bg-background px-4 text-sm font-medium whitespace-nowrap transition-colors hover:bg-muted'

/**
 * 交作業清單（C 階段規格① §5.1；AC-16）：欄是名稱、形式、狀態、截止、「交作業」（已交→「查看」）。
 * **不放成績欄**：學生不看分數是既有定案（`student-zero-visibility.spec.ts`）；老師的「我的作業」用同一張表。
 * 窄螢幕橫向捲動、名稱欄固定（④ `TableScroll`）。
 */
export function AffairsList({ entries, label, empty }: { entries: readonly AffairsListEntry[]; label: string; empty: string }) {
  if (entries.length === 0) {
    return <p className="rounded-xl border border-dashed border-border px-5 py-8 text-center text-sm text-muted-foreground">{empty}</p>
  }
  return (
    <div className="dash-card overflow-hidden">
      <TableScroll stickyFirst>
        <table className="w-full min-w-[40rem] text-sm" aria-label={label}>
          <thead className="bg-muted text-left text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="px-5 py-2.5 font-medium">
                名稱
              </th>
              <th scope="col" className="px-3 py-2.5 font-medium">
                形式
              </th>
              <th scope="col" className="px-3 py-2.5 font-medium">
                狀態
              </th>
              <th scope="col" className="px-3 py-2.5 font-medium">
                截止
              </th>
              <th scope="col" className="px-5 py-2.5">
                <span className="sr-only">動作</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.testId} className="border-t border-border" data-testid={e.testId}>
                <td className="max-w-[18rem] px-5 py-3">
                  <Link href={e.href} className="line-clamp-2 font-bold text-foreground hover:text-brand">
                    {e.title}
                  </Link>
                </td>
                <td className="px-3 py-3 whitespace-nowrap" data-testid="affair-form">
                  {e.form}
                  {e.group ? <span className="text-muted-foreground">・整組</span> : null}
                </td>
                <td className="px-3 py-3 whitespace-nowrap">
                  <StatusPill tone={e.status.tone}>{e.status.label}</StatusPill>
                </td>
                <td className="tabular px-3 py-3 whitespace-nowrap text-muted-foreground">{e.due}</td>
                <td className="px-5 py-1.5 text-right">
                  <Link href={e.href} className={cn(e.action === '交作業' ? ACTION_PRIMARY : ACTION_SECONDARY)}>
                    {e.action}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
    </div>
  )
}
