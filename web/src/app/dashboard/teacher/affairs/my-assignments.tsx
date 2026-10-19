import { formLabel } from '@/app/dashboard/_submissions/assignment-kind'
import { dueText } from '@/app/dashboard/student/_todo/due-text'
import { itemTodo } from '@/app/dashboard/student/_todo/todos'
import { AffairsList, toneOf, type AffairsListEntry } from '@/app/dashboard/student/affairs/affairs-list'
import type { MyItemRow } from '@/application/submissions'

const BASE = '/dashboard/teacher/affairs'

/**
 * 老師「作業區 › 我的作業」（C 階段規格① §5.1、§5.3；AC-20）：系辦發給老師的作業（老師在收件名單上），
 * 跟學生「交作業」同一張表、同一套狀態字（`itemTodo`），點進去是同一套作業頁（`AssignmentView`）。
 * 等這位主指導同意的站內同意書也併在這裡（形式「同意書」、狀態「等你同意」），連到「同意書」分頁。
 */
export function MyAssignments({ rows, now }: { rows: readonly MyItemRow[]; now: Date }) {
  const entries: AffairsListEntry[] = rows.map((row) => {
    if (row.consent) {
      return {
        testId: `consent-${row.consent.versionId}`,
        title: row.title,
        form: '同意書',
        group: false,
        status: { label: '等你同意', tone: toneOf({ kind: 'consent', status: 'open' }) },
        due: row.groupCode ?? '',
        href: `${BASE}?tab=signoff`,
        action: '交作業',
      }
    }
    const todo = itemTodo(row, now)
    return {
      testId: `affair-${row.itemId}`,
      title: row.title,
      form: formLabel(row),
      group: row.receiverUnit === 'group',
      status: { label: todo.label, tone: toneOf(todo) },
      due: todo.status === 'done' && row.latestVersionNo ? `已交第 ${row.latestVersionNo} 次` : dueText(todo, now),
      href: `${BASE}/${row.itemId}`,
      action: todo.status === 'done' || todo.status === 'exempt' ? '查看' : '交作業',
    }
  })
  return <AffairsList entries={entries} label="我的作業" empty="系辦還沒有發給你的作業。" />
}
