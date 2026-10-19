import Link from 'next/link'
import { IconClipboardText } from '@tabler/icons-react'
import { Panel, Pill, ProgressBar } from '@/app/_ui/dashboard-kit'
import { renderActor } from '@/app/_ui/guard'
import { RowActions } from '@/app/dashboard/admin/affairs/_content/list-actions'
import {
  AFFAIRS_TAB_PLACEMENTS,
  audienceText,
  deleteBlockedText,
  progressText,
  responseFactsOf,
  type ResponseFacts,
} from '@/app/dashboard/admin/affairs/affairs-view'
import type { ResolvedActor } from '@/application/accounts'
import { getBusinessClock } from '@/composition/cohorts'
import { getItemQuery, ITEM_STATUS_LABEL } from '@/composition/items'
import { completionOf, getRosterQuery } from '@/composition/submissions'
import { cn } from '@/shared/cn'
import { formatTaipeiMinute, isDeadlinePassed } from '@/shared/time'

/**
 * 公告與作業 › 作業的清單內容（C 階段規格① §4.2、AC-9；②的分頁殼掛這個元件，`{ cohortId, searchParams }`）。
 *
 * 欄：標題（同意書列有「同意書」標籤；點標題進繳交狀況）、對象、截止時間、繳交進度（「3／8 組已交」＋進度條）、編輯／刪除。
 * 右上「新增」下拉在 `list-actions.tsx` 的 `AssignmentListActions`（殼掛在分頁列右邊）。
 *
 * 進度口徑同繳交狀況頁的完成率（`completionOf`：目前名單、不含免繳與已移出、有正式版本才算交）。發布中的一次讀全屆名單事實
 * （`completionFacts`，跟首頁同一個查詢）；已下架的逐份讀名單（份數少，而且刪除鈕要知道有沒有人交過）。
 * 站內同意書的進度看簽核包，畫面在 C1-11（本票只寫名單數）。
 */

const GRID = 'md:grid-cols-[minmax(14rem,1fr)_9rem_9.5rem_11rem_minmax(9rem,auto)]'

/**
 * 幾份收件的回答事實（刪除鈕要知道有沒有人交過）：逐份讀名單（只給已下架的收件，份數少）。
 * 讀不到（不是管理員、不是收件）就不放進結果，畫面當作可以刪、由伺服器再判一次。
 */
export async function intakeResponseFacts(actor: ResolvedActor, itemIds: readonly string[]): Promise<Map<string, ResponseFacts>> {
  const rosterQuery = getRosterQuery()
  const rosters = await Promise.all(itemIds.map((id) => rosterQuery.roster(actor, id)))
  return new Map(rosters.flatMap((r) => (r ? [[r.item.itemId, responseFactsOf(r.entries)] as const] : [])))
}

export async function AffairsAssignmentList({ cohortId }: { cohortId: string; searchParams?: Record<string, string | string[] | undefined> }) {
  const actor = await renderActor()
  const rosterQuery = getRosterQuery()
  const placements: readonly string[] = AFFAIRS_TAB_PLACEMENTS.assignments
  const [rows, businessNow, facts] = await Promise.all([
    getItemQuery().list(cohortId),
    getBusinessClock().now(),
    rosterQuery.completionFacts(actor, cohortId),
  ])
  const shown = rows.filter((r) => placements.includes(r.placement))
  const archived = await Promise.all(shown.filter((r) => r.status === 'archived').map((r) => rosterQuery.roster(actor, r.id)))
  const factsOf = new Map([
    ...facts.map((f) => [f.item.itemId, f] as const),
    ...archived.flatMap((r) => (r ? [[r.item.itemId, r] as const] : [])),
  ])

  return (
    <Panel title="作業" icon={<IconClipboardText />}>
      <div className={cn('hidden gap-3 border-t border-border px-5 py-2 text-xs font-semibold text-muted-foreground md:grid', GRID)} aria-hidden>
        <span>標題</span>
        <span>對象</span>
        <span>截止時間</span>
        <span>繳交進度</span>
        <span className="text-right">動作</span>
      </div>
      <ul className="divide-y divide-border border-t border-border">
        {shown.map((r) => {
          const roster = factsOf.get(r.id)
          const completion = roster ? completionOf(roster.item, roster.entries, businessNow) : null
          const responses = roster && r.status === 'archived' ? responseFactsOf(roster.entries) : null
          const overdue = r.dueAt !== null && isDeadlinePassed(businessNow, r.dueAt)
          const consentForm = r.consentMode === 'form'
          const rosterHref = `/dashboard/admin/affairs/${r.id}`
          return (
            <li key={r.id} data-testid="affair-row" className={cn('grid items-center gap-x-3 gap-y-1.5 px-5 py-3 transition-colors hover:bg-accent/40', GRID)}>
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                {r.consentMode ? (
                  <Pill tone="brand" data-testid="consent-tag">
                    同意書
                  </Pill>
                ) : null}
                <Link
                  href={r.status === 'draft' ? `/dashboard/admin/editor/${r.id}` : rosterHref}
                  className="link-ink block min-w-0 truncate text-[15px] font-bold"
                >
                  {r.title}
                </Link>
                {r.status === 'published' ? null : <Pill>{ITEM_STATUS_LABEL[r.status]}</Pill>}
              </div>
              <span className="min-w-0 truncate text-xs text-muted-foreground md:text-sm">{audienceText(r)}</span>
              <span className={cn('text-xs tabular-nums md:text-sm', overdue ? 'font-semibold text-destructive' : 'text-muted-foreground')}>
                {r.dueAt ? formatTaipeiMinute(r.dueAt) : '沒有截止'}
              </span>
              <span className="min-w-0 text-xs md:text-sm" data-testid="progress">
                {r.status === 'draft' ? (
                  <span className="text-muted-foreground">草稿，發布時才建名單</span>
                ) : consentForm ? (
                  <Link href={rosterHref} className="font-semibold text-primary-on-subtle hover:underline">
                    名單 {r.rosterCount} 組・同意書進度
                  </Link>
                ) : completion ? (
                  <span className="flex flex-col gap-1">
                    <Link href={rosterHref} className="font-semibold text-primary-on-subtle tabular-nums hover:underline">
                      {progressText(completion.done, completion.required, r.receiverUnit)}
                    </Link>
                    <ProgressBar done={completion.done} total={completion.required} overdue={completion.overdue} showLabel={false} />
                  </span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </span>
              <RowActions
                row={{
                  id: r.id,
                  title: r.title,
                  deleteBlocked: deleteBlockedText(r.status, responses, r.receiverUnit),
                  canPin: false,
                  pinned: false,
                }}
              />
            </li>
          )
        })}
      </ul>
      {shown.length === 0 ? (
        <p className="border-t border-border px-4 py-10 text-center text-sm font-semibold">這一屆還沒有作業。按「新增」建立第一份。</p>
      ) : null}
    </Panel>
  )
}
