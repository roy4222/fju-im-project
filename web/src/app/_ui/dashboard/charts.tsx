import type { ReactNode } from 'react'
import { cn } from '@/shared/cn'

/**
 * 後台小圖表（原型 `charts.tsx`／`rc-charts.tsx` 的樣子），純 SVG、不載圖表庫。
 *
 * **全部用 SVG 屬性表達尺寸，不用 `style`**：正式站 CSP 的 `style-src` 只放 nonce，
 * 伺服器輸出的 `style="width:…"` 會被瀏覽器擋掉（dev 模式看不出來）。
 * 寬度用 SVG 的百分比屬性（`width="42%"`），圓角用 px 的 `rx`，所以不會被拉扁。
 * 顏色用 Tailwind 的 `fill-*`／`stroke-*` class，跟著淺深色 token 走。
 */

const clamp = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0)
const pct = (value: number, total: number) => (total > 0 ? clamp((value / total) * 100) : 0)

/** 環形進度（完成率）。`children` 疊在正中間。 */
export function Ring({
  value,
  size = 64,
  stroke = 7,
  className,
  trackClassName = 'stroke-muted',
  // 原型 Ring 預設 var(--primary)＝系網深藍，正式碼叫 ink。
  barClassName = 'stroke-ink',
  label,
  decorative = false,
  children,
}: {
  /** 0–100 */
  value: number
  size?: number
  stroke?: number
  className?: string
  trackClassName?: string
  barClassName?: string
  label?: string
  /** 旁邊已經有同樣的數字（例如放在連結裡）：圓環只是裝飾，不給讀螢幕念。 */
  decorative?: boolean
  children?: ReactNode
}) {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const v = clamp(value)
  return (
    <span
      className={cn('relative inline-flex shrink-0 items-center justify-center', className)}
      {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label ?? `${Math.round(v)}%` })}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className={trackClassName} />
          {v > 0 ? (
            <circle
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeDasharray={c}
              strokeDashoffset={c * (1 - v / 100)}
              className={barClassName}
            />
          ) : null}
        </g>
      </svg>
      {children ? <span className="absolute inset-0 flex items-center justify-center">{children}</span> : null}
    </span>
  )
}

/** 橫向比較列：左標籤、中間長條、右數字（原型 `HBar`）。 */
export function HBar({ label, value, total, suffix, barClassName = 'fill-foreground' }: { label: ReactNode; value: number; total: number; suffix?: ReactNode; barClassName?: string }) {
  const p = pct(value, total)
  return (
    <div className="flex items-center gap-3">
      <span className="w-20 shrink-0 truncate text-sm">{label}</span>
      <svg width="100%" height="8" className="min-w-0 flex-1" aria-hidden>
        <rect width="100%" height="8" rx="4" className="fill-muted" />
        {p > 0 ? <rect width={`${p}%`} height="8" rx="4" className={barClassName} /> : null}
      </svg>
      <span className="tabular w-24 shrink-0 text-right text-xs whitespace-nowrap text-muted-foreground">{suffix ?? `${value}/${total}`}</span>
    </div>
  )
}

/** 水平堆疊：完成（橘）／逾期（紅）／其餘（底色）。原型 `StackedRows`。 */
export function StackedRows({ rows }: { rows: readonly { label: ReactNode; done: number; overdue?: number; total: number; key?: string }[] }) {
  return (
    <ul className="flex flex-col gap-3.5">
      {rows.map((r, i) => {
        const done = pct(r.done, r.total)
        const overdue = Math.min(100 - done, pct(r.overdue ?? 0, r.total))
        return (
          <li key={r.key ?? i}>
            <div className="mb-1.5 flex items-center justify-between gap-3 text-sm">
              <span className="truncate font-semibold">{r.label}</span>
              <span className="tabular shrink-0 text-xs text-muted-foreground">
                {r.done}/{r.total}
              </span>
            </div>
            <svg width="100%" height="10" className="block" role="img" aria-label={`${r.done}/${r.total}`}>
              <rect width="100%" height="10" rx="5" className="fill-muted" />
              {overdue > 0 ? <rect x={`${done}%`} width={`${overdue}%`} height="10" className="fill-destructive" /> : null}
              {done > 0 ? <rect width={`${done}%`} height="10" rx="5" className="fill-brand" /> : null}
            </svg>
          </li>
        )
      })}
    </ul>
  )
}

