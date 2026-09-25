import Link from 'next/link'
import type { ReactNode } from 'react'
import { IconArrowLeft, IconArrowRight } from '@tabler/icons-react'
import { buttonVariants } from '@/app/_ui/ui/button'
import { cn } from '@/shared/cn'

/**
 * 後台頁面零件（票 35 新增；原型 `components/dashboard/primitives.tsx`＋`charts.tsx` 的對應）。
 *
 * 不改 `_ui/primitives.tsx`（其他頁共用、別的票也在動）；這裡是**另外**的一組，照原型的名字：
 * Panel（一區一白卡，標題列＋內容）、PageTitle、Pill、ProgressBar、Ring、SegmentBar、BackLink，
 * 以及原型的按鈕與輸入框 class。全部沒有狀態，server／client 元件都能用。
 *
 * 圖表一律用 SVG 屬性畫比例，不用 `style="width:…"`：正式站 CSP 只放 nonce，伺服器輸出的 style 屬性會被擋。
 */

// ── 原型的按鈕與輸入框 ─────────────────────────────────────────────────────

/** 原型 `btn-fju h-9 rounded-lg px-4 text-sm`：系網橘實心。 */
export const BTN_PRIMARY = 'btn-fju press h-9 rounded-lg px-4 text-sm disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4'
/** 原型 `buttonVariants({ variant: "outline", size: "lg" })`：白底細框。 */
export const BTN_OUTLINE = buttonVariants({ variant: 'outline', size: 'lg', className: 'press rounded-lg px-3 font-semibold' })
/** 小一號的外框鈕（列表列尾的「收件」「編輯」）。 */
export const BTN_OUTLINE_SM = buttonVariants({ variant: 'outline', size: 'sm', className: 'press rounded-lg font-semibold' })
/** 圖示小鈕（上移、下移、刪除）。 */
export const BTN_ICON =
  'inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-30 [&_svg]:size-4'
/** 原型編輯器的輸入框。 */
export const INPUT =
  'h-10 w-full rounded-lg border border-input bg-background px-3 text-sm font-normal outline-none transition-[border-color,box-shadow] focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary/25 disabled:opacity-60'
export const TEXTAREA =
  'w-full rounded-lg border border-input bg-background px-3 py-2 text-sm font-normal leading-relaxed outline-none transition-[border-color,box-shadow] focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary/25'
/** 標籤在上、欄位在下（原型 `flex flex-col gap-1.5 text-sm font-semibold`）。 */
export const FIELD_LABEL = 'flex flex-col gap-1.5 text-sm font-semibold'
/** 篩選 pill（原型「種類」那一排）。 */
export function pillClass(active: boolean) {
  return cn(
    'press inline-flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-sm font-semibold transition-colors',
    active ? 'border-primary bg-primary text-primary-foreground' : 'border-border text-foreground hover:border-primary/40 hover:bg-accent',
  )
}
/** 原生 `<dialog>` 的外觀（原型 DialogContent：圓角、陰影、半透明遮罩）。 */
export const DIALOG =
  'm-auto w-[min(32rem,calc(100vw-2rem))] rounded-xl border border-border bg-popover p-0 text-foreground shadow-xl backdrop:bg-black/40'

// ── 版面 ───────────────────────────────────────────────────────────────────

export function PageTitle({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-[24px] font-extrabold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted-foreground tabular-nums">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}

/** 一個區塊一張白卡：標題列（圖示、名詞標題、一句灰字、右側動作）＋內容。 */
export function Panel({
  title,
  icon,
  description,
  action,
  children,
  className,
  bodyClassName,
  headingId,
  ...rest
}: {
  title: string
  icon?: ReactNode
  description?: ReactNode
  action?: { href: string; label: string } | ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
  headingId?: string
} & Omit<React.HTMLAttributes<HTMLElement>, 'title'>) {
  return (
    <section className={cn('dash-card flex flex-col overflow-hidden', className)} aria-labelledby={headingId} {...rest}>
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
        <div className="flex min-w-0 items-center gap-2">
          {icon ? <span className="shrink-0 text-muted-foreground [&_svg]:size-4" aria-hidden>{icon}</span> : null}
          <h2 id={headingId} className="truncate text-[15px] font-bold">
            {title}
          </h2>
          {description ? <span className="hidden truncate text-xs text-muted-foreground tabular-nums sm:inline">・{description}</span> : null}
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
          (action as ReactNode)
        )}
      </div>
      <div className={cn('flex-1', bodyClassName)}>{children}</div>
    </section>
  )
}

