import Link from 'next/link'
import type { ReactNode } from 'react'
import { cn } from '@/shared/cn'

/**
 * 共用元件基底（票 #47：按鈕、表格、對話框殼、磚）。
 *
 * 這些都是**沒有狀態的 server component**：本票刻意不放任何互動與表單，
 * 後面的功能票各自在上面加行為。視覺沿用 prototype 的 token，但收斂成系網橘單一主軸。
 */

// ── 按鈕 ────────────────────────────────────────────────────────────────────

type ButtonVariant = 'primary' | 'secondary' | 'ghost'

const BUTTON_BASE =
  'inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium ' +
  'transition-colors disabled:pointer-events-none disabled:opacity-50'

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-primary-foreground hover:bg-primary/90',
  secondary: 'bg-muted text-foreground hover:bg-border',
  ghost: 'text-ink hover:bg-muted',
}

export function Button({
  variant = 'primary',
  className,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button className={cn(BUTTON_BASE, BUTTON_VARIANTS[variant], className)} {...props}>
      {children}
    </button>
  )
}

/** 看起來像按鈕的連結。導覽用連結、送出用按鈕——不要用 button 做導覽。 */
export function LinkButton({
  href,
  variant = 'primary',
  className,
  children,
}: {
  href: string
  variant?: ButtonVariant
  className?: string
  children: ReactNode
}) {
  return (
    <Link href={href} className={cn(BUTTON_BASE, BUTTON_VARIANTS[variant], className)}>
      {children}
    </Link>
  )
}

// ── 磚（數字卡） ────────────────────────────────────────────────────────────

export function Tile({
  label,
  value,
  hint,
}: {
  label: string
  value: ReactNode
  hint?: string
}) {
  return (
    <div className="rounded-card border border-border bg-surface p-4">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-ink tabular-nums">{value}</div>
      {hint ? <div className="mt-1 text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  )
}

// ── 區塊卡 ──────────────────────────────────────────────────────────────────

export function Card({
  title,
  description,
  children,
  className,
}: {
  title?: string
  description?: string
  children?: ReactNode
  className?: string
}) {
  return (
    <section className={cn('rounded-card border border-border bg-background p-5', className)}>
      {title ? <h2 className="text-base font-semibold text-ink">{title}</h2> : null}
      {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      {children ? <div className={cn(title || description ? 'mt-4' : '')}>{children}</div> : null}
    </section>
  )
}

// ── 空狀態 ──────────────────────────────────────────────────────────────────

/**
 * 空狀態（票 #47：每一頁都要有）。
 *
 * 刻意分成「現在是什麼情況」與「下一步做什麼」兩段：只寫「沒有資料」對使用者沒有幫助。
 * 功能還沒做的頁面用 `pending` 說清楚，**不拿假資料冒充已完成**。
 */
export function EmptyState({
  title,
  description,
  action,
  pending = false,
}: {
  title: string
  description: string
  action?: { href: string; label: string }
  pending?: boolean
}) {
  return (
    <div className="rounded-card border border-dashed border-border bg-surface px-6 py-10 text-center">
      {pending ? (
        <span className="mb-3 inline-block rounded-full bg-primary-subtle px-3 py-1 text-xs font-medium text-primary-on-subtle">
          這個功能還沒做
        </span>
      ) : null}
      <h3 className="text-base font-medium text-ink">{title}</h3>
      <p className="mx-auto mt-2 max-w-prose text-sm text-muted-foreground">{description}</p>
      {action ? (
        <div className="mt-4">
          <LinkButton href={action.href} variant="secondary">
            {action.label}
          </LinkButton>
        </div>
      ) : null}
    </div>
  )
}

// ── 表格 ────────────────────────────────────────────────────────────────────

/**
 * 表格殼。窄螢幕時**只有表格自己**可以橫向捲動，頁面本體不會跟著橫向捲。
 */
export function DataTable({
  columns,
  rows,
  empty,
}: {
  columns: readonly string[]
  rows: readonly (readonly ReactNode[])[]
  empty: string
}) {
  return (
    <div className="overflow-x-auto rounded-card border border-border">
      <table className="w-full min-w-[32rem] border-collapse text-sm">
        <thead className="bg-muted text-left text-muted-foreground">
          <tr>
            {columns.map((column) => (
              <th key={column} scope="col" className="px-4 py-2 font-medium">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-4 py-8 text-center text-muted-foreground">
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((row, index) => (
              <tr key={index} className="border-t border-border">
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex} className="px-4 py-2">
                    {cell}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}

// ── 對話框殼 ────────────────────────────────────────────────────────────────

/**
 * 對話框殼（票 #47 的「對話框殼」）。
 *
 * 用原生 `<dialog>` 而不是拉一個對話框套件進來：本票只需要「殼」，
 * 原生元素自己就有 modal、Esc 關閉與焦點鎖。開關的行為由後面的功能票各自加。
 */
export function DialogShell({
  id,
  title,
  description,
  children,
  footer,
}: {
  id: string
  title: string
  description?: string
  children?: ReactNode
  footer?: ReactNode
}) {
  return (
    <dialog
      id={id}
      className="w-[min(32rem,calc(100vw-2rem))] rounded-card border border-border bg-background p-0 backdrop:bg-ink/40"
    >
      <div className="p-5">
        <h2 className="text-base font-semibold text-ink">{title}</h2>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
        {children ? <div className="mt-4">{children}</div> : null}
      </div>
      {footer ? <div className="flex justify-end gap-2 border-t border-border p-4">{footer}</div> : null}
    </dialog>
  )
}

// ── 頁首 ────────────────────────────────────────────────────────────────────

export function PageHeader({ title, description }: { title: string; description?: string }) {
  return (
    <header className="mb-6">
      <h1 className="text-xl font-semibold text-ink">{title}</h1>
      {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
    </header>
  )
}
