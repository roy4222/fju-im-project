import Link from 'next/link'
import type { ReactNode } from 'react'
import { IconArrowRight } from '@tabler/icons-react'
import { cn } from '@/shared/cn'

/**
 * 後台積木（原型 `components/dashboard/primitives.tsx` 與 `charts.tsx` 的 Ring，2026-09-25 票 38 搬進來）。
 *
 * 跟原型的差別只有兩件：
 * - 色名：原型 `primary`＝深藍，正式碼叫 `ink`（見 `globals.css` 檔頭）；原型 `brand`＝橘，正式碼 `brand`／`primary` 都是橘。
 * - 不輸出 `style` 屬性：正式站 CSP（style-src 只放 nonce）會擋伺服器輸出的 style="…"，
 *   所以 Ring 的大小用 class 給、進度用 SVG 屬性畫。
 *
 * 全部沒有狀態、沒有查詢；資料由頁面讀好傳進來。
 */

/** 一個區塊一個白卡（原型 Panel）：標題列（圖示、名詞標題、一行說明、右側動作），下面是內容。 */
export function Panel({
  title,
  icon,
  description,
  action,
  children,
  className,
  bodyClassName,
  headingLevel = 2,
}: {
  title: string
  icon?: ReactNode
  description?: string
  action?: { href: string; label: string } | ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
  headingLevel?: 2 | 3
}) {
  const Heading = headingLevel === 3 ? 'h3' : 'h2'
  return (
    <section className={cn('dash-card flex flex-col overflow-hidden', className)}>
      <div className="flex items-center justify-between gap-3 px-5 py-3.5">
        <div className="flex min-w-0 items-center gap-2">
          {icon ? <span className="shrink-0 text-muted-foreground [&_svg]:size-4">{icon}</span> : null}
          <Heading className="truncate text-[15px] font-bold">{title}</Heading>
          {description ? <span className="hidden truncate text-xs text-muted-foreground sm:inline">・{description}</span> : null}
        </div>
        {action && typeof action === 'object' && 'href' in action ? (
          <Link
            href={action.href}
            className="inline-flex shrink-0 items-center gap-1 text-[13px] font-semibold text-muted-foreground transition-colors hover:text-foreground"
          >
            {action.label}
            <IconArrowRight className="size-3.5" />
          </Link>
        ) : (
          action
        )}
      </div>
      <div className={cn('flex-1', bodyClassName)}>{children}</div>
    </section>
  )
}

const PILL_TONE = {
  default: 'border-border bg-muted text-muted-foreground',
  success: 'border-success/30 bg-success-subtle text-success-on-subtle',
  warning: 'border-border bg-muted text-foreground',
  danger: 'border-destructive/35 bg-destructive-subtle text-destructive-on-subtle',
  info: 'border-border bg-muted text-foreground',
  brand: 'border-brand/30 bg-brand-subtle text-brand-on-subtle',
} as const

/** 狀態小標籤（原型 Pill）。 */
export function Pill({ children, tone = 'default', className }: { children: ReactNode; tone?: keyof typeof PILL_TONE; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 rounded-4xl border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap',
        PILL_TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}

/** 頁標題（原型 PageTitle）：24px 特粗、一行灰字說明，右邊可以放動作。 */
export function PageTitle({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-[24px] font-extrabold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  )
}

/** 卡片裡的空狀態（原型 dashboard EmptyState）：一個淡圖示、一句粗體、一行灰字。 */
export function PanelEmpty({ title, hint, icon, action }: { title: string; hint?: string; icon?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
      {icon ? (
        <div className="text-muted-foreground/50 [&_svg]:size-7" aria-hidden>
          {icon}
        </div>
      ) : null}
      <p className="text-sm font-semibold">{title}</p>
      {hint ? <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">{hint}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  )
}

/**
 * 環形進度（原型 charts Ring）。`size` 是 SVG 的邊長（px）；外框大小請用 `className` 給同樣的尺寸（例如 64 → `size-16`），
 * 不用 style 屬性（CSP）。
 */
export function Ring({
  value,
  size = 64,
  stroke = 7,
  color = 'var(--ink)',
  track = 'var(--muted)',
  children,
  className,
  label,
}: {
  value: number
  size?: number
  stroke?: number
  color?: string
  track?: string
  children?: ReactNode
  className?: string
  /** 報讀用的說明；沒給就讀百分比。 */
  label?: string
}) {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const v = Math.max(0, Math.min(100, value))
  return (
    <div className={cn('relative inline-flex shrink-0 items-center justify-center', className)} role="img" aria-label={label ?? `${Math.round(v)}%`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track} strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - v / 100)}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">{children}</div>
    </div>
  )
}
