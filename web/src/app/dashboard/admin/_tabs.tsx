import type { ReactNode } from 'react'
import Link from 'next/link'
import { cn } from '@/shared/cn'

/**
 * 系辦頁內分頁列（設計方案 §2）：側欄一項底下的幾個既有路由之間的連結，不是把內容合併到一頁。
 * 每個分頁仍是自己的 Server Component、自己的 `requireRole`、自己的查詢；這裡只畫連結。
 *
 * - 由每一頁明傳 `current`（那一頁自己的 `href`）標 `aria-current="page"`，不用 `headers()` 猜路徑。
 * - `actions` 是那一頁的主要動作（最多兩個），放在分頁列右側，不算分頁。
 * - 深層頁（`/affairs/[id]`、`/editor/*`、`/grading/[groupId]`……）不放分頁列（AC-AD-29）。
 */
export function AdminTabs({
  label,
  current,
  items,
  actions,
}: {
  label: string
  current: string
  items: readonly { href: string; label: string }[]
  actions?: ReactNode
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-x-4 gap-y-2 border-b border-border">
      <nav aria-label={label} className="-mb-px flex max-w-full gap-1 overflow-x-auto">
        {items.map((item) => {
          const active = item.href === current
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'inline-flex min-h-11 shrink-0 items-center border-b-2 px-3 text-sm transition-colors duration-150',
                active ? 'border-primary font-bold text-ink' : 'border-transparent font-semibold text-muted-foreground hover:border-border hover:text-ink',
              )}
            >
              {item.label}
            </Link>
          )
        })}
      </nav>
      {actions ? <div className="flex flex-wrap items-center gap-2 pb-2">{actions}</div> : null}
    </div>
  )
}
