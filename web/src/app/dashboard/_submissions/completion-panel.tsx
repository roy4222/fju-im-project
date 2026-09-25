import { IconFileText } from '@tabler/icons-react'
import type { Completion } from '@/application/submissions'
import { Panel, Ring, SegmentBar } from '@/app/_ui/dashboard-kit'
import { cn } from '@/shared/cn'

/**
 * 收件進度（完成率）面板：管理員名單頁（票 18／21）與老師的收件頁（票 22）共用。
 * 分子分母由 application 的 `completionOf` 算，這裡只畫；整組一份的單位是「組」（同組五人誰送都只算一份）。
 *
 * 外觀照原型（票 35）：綠色進度環＋右側三個數字＋分段長條（已繳綠、逾期紅、未繳灰）。
 */

export function CompletionPanel({ completion, individual }: { completion: Completion; individual: boolean }) {
  // 整組一份的單位是「組」：同組五人誰送都只算這一組一份（產品模組 05 §4「組別完成率以符合資格的組別為單位」）。
  const unit = individual ? '人' : '組'
  return (
    <Panel
      title="收件進度"
      icon={<IconFileText />}
      description={`應交 ${completion.required} ${unit}`}
      headingId="progress-title"
      data-testid="completion"
    >
      <div className="flex items-center gap-5 border-t border-border px-5 py-4">
        <Ring value={completion.percent ?? 0} label={completion.percent === null ? '沒有應交的人' : `完成 ${completion.percent}%`}>
          <span className="text-base font-extrabold tabular-nums">{completion.percent === null ? '—' : `${completion.percent}%`}</span>
        </Ring>
        <dl className="grid flex-1 grid-cols-1 gap-1.5 text-sm">
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">已正式送出</dt>
            <dd className="font-semibold tabular-nums" data-testid="completion-rate">
              {completion.done}／{completion.required}
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">逾期未繳</dt>
            <dd className={cn('font-semibold tabular-nums', completion.overdue > 0 && 'text-destructive')}>{completion.overdue}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">未繳（還沒截止）</dt>
            <dd className="font-semibold tabular-nums">{completion.pending}</dd>
          </div>
        </dl>
      </div>
      <div className="px-5 pb-4">
        <SegmentBar
          segments={[
            { value: completion.done, tone: 'success', label: '已繳' },
            { value: completion.overdue, tone: 'destructive', label: '逾期' },
            { value: completion.pending, tone: 'muted', label: '未繳' },
          ]}
        />
        <p className="mt-3 text-xs text-muted-foreground tabular-nums">
          不計入：免填 {completion.exempt} {unit}・已移出 {completion.removed} {unit}
        </p>
      </div>
    </Panel>
  )
}
