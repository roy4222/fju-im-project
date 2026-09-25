'use client'
import Link from 'next/link'
import { useState } from 'react'
import { IconClipboardText, IconExternalLink, IconSearch } from '@tabler/icons-react'
import { BTN_OUTLINE_SM, Panel, Pill, pillClass } from '@/app/_ui/dashboard-kit'
import { cn } from '@/shared/cn'

/**
 * 專題事務工作台的「全部內容」卡（票 35；原型 `affairs/admin-affairs.tsx`）。
 *
 * 種類篩選照舊是網址參數（伺服器篩好再傳進來）；搜尋框只在已經載入的列裡找標題與對象，不另外查資料庫。
 * 桌面是八欄格線、手機每列自動堆疊成卡片（原型同一套 class）。
 */

export type AffairRow = {
  id: string
  kind: string
  title: string
  status: 'draft' | 'published' | 'archived'
  statusLabel: string
  visibility: string
  audience: string
  date: string
  /** 截止日已過（紅字）。 */
  overdue: boolean
  isDue: boolean
  /** 收件名單連結的字（「應交 2 位（個人一份）」）；不是收件或還是草稿時是說明文字。 */
  roster: { text: string; href: string | null } | null
  publicHref: string | null
  editHref: string
}

const GRID = 'md:grid-cols-[6.5rem_minmax(0,1fr)_5rem_7rem_9rem_8.5rem_10rem_7rem]'

export function AffairsList({
  rows,
  filters,
  emptyText,
}: {
  rows: readonly AffairRow[]
  filters: readonly { key: string; label: string; href: string; active: boolean }[]
  emptyText: string
}) {
  const [q, setQ] = useState('')
  const query = q.trim().toLowerCase()
  const shown = rows.filter((r) => !query || r.title.toLowerCase().includes(query) || r.audience.toLowerCase().includes(query))

  const tools = (
    <div className="flex flex-wrap items-center gap-2">
      <label className="relative block max-sm:w-full">
        <span className="sr-only">搜尋標題或對象</span>
        <IconSearch aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜尋標題、對象"
          className="h-9 w-48 rounded-lg border border-input bg-background pr-3 pl-8 text-sm outline-none transition-[border-color,box-shadow] focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary/25 max-sm:w-full"
        />
      </label>
      <nav aria-label="種類" className="flex flex-wrap gap-1">
        {filters.map((f) => (
          <Link key={f.key} href={f.href} aria-current={f.active ? 'page' : undefined} className={pillClass(f.active)}>
            {f.label}
          </Link>
        ))}
      </nav>
    </div>
  )

  return (
    <Panel title="全部內容" icon={<IconClipboardText />} action={<div className="hidden sm:block">{tools}</div>}>
      <div className="border-t border-border px-5 py-3 sm:hidden">{tools}</div>
      <div
        className={cn('hidden gap-3 border-t border-border px-5 py-2 text-xs font-semibold text-muted-foreground md:grid', GRID)}
        aria-hidden
      >
        <span>種類</span>
        <span>標題</span>
        <span>狀態</span>
        <span>可見範圍</span>
        <span>對象</span>
        <span>截止／發布</span>
        <span>收件名單</span>
        <span />
      </div>
      <ul className="divide-y divide-border border-t border-border md:border-t-0">
        {shown.map((r) => (
          <li
            key={r.id}
            data-testid="affair-row"
            className={cn('grid items-center gap-x-3 gap-y-1.5 px-5 py-3 transition-colors hover:bg-accent/40', GRID)}
          >
            <span className="text-xs font-semibold text-muted-foreground md:text-sm">{r.kind}</span>
            <div className="min-w-0">
              <Link href={r.editHref} className="link-ink block truncate text-[15px] font-bold">
                {r.title}
              </Link>
              {r.publicHref ? (
                <Link href={r.publicHref} className="inline-flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground">
                  前台頁面 <IconExternalLink aria-hidden className="size-3" />
                </Link>
              ) : null}
            </div>
            <span>
              <Pill tone={r.status === 'published' ? 'success' : 'default'}>{r.statusLabel}</Pill>
            </span>
            <span className="text-xs text-muted-foreground md:text-sm">{r.visibility}</span>
            <span className="truncate text-xs text-muted-foreground md:text-sm">{r.audience}</span>
            <span
              className={cn(
                'text-xs tabular-nums md:text-sm',
                r.isDue ? (r.overdue ? 'font-semibold text-destructive' : 'font-semibold') : 'text-muted-foreground',
              )}
            >
              {r.date}
            </span>
            <span className="text-xs tabular-nums md:text-sm">
              {r.roster ? (
                r.roster.href ? (
                  <Link href={r.roster.href} className="font-semibold text-primary-on-subtle hover:underline">
                    {r.roster.text}
                  </Link>
                ) : (
                  <span className="text-muted-foreground">{r.roster.text}</span>
                )
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </span>
            <span className="flex gap-1.5 md:justify-end">
              {r.roster?.href ? (
                <Link href={r.roster.href} className={BTN_OUTLINE_SM} aria-label={`收件：${r.title}`}>
                  收件
                </Link>
              ) : null}
              <Link href={r.editHref} className={BTN_OUTLINE_SM} aria-label={`編輯：${r.title}`}>
                編輯
              </Link>
            </span>
          </li>
        ))}
      </ul>
      {shown.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
          <p className="text-sm font-semibold">{query ? `沒有符合「${q}」的內容` : emptyText}</p>
        </div>
      ) : null}
    </Panel>
  )
}
