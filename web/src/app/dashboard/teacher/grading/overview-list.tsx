import Link from 'next/link'
import type { ReactNode } from 'react'
import { IconFilter } from '@tabler/icons-react'
import type { TeacherQueueEntry } from '@/application/grading'
import { filterQueue } from '@/app/dashboard/teacher/grading/filter'
import type { GradingFilter } from '@/app/dashboard/teacher/grading/overview-types'
import { StageSections } from '@/app/dashboard/teacher/grading/stage-sections'
import { cn } from '@/shared/cn'

/**
 * 評分總覽的清單（TE-06a；C1-12 改成每個評分項目一個區段、每組一列，見 `stage-sections.tsx`）：四個篩選＋各區段。
 *
 * 伺服器元件：篩選（`?filter=`）是 `<Link>`，在伺服器端過濾，沒有瀏覽器端 JS；篩選套到每個區段。
 * B 階段：正式送出後又存了草稿的列加「有未送出修改」、系辦結算的評分項目加「已結算」（設計方案 §1.5、§2.5）。
 */

const FILTERS: readonly { key: GradingFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'pending', label: '待評' },
  { key: 'draft', label: '草稿' },
  { key: 'submitted', label: '已送出' },
]

const BASE = '/dashboard/teacher/grading'

const PILL_LINK =
  'inline-flex h-9 items-center gap-1.5 rounded-full px-4 text-sm font-bold transition-colors duration-150 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ring/40'

/** 「全部」不帶 `?filter=`。 */
function hrefOf(filter: GradingFilter): string {
  return filter === 'all' ? BASE : `${BASE}?filter=${filter}`
}

function PillLink({ href, on, children }: { href: string; on: boolean; children: ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={on ? 'page' : undefined}
      className={cn(PILL_LINK, on ? 'bg-primary text-primary-foreground' : 'bg-card text-muted-foreground ring-1 ring-border hover:text-foreground')}
    >
      {children}
    </Link>
  )
}

export function GradingOverviewList({
  entries,
  filter,
}: {
  /** 本人全部評分項目的指派（還沒篩選）。 */
  entries: readonly TeacherQueueEntry[]
  filter: GradingFilter
}) {
  return (
    <div className="flex flex-col gap-4">
      <nav aria-label="篩選" className="flex flex-wrap items-center gap-2">
        <IconFilter className="size-4 text-muted-foreground" aria-hidden />
        {FILTERS.map((f) => (
          <PillLink key={f.key} href={hrefOf(f.key)} on={f.key === filter}>
            {f.label}
            {/* 數量只給眼睛看；按鈕名稱維持「全部／待評／草稿／已送出」。 */}
            <span aria-hidden className="tabular text-xs opacity-80">
              {filterQueue(entries, f.key).length}
            </span>
          </PillLink>
        ))}
      </nav>
      <StageSections entries={entries} filter={filter} />
    </div>
  )
}
