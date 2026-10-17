import Link from 'next/link'
import { IconArchive } from '@tabler/icons-react'
import { NOTE } from '@/app/_ui/dashboard/look'
import { Panel, PANEL_TABLE_HEAD, PANEL_TABLE_ROW } from '@/app/_ui/dashboard/primitives'
import type { DissolvedGroupSummary } from '@/application/groups'
import { GROUP_TYPE_LABEL } from '@/composition/groups'
import { formatTaipeiMinute } from '@/shared/time'

/**
 * 分組總覽的「已解散的組別」（A-19；PR #333，B 階段設計方案 §17.2）：唯讀表，組別代碼、解散時間、解散時成員快照、理由。
 * 資料凍結，成績在成績頁查看與匯出。一組都沒有就不顯示。
 * `justDissolvedId`：剛解散完（動作把那組的 id 帶回網址）時，在表上方顯示回執。
 */
export function DissolvedGroups({ groups, justDissolvedId }: { groups: readonly DissolvedGroupSummary[]; justDissolvedId: string | null }) {
  if (groups.length === 0) return null
  const justDissolved = groups.find((g) => g.id === justDissolvedId) ?? null
  return (
    <Panel
      title="已解散的組別"
      icon={<IconArchive />}
      description={`${groups.length} 組・資料凍結，只能查看；成績在成績頁查看與匯出`}
      aria-label="已解散的組別"
    >
      {justDissolved ? (
        <div className="px-5 pb-3">
          <p role="status" className={NOTE}>
            已解散 {justDissolved.code}：{justDissolved.members.length} 人回到未分組；組員、主指導與評分老師已收到通知。
          </p>
        </div>
      ) : null}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[40rem] text-sm">
          <thead>
            <tr className={PANEL_TABLE_HEAD}>
              <th scope="col" className="px-5 py-2.5 font-semibold">組別</th>
              <th scope="col" className="px-4 py-2.5 font-semibold">解散時間</th>
              <th scope="col" className="px-4 py-2.5 font-semibold">解散時成員</th>
              <th scope="col" className="px-4 py-2.5 font-semibold">理由</th>
              <th scope="col" className="px-5 py-2.5">
                <span className="sr-only">動作</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.id} className={PANEL_TABLE_ROW}>
                <td className="px-5 py-3">
                  <span className="tabular font-bold">{g.code}</span>
                  <span className="ml-2 text-xs text-muted-foreground">{GROUP_TYPE_LABEL[g.groupType]}</span>
                </td>
                <td className="tabular px-4 py-3 whitespace-nowrap text-muted-foreground">{formatTaipeiMinute(g.dissolvedAt)}</td>
                <td className="px-4 py-3">{g.members.map((m) => (m.isLeader ? `${m.name}（組長）` : m.name)).join('、') || '—'}</td>
                <td className="px-4 py-3 text-muted-foreground">{g.reason}</td>
                <td className="px-5 py-3 text-right whitespace-nowrap">
                  <Link href={`/dashboard/admin/grading/${g.id}`} className="text-sm font-semibold text-primary hover:underline">
                    看成績
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}