/** 頁首上方「← 專題事務」那種回上一層。 */
export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="inline-flex w-fit items-center gap-1 text-[13px] font-semibold text-muted-foreground transition-colors hover:text-foreground"
    >
      <IconArrowLeft className="size-4" aria-hidden /> {label}
    </Link>
  )
}

// ── 標籤 ───────────────────────────────────────────────────────────────────

export type PillTone = 'default' | 'success' | 'danger' | 'brand'

const PILL: Record<PillTone, string> = {
  default: 'border-border bg-muted text-muted-foreground',
  success: 'border-success/30 bg-success-subtle text-success-on-subtle',
  danger: 'border-destructive/35 bg-destructive-subtle text-destructive-on-subtle',
  brand: 'border-primary/30 bg-primary-subtle text-primary-on-subtle',
}

/** 原型 Pill（shadcn outline badge）：狀態小標籤。 */
export function Pill({ children, tone = 'default', className, ...rest }: { children: ReactNode; tone?: PillTone; className?: string } & React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'inline-flex h-5 w-fit shrink-0 items-center gap-1 rounded-4xl border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap [&_svg]:size-3',
        PILL[tone],
        className,
      )}
      {...rest}
    >
      {children}
    </span>
  )
}

// ── 圖表（純 SVG） ─────────────────────────────────────────────────────────

/** 進度條：完成（橘）＋逾期（紅）兩段。 */
export function ProgressBar({ done, total, overdue = 0, showLabel = true }: { done: number; total: number; overdue?: number; showLabel?: boolean }) {
  const pct = total === 0 ? 0 : (done / total) * 100
  const overduePct = total === 0 ? 0 : (overdue / total) * 100
  return (
    <div className="flex items-center gap-2.5">
      <svg
        viewBox="0 0 100 6"
        preserveAspectRatio="none"
        className="h-1.5 min-w-16 flex-1 overflow-hidden rounded-full"
        role="img"
        aria-label={`完成 ${done}／${total}${overdue ? `，逾期 ${overdue}` : ''}`}
      >
        <rect width="100" height="6" className="fill-muted" />
        <rect width={pct} height="6" className="fill-primary" />
        <rect x={pct} width={overduePct} height="6" className="fill-destructive" />
      </svg>
      {showLabel ? (
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {done}/{total}
        </span>
      ) : null}
    </div>
  )
}

/** 圓環（原型 charts.tsx `Ring`）：`tone` 是進度那一圈的顏色，中間放 children。 */
export function Ring({
  value,
  size = 84,
  stroke = 9,
  tone = 'success',
  label,
  children,
}: {
  value: number
  size?: 64 | 84
  stroke?: number
  tone?: 'success' | 'primary'
  label: string
  children?: ReactNode
}) {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const v = Math.max(0, Math.min(100, value))
  return (
    <div className={cn('relative inline-flex shrink-0 items-center justify-center', size === 84 ? 'size-[84px]' : 'size-16')} role="img" aria-label={label}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className="stroke-muted" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - v / 100)}
          className={cn(tone === 'success' ? 'stroke-success' : 'stroke-primary', v === 0 && 'hidden')}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">{children}</div>
    </div>
  )
}

export type Segment = { value: number; tone: 'success' | 'destructive' | 'muted' | 'primary'; label: string }

const SEGMENT_FILL: Record<Segment['tone'], string> = {
  success: 'fill-success',
  destructive: 'fill-destructive',
  muted: 'fill-muted',
  primary: 'fill-primary',
}

/** 分段長條（已繳／逾期／未繳）。 */
export function SegmentBar({ segments }: { segments: readonly Segment[] }) {
  const total = segments.reduce((a, s) => a + s.value, 0) || 1
  let x = 0
  return (
    <svg
      viewBox="0 0 100 8"
      preserveAspectRatio="none"
      className="h-2 w-full overflow-hidden rounded-full"
      role="img"
      aria-label={segments.map((s) => `${s.label} ${s.value}`).join('，')}
    >
      <rect width="100" height="8" className="fill-muted" />
      {segments.map((s) => {
        const w = (s.value / total) * 100
        const rect = <rect key={s.label} x={x} width={w} height="8" className={SEGMENT_FILL[s.tone]} />
        x += w
        return rect
      })}
    </svg>
  )
}
