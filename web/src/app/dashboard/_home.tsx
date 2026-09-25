import Link from 'next/link'
import type { ReactNode } from 'react'
import { IconArrowRight, IconChevronRight } from '@tabler/icons-react'
import { cn } from '@/shared/cn'

/**
 * 三角色首頁的積木（2026-09-25 對齊原型 `dashboard/primitives` 與 `home-widgets`）。
 *
 * 全部是 server component、只畫資料，資料由各首頁經 composition 讀好傳進來——這裡沒有查詢。
 * 圖表用 SVG 屬性畫（正式站 CSP 不收 style 屬性），不引圖表套件。
 * 顏色克制：數字黑字；橘只給主要動作與「要你動手」；紅只給逾期。
 */

// ── 區塊卡 ──────────────────────────────────────────────────────────────────

/** 原型 Panel：白卡、標題列（名詞標題・一行灰字說明，右邊一個連結）、內容。 */
export function Panel({
  title,
  description,
  action,
  tint,
  className,
  children,
  testId,
}: {
  title: string
  description?: string
  action?: { href: string; label: string } | ReactNode
  /** 只有原型用色塊卡的地方才給（行事曆 sky、可認領 mint、同意書 lilac）。 */
  tint?: 'sky' | 'mint' | 'lilac'
  className?: string
  children: ReactNode
  testId?: string
}) {
  return (
    <section className={cn('dash-card flex flex-col overflow-hidden', tint && `tint tint-${tint}`, className)} data-testid={testId}>
      <div className="flex items-center justify-between gap-3 px-5 py-3.5">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="truncate text-[15px] font-bold text-foreground">{title}</h2>
          {description ? <span className="hidden truncate text-xs text-muted-foreground sm:inline">・{description}</span> : null}
        </div>
        {action && typeof action === 'object' && 'href' in action ? (
          <Link
            href={action.href}
            className="inline-flex shrink-0 items-center gap-1 text-[13px] font-semibold text-muted-foreground transition-colors hover:text-foreground"
          >
            {action.label}
            <IconArrowRight className="size-3.5" aria-hidden />
          </Link>
        ) : (
          action
        )}
      </div>
      <div className="flex-1">{children}</div>
    </section>
  )
}

/** 區塊裡沒東西時的一句話（不放插畫）。 */
export function PanelEmpty({ children }: { children: ReactNode }) {
  return <p className="px-5 pb-5 text-sm text-muted-foreground">{children}</p>
}

// ── 需要處理 ────────────────────────────────────────────────────────────────

const ACTION_TONE = {
  default: 'bg-muted text-foreground',
  brand: 'bg-primary-subtle text-primary-on-subtle',
  danger: 'bg-destructive-subtle text-destructive-on-subtle',
} as const

/**
 * 「需要處理」一列（原型 ActionRow）：圖示方塊、名稱與一行說明、數字、一顆「去處理」。
 * 整列是連結；數字是 0 的列由呼叫端決定要不要放（首頁只放有事的）。
 */
export function ActionRow({
  icon,
  label,
  detail,
  count,
  href,
  cta = '查看',
  tone = 'default',
}: {
  icon: ReactNode
  label: string
  detail?: string
  count: number
  href: string
  cta?: string
  tone?: keyof typeof ACTION_TONE
}) {
  return (
    <li>
      <Link href={href} className="group flex items-center gap-3.5 border-t border-border/70 px-5 py-3 transition-colors hover:bg-accent/50">
        <span aria-hidden className={cn('inline-flex size-[34px] shrink-0 items-center justify-center rounded-[10px] [&_svg]:size-4', ACTION_TONE[tone])}>
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-foreground">{label}</span>
          {detail ? <span className="block truncate text-xs text-muted-foreground">{detail}</span> : null}
        </span>
        <span className={cn('text-lg font-bold tabular-nums', tone === 'danger' ? 'text-destructive' : 'text-foreground')}>{count}</span>
        <span className="rounded-md bg-accent px-2.5 py-1.5 text-xs font-bold text-foreground transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
          {cta}
        </span>
      </Link>
    </li>
  )
}

// ── 小圖表 ──────────────────────────────────────────────────────────────────

