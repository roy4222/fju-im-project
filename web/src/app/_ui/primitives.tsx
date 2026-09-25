import Link from 'next/link'
import type { ReactNode } from 'react'
import { cn } from '@/shared/cn'

/**
 * 共用元件基底（票 #47：按鈕、表格、對話框殼、磚）。
 *
 * 這些都是**沒有狀態的 server component**：本票刻意不放任何互動與表單，
 * 後面的功能票各自在上面加行為。
 *
 * 外觀照原型（2026-09-25 對齊）：後台卡片＝原型 `dashboard/primitives` 的 Panel／StatTile
 * （白卡、18px 圓角、細邊、無陰影），按鈕＝系網橘實心／白底細框，空狀態＝虛線框一句話。
 * API 不變，所有頁面跟著換樣子。
 */

// ── 按鈕 ────────────────────────────────────────────────────────────────────

type ButtonVariant = 'primary' | 'secondary' | 'ghost'

const BUTTON_BASE =
  'press inline-flex min-h-9 items-center justify-center gap-2 rounded-lg px-4 py-1.5 text-sm font-semibold ' +
  'transition-colors duration-200 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0'

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  // 原型的 btn-fju：系網橘實心，hover 稍亮。
  primary: 'bg-primary text-primary-foreground hover:bg-[oklch(0.7_0.16_55)]',
  // 原型後台的次要動作：白底細框，hover 淡藍底。
  secondary: 'border border-border bg-card text-foreground hover:bg-accent',
  ghost: 'text-foreground hover:bg-accent',
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
  href,
  active = false,
}: {
  label: string
  value: ReactNode
  hint?: string
  /** 有給就整塊是連結（例如點「已停用」就篩出已停用的帳號）。 */
  href?: string
  active?: boolean
}) {
  // 原型 StatTile：白卡、小字標籤、黑色大數字、底下一行說明。
  const body = (
    <>
      <div className="text-[13px] font-medium text-muted-foreground">{label}</div>
      <div className="mt-3 text-[28px] leading-none font-extrabold tracking-tight text-foreground tabular-nums">{value}</div>
      {hint ? <div className="mt-3 text-xs text-muted-foreground">{hint}</div> : null}
    </>
  )
  const base = 'dash-card block p-5'
  if (!href) return <div className={base}>{body}</div>
  return (
    <Link
      href={href}
      aria-current={active ? 'true' : undefined}
      className={cn(base, 'dash-card-hover', active ? 'border-primary ring-1 ring-primary' : '')}
    >
      {body}
    </Link>
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
  // 原型 Panel：一個區塊一個白卡，標題是名詞、15px 粗體，說明一行灰字。
  return (
    <section className={cn('dash-card p-5', className)}>
      {title ? <h2 className="text-[15px] font-bold text-foreground">{title}</h2> : null}
      {description ? <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{description}</p> : null}
      {children ? <div className={cn(title || description ? 'mt-4' : '')}>{children}</div> : null}
    </section>
  )
}

// ── 登入／註冊卡 ────────────────────────────────────────────────────────────

/**
 * 登入、註冊、改密這類單卡頁面的卡片（原型 `public/auth-card.tsx`）。放在 `NarrowShell` 裡。
 * 標題是這一頁的 h1。
 */
export function AuthCard({
  title,
  description,
  children,
}: {
  title?: string
  description?: string
  children?: ReactNode
}) {
  return (
    <div className="flex w-full flex-col gap-5 rounded-xl border border-border bg-card p-6 sm:p-9">
      {title || description ? (
        <div className="flex flex-col gap-1.5">
          {title ? <h1 className="text-[26px] leading-tight font-extrabold text-foreground">{title}</h1> : null}
          {description ? <p className="text-sm leading-relaxed text-muted-foreground">{description}</p> : null}
        </div>
      ) : null}
      {children ? <div>{children}</div> : null}
    </div>
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
    // 原型 QuietState：虛線框、一句粗體、一行灰字，不放插畫。
    <div className="flex min-h-[160px] flex-col items-center justify-center rounded-[14px] border-[1.5px] border-dashed border-border px-6 py-10 text-center">
      {pending ? (
        <span className="mb-3 inline-block rounded-full bg-primary-subtle px-3 py-1 text-xs font-semibold text-primary-on-subtle">
          這個功能還沒做
        </span>
      ) : null}
      <h3 className="text-[15px] font-bold text-foreground">{title}</h3>
      <p className="mx-auto mt-1.5 max-w-prose text-[13px] leading-relaxed text-muted-foreground">{description}</p>
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
    // 原型 data-table：白卡裡的表格，表頭淡灰小字，列之間細線，hover 淡藍底。
    <div className="dash-card overflow-x-auto">
      <table className="w-full min-w-[32rem] border-collapse text-sm">
        <thead className="text-left text-[12px] text-muted-foreground">
          <tr className="border-b border-border">
            {columns.map((column) => (
              <th key={column} scope="col" className="px-4 py-2.5 font-semibold whitespace-nowrap">
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
              <tr key={index} className="border-t border-border/70 transition-colors first:border-t-0 hover:bg-accent/40">
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex} className="px-4 py-3">
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
      className="w-[min(32rem,calc(100vw-2rem))] rounded-xl border border-border bg-popover p-0 shadow-xl backdrop:bg-ink/40"
    >
      <div className="p-5">
        <h2 className="text-base font-bold text-foreground">{title}</h2>
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
    // 原型 PageTitle：24px 特粗、一行灰字說明。
    <header className="mb-6">
      <h1 className="text-[24px] leading-tight font-extrabold tracking-tight text-foreground">{title}</h1>
      {description ? <p className="mt-1.5 text-sm text-muted-foreground">{description}</p> : null}
    </header>
  )
}
