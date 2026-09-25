import Link from 'next/link'
import type { ReactNode } from 'react'
import { IconArrowLeft, IconArrowRight } from '@tabler/icons-react'
import { Badge } from '@/app/_ui/ui/badge'
import { cn } from '@/shared/cn'

/**
 * 老師後台頁面用的區塊元件（票 37：照原型 `prototype/src/components/dashboard/primitives.tsx`、`charts.tsx`）。
 *
 * 只放在老師的目錄裡：系辦（票 35／36）、學生（票 38）的頁面各自照原型搬，共用的 `_ui/primitives.tsx` 不動，
 * 並行的票才不會互相改到同一個檔。都是沒有狀態的元件，伺服器與瀏覽器兩邊都能用。
 *
 * 色名對照（見 `globals.css` 檔頭）：原型的 `primary`（深藍）在正式碼是 `ink`，原型的 `brand`（橘）＝正式碼 `primary`。
 * 圖表一律用 SVG 屬性畫，不用 `style="…"`：正式站的 CSP 只放 nonce 的 style，伺服器輸出的行內樣式會被擋。
 */

// ── 頁標題 ──────────────────────────────────────────────────────────────────

/** 原型 `PageTitle`：24px 特粗標題、一行灰字說明，右邊放這一頁的主要動作。 */
export function PageTitle({
  title,
  description,
  actions,
  eyebrow,
}: {
  title: string
  description?: ReactNode
  actions?: ReactNode
  /** 標題上面一行小字（原型收件頁的「文件繳交・整組一份」）。 */
  eyebrow?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {eyebrow ? <p className="text-xs font-semibold text-muted-foreground">{eyebrow}</p> : null}
        <h1 className="text-[24px] font-extrabold tracking-tight text-foreground">{title}</h1>
        {description ? <div className="mt-1 text-sm text-muted-foreground">{description}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}

/** 原型子頁頂端的「← 上一層」。 */
export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex w-fit items-center gap-1 text-[13px] font-semibold text-muted-foreground transition-colors hover:text-foreground"
    >
      <IconArrowLeft className="size-4" /> {children}
    </Link>
  )
}

// ── 區塊 ────────────────────────────────────────────────────────────────────

/**
 * 原型 `Panel`：一個區塊一張白卡，標題列＝圖示＋15px 粗體名詞＋「・說明」，右邊一個動作；內容用 1px 分隔線。
 * `<section>` 帶 `aria-label`（預設是標題），在無障礙樹裡就是一個有名字的 region。
 */
export function Panel({
  title,
  icon,
  description,
  action,
  children,
  className,
  bodyClassName,
  label,
  testId,
}: {
  title: string
  icon?: ReactNode
  description?: ReactNode
  action?: { href: string; label: string } | ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
  /** region 的名字；沒給就用標題。 */
  label?: string
  testId?: string
}) {
  return (
    <section aria-label={label ?? title} data-testid={testId} className={cn('dash-card flex min-w-0 flex-col overflow-hidden', className)}>
      <div className="flex items-center justify-between gap-3 px-5 py-3.5">
        <div className="flex min-w-0 items-center gap-2">
          {icon ? <span className="shrink-0 text-muted-foreground [&_svg]:size-4">{icon}</span> : null}
          <h2 className="truncate text-[15px] font-bold text-foreground">{title}</h2>
          {description ? <span className="hidden truncate text-xs text-muted-foreground sm:inline">・{description}</span> : null}
        </div>
        {action && typeof action === 'object' && 'href' in action && 'label' in action ? (
          <Link
            href={action.href as string}
            className="inline-flex shrink-0 items-center gap-1 text-[13px] font-semibold text-muted-foreground transition-colors hover:text-foreground"
          >
            {action.label as string}
            <IconArrowRight className="size-3.5" />
          </Link>
        ) : (
          (action as ReactNode)
        )}
      </div>
      <div className={cn('flex-1', bodyClassName)}>{children}</div>
    </section>
  )
}

