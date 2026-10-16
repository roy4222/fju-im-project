import Link from 'next/link'
import type { AdvisorMatrix, AdvisorMatrixCell, AdvisorMatrixItem } from '@/application/submissions'
import { cohortLabel } from '@/composition/cohorts'
import { GROUP_TYPE_LABEL } from '@/composition/groups'
import { categoryOf, receiverStatus } from '@/composition/submissions'
import { cn } from '@/shared/cn'
import { formatTaipeiMinute, isDeadlinePassed } from '@/shared/time'

/**
 * 老師作業區「各組繳交」的卡片格（TE-04；取代原本的 client DataTable 矩陣）。
 *
 * 每組一張卡（`matrix-row-{組號}`，沿用矩陣的 testId），卡內每份整組作業一個小方塊（`matrix-cell`，連到那一組的收件頁）。
 * 狀態字跟學生作業區、系辦名單頁同一個 `receiverStatus`（已繳第 N 次／未繳／逾期未繳…），老師看不到共用草稿，
 * 沒交一律是「未繳」。只多一種顏色：已交、但最後一次是截止後才交的（系辦開放補交）＝「逾期補交」。
 * 顏色只是輔助：方塊的 `aria-label`／`title` 與卡底那行文字都寫全名＋狀態字。
 */

/** 方塊的顏色分類：已繳綠、逾期補交琥珀、逾期未繳紅、還沒截止的未繳（含尚未開放）灰；免繳與已移出是虛線。 */
export type CellKind = 'submitted' | 'late' | 'overdue' | 'open' | 'inactive'

export type GroupCardCell = {
  readonly itemId: string
  readonly title: string
  /** 方塊裡的短名（作業名的前兩個字）。 */
  readonly short: string
  readonly kind: CellKind
  /** 狀態字（「已繳第 2 次」「未繳」「逾期未繳」「逾期補交（已繳第 1 次）」…）。 */
  readonly status: string
  /** 補充一句（誰、何時送出；尚未開放的開放時間）。 */
  readonly detail: string
  /** 不在這份作業的名單上就沒有連結（也不算 `matrix-cell`）。 */
  readonly href: string | null
}

export type GroupCard = {
  readonly groupId: string
  readonly code: string
  readonly meta: string
  readonly members: string
  readonly cells: readonly GroupCardCell[]
  /** 卡底的「已交 done／required」：只算目前名單（不含免繳、已移出、不在名單）。 */
  readonly done: number
  readonly required: number
}

/**
 * 方塊裡的短名：作業名的前兩個字（用 code point 切，不會把字切半）。
 * 同一屆幾份作業開頭撞名時（「專題說明會…」「專題分組…」），跳過跟撞名者共同的開頭，取接下來兩個字（「說明」「分組」）。
 */
export function shortNames(titles: readonly string[]): string[] {
  const chars = titles.map((t) => Array.from(t.trim()))
  return chars.map((mine, i) => {
    const head = mine.slice(0, 2).join('')
    let shared = 0
    chars.forEach((other, j) => {
      if (j === i || other.slice(0, 2).join('') !== head) return
      let n = 0
      while (n < mine.length && n < other.length && mine[n] === other[n]) n += 1
      shared = Math.max(shared, n)
    })
    if (shared === 0) return head
    const rest = mine.slice(shared, shared + 2)
    return rest.length > 0 ? rest.join('') : mine.slice(-2).join('')
  })
}

/** 一格的顏色與狀態字（純函式：同一組事實、同一個業務時間，一定得到同一個結果）。 */
export function cellOf(item: AdvisorMatrixItem, short: string, groupId: string, cell: AdvisorMatrixCell | undefined, businessNow: Date): GroupCardCell {
  const base = { itemId: item.itemId, title: item.title, short }
  if (!cell) return { ...base, kind: 'inactive', status: '不在名單', detail: '', href: null }
  const href = `/dashboard/teacher/affairs/${item.itemId}?group=${groupId}`
  const category = categoryOf(cell)
  const status = receiverStatus(item, { exempt: cell.exempt, hasDraft: false, latestVersionNo: cell.latestVersionNo, reopenUntil: cell.reopenUntil }, businessNow)
  if (category === 'removed') return { ...base, kind: 'inactive', status: '已不需要繳交（原名單移除）', detail: '', href }
  if (category === 'exempt') return { ...base, kind: 'inactive', status: status.headline, detail: '', href }
  if (cell.latestVersionNo !== null) {
    const detail = cell.latestReceivedAt ? `${cell.latestSubmittedByName ?? ''}・${formatTaipeiMinute(cell.latestReceivedAt)}` : ''
    // 跟收件的截止判定同一個規則：截止分鐘含這一分鐘（17:00 截止、17:00:30 送出仍準時）。
    const late = item.dueAt !== null && cell.latestReceivedAt !== null && isDeadlinePassed(cell.latestReceivedAt, item.dueAt)
    return late
      ? { ...base, kind: 'late', status: `逾期補交（${status.headline}）`, detail, href }
      : { ...base, kind: 'submitted', status: status.headline, detail, href }
  }
  if (status.overdue) return { ...base, kind: 'overdue', status: status.headline, detail: '', href }
  // 還沒截止、尚未開放、或系辦開放補交中：都是灰色「未繳」，補一句開放時間或補交期限。
  return { ...base, kind: 'open', status: status.headline, detail: status.detail === '進行中' ? '' : status.detail, href }
}

