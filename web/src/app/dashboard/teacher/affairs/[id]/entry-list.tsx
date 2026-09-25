'use client'
import Link from 'next/link'
import { useState } from 'react'
import { IconPaperclip, IconUsersGroup, IconX } from '@tabler/icons-react'
import { OUTLINE_BUTTON_SM, Panel, Pill, type PillTone } from '@/app/dashboard/teacher/_ui/dash'
import { cn } from '@/shared/cn'

/**
 * 老師看一份收件：自己指導的組（或學生）一列一個（票 22；票 37 照原型 `StaffItem` 左欄）。
 * 右上「未繳 N」「逾期 N」只在已經載入的列裡篩，不重新查詢；篩選中顯示可移除的標籤。
 */

export type EntryView = {
  receiverId: string
  label: string
  sub: string
  headline: string
  tone: PillTone
  detail: string
  href: string
  ariaLabel: string
  /** 還沒正式送出（含逾期；不含免填、已移出）。 */
  missing: boolean
  overdue: boolean
}

type Filter = 'missing' | 'overdue' | null
const FILTER_LABEL = { missing: '未繳', overdue: '逾期' } as const

export function EntryList({ title, unit, entries, emptyText }: { title: string; unit: string; entries: EntryView[]; emptyText: string }) {
  const [filter, setFilter] = useState<Filter>(null)
  const missing = entries.filter((e) => e.missing).length
  const overdue = entries.filter((e) => e.overdue).length
  const shown = entries.filter((e) => (filter === 'missing' ? e.missing : filter === 'overdue' ? e.overdue : true))

  return (
    <Panel
      title={title}
      icon={<IconUsersGroup />}
      description={filter ? `${shown.length}／${entries.length} ${unit}` : `${entries.length} ${unit}`}
      action={
        entries.length === 0 ? null : filter ? (
          <button
            type="button"
            onClick={() => setFilter(null)}
            className="inline-flex h-8 items-center gap-1 rounded-full border border-primary/30 bg-primary-subtle px-3 text-xs font-semibold text-primary-on-subtle"
            aria-label={`移除篩選：${FILTER_LABEL[filter]}`}
          >
            {FILTER_LABEL[filter]} {shown.length} {unit} <IconX className="size-3.5" />
          </button>
        ) : (
          <div className="flex gap-1.5">
            {(['missing', 'overdue'] as const).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setFilter(key)}
                className="tabular h-8 rounded-full border border-border px-3 text-xs font-semibold text-muted-foreground transition-colors hover:border-ink/40 hover:text-foreground"
              >
                {FILTER_LABEL[key]} {key === 'missing' ? missing : overdue}
              </button>
            ))}
          </div>
        )
      }
    >
      {entries.length === 0 ? (
        <p className="border-t border-border px-5 py-10 text-center text-sm text-muted-foreground">{emptyText}</p>
      ) : (
        <ul className="divide-y divide-border" aria-label={title}>
          {shown.map((e) => (
            <li key={e.receiverId} data-testid="teacher-entry" className="flex flex-wrap items-center gap-3 px-5 py-3 transition-colors hover:bg-accent/40">
              {e.label ? <span className="tabular w-20 shrink-0 truncate text-xs font-semibold text-muted-foreground">{e.label}</span> : null}
              <span className="min-w-[5rem] flex-1 truncate text-sm font-semibold text-foreground">{e.sub}</span>
              <Pill tone={e.tone}>{e.headline}</Pill>
              <span className={cn('tabular text-xs text-muted-foreground', !e.detail && 'hidden sm:inline')}>{e.detail || '—'}</span>
              <Link href={e.href} className={OUTLINE_BUTTON_SM} aria-label={e.ariaLabel}>
                <IconPaperclip /> 檢視
              </Link>
            </li>
          ))}
          {shown.length === 0 ? (
            <li className="px-5 py-8 text-center text-sm text-muted-foreground">沒有{filter ? FILTER_LABEL[filter] : ''}的{unit === '位' ? '學生' : '組別'}。</li>
          ) : null}
        </ul>
      )}
    </Panel>
  )
}
