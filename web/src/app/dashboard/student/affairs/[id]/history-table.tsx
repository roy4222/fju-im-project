import Link from 'next/link'
import { UserAvatar } from '@/app/_ui/avatar/user-avatar'
import type { VersionSummary } from '@/application/submissions'
import { formatTaipeiSecond } from '@/shared/time'

/**
 * 交作業的「繳交歷史」表（C 階段規格① §5.2；AC-19）：只列正式送出的版本，新的在上。
 * 三欄：已交時間、繳交人（頭像＋姓名）、「查看」。沒有草稿列、沒有版本號數字（學生不用知道第幾版）。
 * 學生與名單上的老師共用（`hrefOf` 給各自的網址）。截止後靠系辦開的補交送出的標「補交」。
 */
export function HistoryTable({ versions, hrefOf }: { versions: readonly VersionSummary[]; hrefOf: (versionNo: number) => string }) {
  if (versions.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">還沒有繳交過。</p>
  }
  return (
    <table className="w-full text-sm" aria-label="繳交歷史">
      <thead className="text-left text-xs text-muted-foreground">
        <tr>
          <th scope="col" className="py-2 font-medium">
            已交時間（臺灣時間）
          </th>
          <th scope="col" className="py-2 font-medium">
            繳交人
          </th>
          <th scope="col" className="py-2">
            <span className="sr-only">動作</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {versions.map((v) => (
          <tr key={v.versionNo} className="border-t border-border" data-testid="history-row">
            <td className="py-3 tabular-nums">
              {formatTaipeiSecond(v.receivedBusinessAt)}
              {v.late ? (
                <span className="ml-2 rounded-full bg-warning-subtle px-2 py-0.5 text-[11px] text-warning-on-subtle" data-testid="late-badge">
                  補交
                </span>
              ) : null}
            </td>
            <td className="py-3">
              <span className="inline-flex items-center gap-2">
                <UserAvatar user={v.submittedBy} size={24} decorative />
                <span className="font-semibold">{v.submittedByName}</span>
              </span>
            </td>
            <td className="py-1 text-right">
              <Link
                href={hrefOf(v.versionNo)}
                className="inline-flex h-11 items-center rounded-lg px-3 text-[13px] font-semibold text-ink transition-colors hover:bg-accent"
              >
                查看
              </Link>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
