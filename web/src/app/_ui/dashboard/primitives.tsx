import Link from 'next/link'
import type { ReactNode } from 'react'
import { IconArrowRight, IconX } from '@tabler/icons-react'
import { Badge } from '@/app/_ui/ui/badge'
import { cn } from '@/shared/cn'

/**
 * 後台頁面的基本元件（原型 `components/dashboard/primitives.tsx` v2 的同名元件；票 36 搬進正式碼）。
 *
 * - 一個區塊一個容器（`dash-card`），容器內用 1px 分隔線，不做卡中卡、不加陰影。
 * - 顏色克制：數字一律黑；橘色只給主要動作與目前選取；紅／綠只給狀態。
 * - 全部是沒有狀態的 server component；**不用 `style` 屬性**（正式站 CSP 的 `style-src` 只放 nonce）。
 *
 * 舊的 `_ui/primitives.tsx`（Card、Tile、PageHeader…）保留給還沒換版型的頁面，這裡是新增、不取代。
 */

/** 頁標題：24px 特粗，一行灰字說明，右邊放主要動作。 */
export function PageTitle({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    // 桌面：標題與說明在左、動作固定在右（說明再長也不把按鈕擠到下一行）；手機：動作排在說明下面。
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0 flex-1">
        <h1 className="text-[24px] leading-tight font-extrabold tracking-tight text-foreground">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}

/** 區塊：白卡、標題列（圖示＋名詞標題＋一句灰字＋右側動作），內容直接貼齊卡片邊。 */
export function Panel({
  title,
  icon,
  description,
  action,
  children,
  className,
  bodyClassName,
  headingLevel = 2,
  ...rest
}: {
  title: ReactNode
  icon?: ReactNode
  description?: ReactNode
  action?: { href: string; label: string } | ReactNode
  children?: ReactNode
  className?: string
  bodyClassName?: string
  headingLevel?: 2 | 3
} & Omit<React.HTMLAttributes<HTMLElement>, 'title'>) {
  const Heading = headingLevel === 3 ? 'h3' : 'h2'
  return (
    <section className={cn('dash-card flex min-w-0 flex-col overflow-hidden', className)} {...rest}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-5 py-3.5">
        <div className="flex min-w-0 items-center gap-2">
          {icon ? <span className="shrink-0 text-muted-foreground [&_svg]:size-4">{icon}</span> : null}
          <Heading className="truncate text-[15px] font-bold text-foreground">{title}</Heading>
          {description ? <span className="hidden truncate text-xs text-muted-foreground sm:inline">・{description}</span> : null}
        </div>
        {action && typeof action === 'object' && 'href' in action && 'label' in action ? (
          <Link
            href={(action as { href: string }).href}
            className="inline-flex shrink-0 items-center gap-1 text-[13px] font-semibold text-muted-foreground transition-colors hover:text-foreground"
          >
            {(action as { label: string }).label}
            <IconArrowRight className="size-3.5" />
          </Link>
        ) : (
          (action as ReactNode)
        )}
      </div>
      <div className={cn('min-w-0 flex-1', bodyClassName)}>{children}</div>
    </section>
  )
}

type Tone = 'default' | 'success' | 'warning' | 'danger' | 'info' | 'brand'

const STAT_CHIP: Record<Tone, string> = {
  default: 'bg-muted text-foreground',
  warning: 'bg-muted text-foreground',
  danger: 'bg-destructive-subtle text-destructive-on-subtle',
  success: 'bg-muted text-foreground',
  brand: 'bg-brand text-brand-foreground',
  info: 'bg-muted text-foreground',
}

/** 統計磚：白卡、右上圖示方塊、黑色大數字、底下一行說明與右下小圖。 */
export function StatTile({
  label,
  value,
  unit,
  hint,
  chart,
  tone = 'default',
  href,
  icon,
  active = false,
}: {
  label: string
  value: ReactNode
  unit?: string
  hint?: ReactNode
  chart?: ReactNode
  tone?: Tone
  href?: string
  icon?: ReactNode
  active?: boolean
}) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-medium text-muted-foreground">{label}</span>
        {icon ? (
          <span className={cn('inline-flex size-8 shrink-0 items-center justify-center rounded-[9px] [&_svg]:size-4', STAT_CHIP[tone])}>{icon}</span>
        ) : null}
      </div>
      <p className="tabular mt-3.5 text-[30px] leading-none font-extrabold tracking-tight text-foreground">
        {value}
        {unit ? <span className="ml-1 text-[13px] font-medium text-muted-foreground">{unit}</span> : null}
      </p>
      <div className="mt-3.5 flex items-end justify-between gap-3">
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          {hint ? <span className="truncate">{hint}</span> : null}
        </div>
        {chart ? <div className={cn('shrink-0', tone === 'danger' ? 'text-destructive' : 'text-brand')}>{chart}</div> : null}
      </div>
    </>
  )
  const cls = 'dash-card block p-5'
  if (!href) return <div className={cls}>{body}</div>
  return (
    <Link href={href} aria-current={active ? 'true' : undefined} className={cn(cls, 'dash-card-hover', active && 'border-brand ring-1 ring-brand')}>
      {body}
    </Link>
  )
}

