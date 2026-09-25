import Link from 'next/link'
import type { ReactNode } from 'react'
import { IconArrowDown, IconArrowUp, IconChevronLeft, IconChevronRight, IconSearch, IconSelector, IconX } from '@tabler/icons-react'
import { buttonVariants } from '@/app/_ui/ui/button'
import { cn } from '@/shared/cn'

/**
 * 原型 Data Table（`components/data-table/data-table.tsx`，MOC §10.3）的**外觀**，套在正式碼的伺服器篩選上。
 *
 * 原型是 tanstack 的前端表格（資料全在瀏覽器、前端篩選排序）；正式碼的帳號、分組、成績是
 * **伺服器算的**：篩選、排序、分頁都在網址上。所以這裡只搬樣子——工具列（搜尋框、篩選鈕、清除條件）、
 * 圓角框＋淡灰黏頂表頭、排序箭頭、底下「共 N 筆／第 x／y 頁」——資料流不變。
 *
 * 篩選下拉鈕在 `data-table-facet.tsx`（要開關，是 client component）。
 */

/** 工具列：搜尋、篩選鈕、清除條件、右側動作，一排可換行。 */
export function DataTableToolbar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex flex-wrap items-center gap-2', className)}>{children}</div>
}

/**
 * 搜尋框（原型：左邊放大鏡、h-9、桌面 18rem）。放在一張 GET 表單裡，按 Enter 就送出；
 * 其他目前的條件用 `hidden` 帶著（呼叫端給），所以搜尋不會把已選的篩選洗掉。
 */
export function SearchForm({
  action,
  name = 'q',
  defaultValue,
  placeholder,
  maxLength,
  hidden,
  label,
  className,
}: {
  action: string
  name?: string
  defaultValue?: string
  placeholder: string
  maxLength?: number
  hidden?: Record<string, string | null | undefined>
  /** 表單的名字（給讀螢幕與測試）；預設用 placeholder。 */
  label?: string
  className?: string
}) {
  return (
    <form method="get" action={action} role="search" aria-label={label ?? placeholder} className={cn('relative w-full sm:w-72', className)}>
      {Object.entries(hidden ?? {}).map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null))}
      <IconSearch className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <input
        type="search"
        name={name}
        defaultValue={defaultValue}
        placeholder={placeholder}
        maxLength={maxLength}
        aria-label={placeholder}
        className="h-9 w-full min-w-0 rounded-lg border border-input bg-transparent py-1 pr-2.5 pl-8 text-sm transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      />
    </form>
  )
}

/** 「清除條件」（原型：ghost 按鈕、左邊一個 ×）。 */
export function ClearFilters({ href, label = '清除條件' }: { href: string; label?: string }) {
  return (
    <Link href={href} className={buttonVariants({ variant: 'ghost', size: 'lg', className: 'gap-1' })}>
      <IconX className="size-4" /> {label}
    </Link>
  )
}

/** 批次動作列：只在有勾選時出現（原型：橘色細框、淡橘底）。 */
export function BulkBar({ children, className, ...rest }: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('flex flex-wrap items-center gap-2 rounded-lg border border-ink/25 bg-ink/5 px-3 py-2', className)} {...rest}>
      {children}
    </div>
  )
}

/** 表格外框：圓角細框，太高就在框內捲動、表頭黏在上面；太寬就整張表在框內橫向捲動。 */
export function DataTableFrame({ children, className, maxHeight = true }: { children: ReactNode; className?: string; maxHeight?: boolean }) {
  return (
    <div className={cn('relative rounded-lg border border-border', className)}>
      <div className={cn('overflow-auto', maxHeight && 'max-h-[32rem]')}>{children}</div>
    </div>
  )
}

/** 表格本體與各部位的 class（照原型 shadcn Table：列高、表頭灰底、列 hover）。 */
export const DT = {
  table: 'w-full caption-bottom text-sm',
  thead: 'sticky top-0 z-10 bg-muted [&_tr]:border-b',
  th: 'h-10 px-2 text-left align-middle font-medium whitespace-nowrap text-foreground first:pl-3 [&:has([role=checkbox])]:pr-0',
  tr: 'border-b border-border last:border-0 [&>td]:transition-colors hover:[&>td]:bg-muted/40 data-[state=selected]:[&>td]:bg-muted',
  td: 'p-2 align-middle first:pl-3 [&:has([role=checkbox])]:pr-0',
  empty: 'h-40 text-center',
} as const

/** 表頭的排序連結：目前排序顯示上／下箭頭，其他欄顯示淡色的上下箭頭。 */
export function SortLink({ label, href, active, ariaLabel }: { label: string; href: string; active: 'asc' | 'desc' | null; ariaLabel?: string }) {
  return (
    <Link
      href={href}
      aria-label={ariaLabel}
      className="inline-flex items-center gap-1 rounded font-medium hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      {label}
      {active === 'asc' ? (
        <IconArrowUp className="size-3.5" aria-hidden />
      ) : active === 'desc' ? (
        <IconArrowDown className="size-3.5" aria-hidden />
      ) : (
        <IconSelector className="size-3.5 opacity-50" aria-hidden />
      )}
    </Link>
  )
}

/** 空狀態列（「沒有符合條件」與「本來就沒有」由呼叫端決定文字）。 */
export function EmptyRow({ colSpan, title, hint, action }: { colSpan: number; title: string; hint?: ReactNode; action?: ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className={DT.empty}>
        {/* 表格很寬（手機要橫向捲）時，說明文字黏在看得到的那一段，不跟著置中到畫面外。 */}
        <div className="sticky left-0 w-[min(100%,calc(100vw-5rem))] space-y-1 px-4">
          <p className="text-sm font-medium text-foreground">{title}</p>
          {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
          {action ? <div className="mt-2">{action}</div> : null}
        </div>
      </td>
    </tr>
  )
}

/** 表格底部：左「共 N 筆」，右「第 x / y 頁」＋上一頁／下一頁（原型的圖示按鈕）。 */
export function Pager({
  total,
  page,
  pages,
  prevHref,
  nextHref,
  extra,
}: {
  total: number
  page: number
  pages: number
  prevHref?: string | null
  nextHref?: string | null
  extra?: ReactNode
}) {
  const icon = buttonVariants({ variant: 'outline', size: 'icon-lg' })
  const disabled = 'pointer-events-none opacity-50'
  return (
    <nav aria-label="分頁" className="flex flex-wrap items-center justify-between gap-3">
      <p className="tabular text-xs text-muted-foreground">
        共 {total} 筆{extra}
      </p>
      <div className="flex items-center gap-2">
        <span className="tabular text-xs text-muted-foreground">
          第 {page} / {pages} 頁
        </span>
        {prevHref ? (
          <Link href={prevHref} className={icon} aria-label="上一頁">
            <IconChevronLeft className="size-4" />
          </Link>
        ) : (
          <span className={cn(icon, disabled)} aria-hidden>
            <IconChevronLeft className="size-4" />
          </span>
        )}
        {nextHref ? (
          <Link href={nextHref} className={icon} aria-label="下一頁">
            <IconChevronRight className="size-4" />
          </Link>
        ) : (
          <span className={cn(icon, disabled)} aria-hidden>
            <IconChevronRight className="size-4" />
          </span>
        )}
      </div>
    </nav>
  )
}