/** 甜甜圈（原型 recharts 的 `Donut`，這裡用 SVG 畫）：每段一個顏色 class，中間放大數字。 */
export function Donut({
  data,
  size = 150,
  thickness = 20,
  center,
  label,
}: {
  data: readonly { name: string; value: number; className: string }[]
  size?: number
  thickness?: number
  center?: ReactNode
  label?: string
}) {
  const r = (size - thickness) / 2
  const c = 2 * Math.PI * r
  const total = data.reduce((a, d) => a + Math.max(0, d.value), 0)
  // 段與段之間留一點縫（原型 paddingAngle=2）；只有一段時不留。
  const nonZero = data.filter((d) => d.value > 0).length
  const gap = nonZero > 1 ? Math.min(4, c / 90) : 0
  let offset = 0
  return (
    <span className="relative inline-flex shrink-0" role="img" aria-label={label ?? data.map((d) => `${d.name} ${d.value}`).join('，')}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          {total === 0 ? (
            <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={thickness} className="stroke-muted" />
          ) : (
            data.map((d) => {
              if (d.value <= 0) return null
              const len = (d.value / total) * c
              const seg = (
                <circle
                  key={d.name}
                  cx={size / 2}
                  cy={size / 2}
                  r={r}
                  fill="none"
                  strokeWidth={thickness}
                  strokeDasharray={`${Math.max(0, len - gap)} ${c}`}
                  strokeDashoffset={-offset}
                  className={d.className}
                />
              )
              offset += len
              return seg
            })
          )}
        </g>
      </svg>
      {center ? <span className="pointer-events-none absolute inset-0 flex items-center justify-center">{center}</span> : null}
    </span>
  )
}

/** 直式長條（原型 recharts 的 `Bars`）：達標的那幾根橘色，其他淡色；底下是標籤。 */
export function Bars({ data, height = 150 }: { data: readonly { label: string; value: number; hot?: boolean }[]; height?: number }) {
  const max = Math.max(1, ...data.map((d) => d.value))
  const n = Math.max(1, data.length)
  const slot = 100 / n
  const barW = slot * 0.6
  const chartH = height - 22
  const ticks = [0, Math.round(max / 2), max].filter((v, i, a) => a.indexOf(v) === i)
  return (
    <div className="w-full" role="img" aria-label={data.map((d) => `${d.label} ${d.value}`).join('，')}>
      <div className="flex">
        <svg width="28" height={chartH} className="shrink-0 overflow-visible" aria-hidden>
          {ticks.map((t) => (
            <text key={t} x="22" y={chartH - (t / max) * (chartH - 8) + 4} textAnchor="end" className="fill-muted-foreground text-[11px]">
              {t}
            </text>
          ))}
        </svg>
        <svg width="100%" height={chartH} className="min-w-0 flex-1" aria-hidden>
          {data.map((d, i) => {
            const h = Math.max(4, (d.value / max) * (chartH - 8))
            return (
              <rect
                key={`${d.label}-${i}`}
                x={`${i * slot + (slot - barW) / 2}%`}
                y={chartH - h}
                width={`${barW}%`}
                height={h}
                rx="8"
                className={d.hot ? 'fill-brand' : 'fill-ink opacity-30'}
              />
            )
          })}
        </svg>
      </div>
      <div className="ml-7 flex">
        {data.map((d, i) => (
          <span key={`${d.label}-${i}`} className="min-w-0 flex-1 truncate px-0.5 pt-1.5 text-center text-[11px] text-muted-foreground">
            {d.label}
          </span>
        ))}
      </div>
    </div>
  )
}

/** 逐人小格：每格一位（學生），右邊短格是老師。原型簽核「各組進度」。 */
export function SegmentCells({ cells, trailing, label }: { cells: readonly string[]; trailing?: string; label: string }) {
  return (
    <span className="flex min-w-0 gap-0.5" role="img" aria-label={label}>
      {cells.map((cls, i) => (
        <span key={i} className={cn('h-3 min-w-2 flex-1 rounded-sm', cls)} />
      ))}
      {trailing ? <span className={cn('ml-1.5 h-3 w-8 shrink-0 rounded-sm', trailing)} /> : null}
    </span>
  )
}