/** 甜甜圈（原型 Donut）：每段是一個 stroke-dasharray 圓弧。全部是 0 時只畫底圈。 */
export function Donut({
  segments,
  center,
  label,
  size = 116,
}: {
  segments: readonly { value: number; color: string }[]
  center: ReactNode
  label: string
  size?: number
}) {
  const r = 40
  const c = 2 * Math.PI * r
  const total = segments.reduce((a, s) => a + s.value, 0)
  let offset = 0
  return (
    <div className="relative shrink-0" role="img" aria-label={label}>
      <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden>
        <circle cx="50" cy="50" r={r} fill="none" stroke="var(--muted)" strokeWidth="13" />
        {total > 0
          ? segments.map((s, i) => {
              const len = (s.value / total) * c
              const el = (
                <circle
                  key={i}
                  cx="50"
                  cy="50"
                  r={r}
                  fill="none"
                  stroke={s.color}
                  strokeWidth="13"
                  strokeDasharray={`${len} ${c - len}`}
                  strokeDashoffset={-offset}
                  transform="rotate(-90 50 50)"
                />
              )
              offset += len
              return s.value > 0 ? el : null
            })
          : null}
      </svg>
      <div className="absolute inset-0 flex items-center justify-center text-center">{center}</div>
    </div>
  )
}

/** 橫條（原型 SegmentBar／評分進度）：寬度用 SVG 百分比屬性。 */
export function Meter({ value, total, done = false, className }: { value: number; total: number; done?: boolean; className?: string }) {
  const pct = total === 0 ? 0 : Math.round((value / total) * 100)
  return (
    <svg className={cn('block h-2 w-full', className)} role="img" aria-label={`${value}／${total}`}>
      <rect width="100%" height="100%" rx="4" fill="var(--muted)" />
      {pct > 0 ? <rect width={`${pct}%`} height="100%" rx="4" fill={done ? 'var(--success)' : 'var(--primary)'} /> : null}
    </svg>
  )
}

/** 圖例一列：色點、名稱、數字。 */
export function LegendRow({ color, label, value, href }: { color: string; label: string; value: number; href?: string }) {
  return (
    <li className="flex items-center justify-between gap-3">
      <span className="inline-flex items-center gap-2">
        {/* 色點用 SVG 的 fill，不用 style 屬性（CSP）。 */}
        <svg viewBox="0 0 10 10" className="size-2.5 shrink-0" aria-hidden>
          <rect width="10" height="10" rx="2" fill={color} />
        </svg>
        {href ? (
          <Link href={href} className="hover:underline">
            {label}
          </Link>
        ) : (
          label
        )}
      </span>
      <b className="tabular-nums">{value}</b>
    </li>
  )
}

/** 一列可點的清單項（原型 grading／groups 列）：左邊代號、中間標題、右邊狀態或按鈕。 */
export function ListRow({
  href,
  code,
  title,
  sub,
  trailing,
}: {
  href?: string
  code?: string
  title: string
  sub?: string
  trailing?: ReactNode
}) {
  const body = (
    <>
      {code ? <span className="w-16 shrink-0 truncate text-xs font-semibold text-muted-foreground tabular-nums">{code}</span> : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-foreground">{title}</span>
        {sub ? <span className="block truncate text-xs text-muted-foreground">{sub}</span> : null}
      </span>
      {trailing}
      {href ? <IconChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden /> : null}
    </>
  )
  return (
    <li>
      {href ? (
        <Link href={href} className="flex min-h-11 items-center gap-3 border-t border-border/70 px-5 py-2.5 transition-colors hover:bg-accent/40">
          {body}
        </Link>
      ) : (
        <div className="flex min-h-11 items-center gap-3 border-t border-border/70 px-5 py-2.5">{body}</div>
      )}
    </li>
  )
}

const PILL_TONE = {
  default: 'border-border bg-muted text-muted-foreground',
  brand: 'border-primary/30 bg-primary-subtle text-primary-on-subtle',
  success: 'border-success/30 bg-success-subtle text-success-on-subtle',
  danger: 'border-destructive/35 bg-destructive-subtle text-destructive-on-subtle',
} as const

/** 狀態小膠囊（原型 Pill）。 */
export function Pill({ children, tone = 'default' }: { children: ReactNode; tone?: keyof typeof PILL_TONE }) {
  return (
    <span className={cn('inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap', PILL_TONE[tone])}>
      {children}
    </span>
  )
}
