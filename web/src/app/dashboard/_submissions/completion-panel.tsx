import type { Completion } from '@/application/submissions'
import { cn } from '@/shared/cn'

/**
 * 收件進度（完成率）面板：管理員名單頁（票 18／21）與老師的收件頁（票 22）共用。
 * 分子分母由 application 的 `completionOf` 算，這裡只畫；整組一份的單位是「組」（同組五人誰送都只算一份）。
 */

/** 收件進度環：只用系網橘一個主軸色；分母 0 時不畫比例、顯示「—」。 */
function Ring({ percent }: { percent: number | null }) {
  const r = 36
  const c = 2 * Math.PI * r
  const shown = percent ?? 0
  return (
    <svg viewBox="0 0 88 88" className="size-[5.5rem] shrink-0" role="img" aria-label={percent === null ? '沒有應交的人' : `完成 ${percent}%`}>
      <circle cx="44" cy="44" r={r} fill="none" stroke="var(--color-muted)" strokeWidth="9" />
      <circle
        cx="44"
        cy="44"
        r={r}
        fill="none"
        stroke="var(--color-primary)"
        strokeWidth="9"
        strokeLinecap="round"
        strokeDasharray={`${(shown / 100) * c} ${c}`}
        transform="rotate(-90 44 44)"
      />
      <text x="44" y="49" textAnchor="middle" className="fill-ink text-[15px] font-bold tabular-nums">
        {percent === null ? '—' : `${percent}%`}
      </text>
    </svg>
  )
}

export function CompletionPanel({ completion, individual }: { completion: Completion; individual: boolean }) {
  // 整組一份的單位是「組」：同組五人誰送都只算這一組一份（產品模組 05 §4「組別完成率以符合資格的組別為單位」）。
  const unit = individual ? '人' : '組'
  const rows: [string, number, string?][] = [
    ['已正式送出', completion.done],
    ['未繳（還沒截止）', completion.pending],
    ['逾期未繳', completion.overdue, completion.overdue > 0 ? 'text-danger-on-subtle' : undefined],
  ]
  return (
    <section aria-labelledby="progress-title" className="rounded-card border border-border bg-background p-5" data-testid="completion">
      <h2 id="progress-title" className="text-base font-semibold text-ink">
        收件進度
      </h2>
      <div className="mt-3 flex items-center gap-5">
        <Ring percent={completion.percent} />
        <div className="min-w-0 flex-1">
          <p className="text-2xl font-semibold text-ink tabular-nums" data-testid="completion-rate">
            {completion.done}／{completion.required}
          </p>
          <p className="text-xs text-muted-foreground">已正式送出／應交{individual ? '人數' : '組數'}</p>
        </div>
      </div>
      <dl className="mt-4 grid gap-1.5 text-sm">
        {rows.map(([label, value, tone]) => (
          <div key={label} className="flex justify-between">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className={cn('font-semibold tabular-nums', tone)}>{value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground tabular-nums">
        不計入：免填 {completion.exempt} {unit}・已移出 {completion.removed} {unit}
      </p>
    </section>
  )
}