/** 整個卡片格的資料：只列老師此刻指導的組；欄只放那一組所在屆別的作業（別屆的作業不屬於這一組）。 */
export function buildGroupCards(matrix: AdvisorMatrix, businessNow: Date): GroupCard[] {
  const cellByKey = new Map(matrix.cells.map((c) => [`${c.groupId}:${c.itemId}`, c]))
  const itemsOf = (cohortId: string) => matrix.items.filter((item) => item.cohortId === cohortId)
  return matrix.groups.map((group) => {
    const items = itemsOf(group.cohortId)
    const shorts = shortNames(items.map((item) => item.title))
    const cells = items.map((item, i) => cellOf(item, shorts[i]!, group.groupId, cellByKey.get(`${group.groupId}:${item.itemId}`), businessNow))
    const counted = cells.filter((c) => c.kind !== 'inactive')
    return {
      groupId: group.groupId,
      code: group.code,
      meta: `${cohortLabel({ name: group.cohortName, code: group.cohortCode })}・${GROUP_TYPE_LABEL[group.groupType]}`,
      members: group.memberNames.join('、'),
      cells,
      done: counted.filter((c) => c.kind === 'submitted' || c.kind === 'late').length,
      required: counted.length,
    }
  })
}

const KIND_CLASS: Record<CellKind, string> = {
  submitted: 'border-success/40 bg-success-subtle text-success-on-subtle',
  late: 'border-warning/60 bg-warning-subtle text-warning-on-subtle',
  overdue: 'border-destructive/40 bg-destructive-subtle text-destructive-on-subtle',
  open: 'border-border bg-muted text-muted-foreground',
  inactive: 'border-dashed border-border bg-background text-muted-foreground',
}

const LEGEND: readonly { kind: CellKind; label: string }[] = [
  { kind: 'submitted', label: '已繳' },
  { kind: 'open', label: '未繳（還沒截止）' },
  { kind: 'overdue', label: '逾期未繳' },
  { kind: 'late', label: '逾期補交' },
  { kind: 'inactive', label: '免繳／不在名單' },
]

const CELL_BOX = 'inline-flex h-11 min-w-11 items-center justify-center rounded-md border px-1.5 text-xs font-semibold'

export function GroupCards({ cards }: { cards: readonly GroupCard[] }) {
  return (
    <div className="flex flex-col gap-3 p-4">
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="方塊顏色">
        {LEGEND.map((l) => (
          <li key={l.kind} className="inline-flex items-center gap-1.5">
            <span aria-hidden className={cn('inline-block size-3 rounded-sm border', KIND_CLASS[l.kind])} />
            {l.label}
          </li>
        ))}
      </ul>
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {cards.map((card) => (
          <li key={card.groupId} data-testid={`matrix-row-${card.code}`} className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-card p-4">
            <div className="min-w-0">
              <p className="flex flex-wrap items-baseline gap-x-2">
                <span className="tabular text-[15px] font-bold text-foreground">{card.code}</span>
                <span className="text-xs text-muted-foreground">{card.meta}</span>
              </p>
              <p className="mt-0.5 truncate text-xs text-muted-foreground" title={card.members}>
                {card.members || '（目前沒有組員）'}
              </p>
            </div>
            {card.cells.length > 0 ? (
              <ul className="flex flex-wrap gap-1.5">
                {card.cells.map((cell) => {
                  const label = `${cell.title}・${cell.status}`
                  const title = cell.detail ? `${label}（${cell.detail}）` : label
                  return (
                    <li key={cell.itemId}>
                      {cell.href ? (
                        <Link href={cell.href} data-testid="matrix-cell" aria-label={label} title={title} className={cn(CELL_BOX, 'transition-opacity hover:opacity-80', KIND_CLASS[cell.kind])}>
                          {cell.short}
                        </Link>
                      ) : (
                        <span role="img" aria-label={label} title={title} className={cn(CELL_BOX, KIND_CLASS[cell.kind])}>
                          {cell.short}
                        </span>
                      )}
                    </li>
                  )
                })}
              </ul>
            ) : null}
            {card.cells.length > 0 ? (
              <div className="mt-auto border-t border-border pt-2 text-xs">
                <p className="tabular font-semibold text-foreground">
                  已交 {card.done}／{card.required}
                </p>
                <ul className="mt-1 flex flex-col gap-0.5 text-muted-foreground">
                  {card.cells.map((cell) => (
                    <li key={cell.itemId} className="flex min-w-0 items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate" title={cell.title}>
                        {cell.title}
                      </span>
                      <span className={cn('shrink-0', cell.kind === 'overdue' && 'text-destructive-on-subtle', cell.kind === 'late' && 'text-warning-on-subtle')}> {cell.status}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="mt-auto border-t border-border pt-2 text-xs text-muted-foreground">這一屆還沒有整組一份的作業。</p>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