const PILL: Record<Tone, string> = {
  default: 'border-border bg-muted text-muted-foreground',
  success: 'border-success/30 bg-success-subtle text-success-on-subtle',
  warning: 'border-border bg-muted text-foreground',
  danger: 'border-destructive/35 bg-destructive-subtle text-destructive-on-subtle',
  info: 'border-border bg-muted text-foreground',
  brand: 'border-brand/30 bg-brand-subtle text-brand-on-subtle',
}

/** 狀態標籤：小圓角框、11px。 */
export function Pill({ children, tone = 'default', className, ...rest }: { children: ReactNode; tone?: Tone; className?: string } & React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <Badge variant="outline" className={cn('shrink-0 text-[11px]', PILL[tone], className)} {...rest}>
      {children}
    </Badge>
  )
}

/** 沒事時的占位：虛線框、一句粗體、一行灰字，不放插畫。 */
export function QuietState({ title, hint, action }: { title: string; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex min-h-[160px] flex-col items-center justify-center gap-1.5 rounded-[14px] border-[1.5px] border-dashed border-border px-6 py-8 text-center">
      <p className="text-[15px] font-bold text-foreground">{title}</p>
      {hint ? <p className="max-w-prose text-xs leading-relaxed text-muted-foreground">{hint}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  )
}

/** 區塊內的空狀態（沒有虛線框，給 Panel 裡用）。 */
export function PanelEmpty({ title, hint, action }: { title: string; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
      <p className="text-sm font-semibold text-foreground">{title}</p>
      {hint ? <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">{hint}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  )
}

/** 篩選標籤（從數字磚帶條件進來時顯示，可移除）。 */
export function FilterTag({ label, count, clearHref }: { label: ReactNode; count?: ReactNode; clearHref: string }) {
  return (
    <span className="inline-flex h-9 items-center gap-2 rounded-full border border-brand bg-brand-subtle pr-1.5 pl-3.5 text-sm font-semibold text-brand-on-subtle">
      篩選：{label} {count ? <span className="tabular">{count}</span> : null}
      <Link
        href={clearHref}
        className="inline-flex size-6 items-center justify-center rounded-full transition-colors hover:bg-brand hover:text-brand-foreground"
        aria-label="移除篩選"
      >
        <IconX className="size-3.5" />
      </Link>
    </span>
  )
}

/** 屆別切換（原型沒有；多屆並存時才出現）：跟原型的選取樣式一致的膠囊。 */
export function CohortPills({ cohorts, currentId, hrefFor }: { cohorts: readonly { id: string; code: string }[]; currentId: string; hrefFor: (id: string) => string }) {
  if (cohorts.length <= 1) return null
  return (
    // 屆別多的時候（測試站累積很多）不換行、在框內橫向捲，不把頁面往下推。
    <nav aria-label="選擇屆別" className="inline-flex max-w-full gap-1 self-start overflow-x-auto rounded-xl border border-border bg-card p-1">
      {cohorts.map((c) => (
        <Link
          key={c.id}
          href={hrefFor(c.id)}
          aria-current={c.id === currentId ? 'page' : undefined}
          className={cn(
            'tabular inline-flex h-8 shrink-0 items-center rounded-lg px-3 text-sm font-semibold whitespace-nowrap transition-colors',
            c.id === currentId ? 'bg-ink text-ink-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
        >
          {c.code}
        </Link>
      ))}
    </nav>
  )
}

/** 原型後台表格的小表頭列：淡灰底、12px 灰字（Panel 裡直接貼邊的表格用）。 */
export const PANEL_TABLE_HEAD = 'border-t border-border/70 bg-muted/40 text-left text-[12px] text-muted-foreground'
export const PANEL_TABLE_ROW = 'border-t border-border/70 transition-colors hover:[&>td]:bg-accent/40'
