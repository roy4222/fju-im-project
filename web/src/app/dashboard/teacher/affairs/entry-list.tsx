import Link from 'next/link'
import { IconUser } from '@tabler/icons-react'
import { OUTLINE_BUTTON_SM, Panel } from '@/app/dashboard/teacher/_ui/dash'
import type { AdvisorIndividualItem } from '@/application/submissions'
import { formatTaipeiMinute } from '@/shared/time'

/**
 * 系辦開了主指導閱覽的個人作業（`individual-items`；放在各組卡片格下方）。
 * 沒開的個人作業老師看不到（產品模組 05 §4），一份都沒有就整塊不出現。
 */
export function EntryList({ items }: { items: readonly AdvisorIndividualItem[] }) {
  if (items.length === 0) return null
  return (
    <Panel title="開放指導老師閱覽的個人作業" icon={<IconUser />} description="只看得到你指導的學生正式送出的回答，草稿不給">
      <ul className="divide-y divide-border" data-testid="individual-items">
        {items.map((item) => (
          <li key={item.itemId} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 transition-colors hover:bg-accent/40">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-foreground">{item.title}</span>
              <span className="tabular block text-xs text-muted-foreground">
                {item.dueAt ? `${formatTaipeiMinute(item.dueAt)} 截止` : '無截止'}・欄位第 {item.effectiveFromVersionNo} 版起開放
              </span>
            </span>
            <span className="tabular text-sm font-semibold">
              已繳 {item.submitted}／{item.required} 位
            </span>
            <Link href={`/dashboard/teacher/affairs/${item.itemId}`} className={OUTLINE_BUTTON_SM}>
              查看
            </Link>
          </li>
        ))}
      </ul>
    </Panel>
  )
}