/** 原型 `EmptyState`（區塊裡沒東西時）：淡圖示、一句粗體、一行灰字，可以帶一顆動作。 */
export function PanelEmpty({
  icon,
  title,
  hint,
  action,
}: {
  icon?: ReactNode
  title: string
  hint?: ReactNode
  action?: { href: string; label: string }
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
      {icon ? (
        <div className="text-muted-foreground/50 [&_svg]:size-7" aria-hidden>
          {icon}
        </div>
      ) : null}
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {hint ? <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">{hint}</p> : null}
      {action ? (
        <Link href={action.href} className={cn(OUTLINE_BUTTON, 'mt-2')}>
          {action.label}
        </Link>
      ) : null}
    </div>
  )
}

// ── 標籤 ────────────────────────────────────────────────────────────────────

export type PillTone = 'default' | 'success' | 'warning' | 'danger' | 'info' | 'brand'

const PILL_TONE: Record<PillTone, string> = {
  default: 'border-border bg-muted text-muted-foreground',
  success: 'border-success/30 bg-success-subtle text-success-on-subtle',
  warning: 'border-border bg-muted text-foreground',
  danger: 'border-destructive/35 bg-destructive-subtle text-destructive-on-subtle',
  info: 'border-border bg-muted text-foreground',
  brand: 'border-primary/30 bg-primary-subtle text-primary-on-subtle',
}

/** 原型 `Pill`：小圓角外框標籤；顏色只給狀態。 */
export function Pill({ children, tone = 'default', className, testId }: { children: ReactNode; tone?: PillTone; className?: string; testId?: string }) {
  return (
    <Badge variant="outline" data-testid={testId} className={cn('shrink-0 text-[11px]', PILL_TONE[tone], className)}>
      {children}
    </Badge>
  )
}

// ── 按鈕樣式 ────────────────────────────────────────────────────────────────

/** 原型 `buttonVariants({ variant: 'outline', size: 'lg' })`＋`press rounded-lg`。 */
export const OUTLINE_BUTTON =
  'press inline-flex h-9 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-border bg-background px-2.5 text-sm font-medium ' +
  'text-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0'

/** 原型 `buttonVariants({ variant: 'outline', size: 'sm' })`：列裡的小按鈕。 */
export const OUTLINE_BUTTON_SM =
  'press inline-flex h-7 shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-lg border border-border bg-background px-2.5 text-[0.8rem] font-medium ' +
  'text-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-3.5 [&_svg]:shrink-0'

/** 原型 `buttonVariants({ variant: 'ghost', size: 'lg' })`。 */
export const GHOST_BUTTON =
  'press inline-flex h-9 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-sm font-medium text-foreground ' +
  'transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4'

/** 原型 `btn-fju`：系網橘實心的主要動作。 */
export const PRIMARY_BUTTON =
  'btn-fju h-11 rounded-lg px-5 text-sm disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:size-4'

/** 原生 `<dialog>` 的外觀照原型 shadcn Dialog：圓角、細框、淡遮罩。行為（Esc、焦點鎖）還是原生的。 */
export const DIALOG =
  'm-auto w-[min(28rem,calc(100vw-2rem))] rounded-xl bg-popover p-0 text-sm text-popover-foreground ring-1 ring-foreground/10 ' +
  'backdrop:bg-black/10 backdrop:backdrop-blur-xs'

/** 原型表單欄位（`stamp.tsx` 的 INPUT／TEXTAREA）。 */
export const INPUT =
  'h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none transition-[border-color,box-shadow] ' +
  'focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary/25'
export const TEXTAREA =
  'w-full rounded-lg border border-input bg-background px-3 py-2 text-sm font-normal outline-none transition-[border-color,box-shadow] ' +
  'focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary/25'

// ── 收件章 ──────────────────────────────────────────────────────────────────

/** 原型的「收件章」：綠框、-2deg、一次淡入（送出成功的回執）。 */
export function StampMark({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex -rotate-2 items-center gap-1.5 rounded-lg border-2 border-success px-3 py-1.5 text-sm font-extrabold tracking-[0.12em] text-success-on-subtle duration-300 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95">
      {children}
    </span>
  )
}

// ── 小圖表（SVG 屬性，不用行內樣式） ─────────────────────────────────────────

/** 原型 `Ring`：環形進度。`value` 0–100；`null` 不畫比例。 */
export function Ring({
  value,
  size = 64,
  stroke = 7,
  color = 'var(--ink)',
  children,
  label,
}: {
  value: number | null
  size?: number
  stroke?: number
  color?: string
  children?: ReactNode
  label?: string
}) {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const v = Math.max(0, Math.min(100, value ?? 0))
  return (
    <div className="relative inline-flex shrink-0 items-center justify-center" role="img" aria-label={label ?? `${Math.round(v)}%`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--muted)" strokeWidth={stroke} />
        {value === null ? null : (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${(v / 100) * c} ${c}`}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        )}
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">{children}</div>
    </div>
  )
}

/** 原型 `SegmentBar`：分段長條（已繳／逾期／未繳）。用 viewBox 0–100 的 `<rect>` 畫，寬度隨容器伸縮。 */
export function SegmentBar({ segments, height = 8 }: { segments: readonly { value: number; color: string; label: string }[]; height?: number }) {
  const total = segments.reduce((a, s) => a + s.value, 0) || 1
  let x = 0
  return (
    <svg
      viewBox={`0 0 100 ${height}`}
      preserveAspectRatio="none"
      width="100%"
      height={height}
      role="img"
      aria-label={segments.map((s) => `${s.label} ${s.value}`).join('，')}
      className="block overflow-hidden rounded-full"
    >
      <rect x="0" y="0" width="100" height={height} fill="var(--muted)" />
      {segments.map((s) => {
        const w = (s.value / total) * 100
        const rect = <rect key={s.label} x={x} y="0" width={w} height={height} fill={s.color} />
        x += w
        return rect
      })}
    </svg>
  )
}
