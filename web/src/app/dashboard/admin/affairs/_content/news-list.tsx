import Link from 'next/link'
import { IconExternalLink, IconPin, IconSearch, IconSpeakerphone } from '@tabler/icons-react'
import { Panel, Pill, pillClass } from '@/app/_ui/dashboard-kit'
import { renderActor } from '@/app/_ui/guard'
import { intakeResponseFacts } from '@/app/dashboard/admin/affairs/_content/assignment-list'
import { RowActions } from '@/app/dashboard/admin/affairs/_content/list-actions'
import { AFFAIRS_FILTERS, type AffairsFilter, audienceText, deleteBlockedText, unitWord } from '@/app/dashboard/admin/affairs/affairs-view'
import { getBusinessClock } from '@/composition/cohorts'
import { collectsResponses, getItemQuery, ITEM_STATUS_LABEL, PLACEMENT_LABEL } from '@/composition/items'
import { completionOf, getRosterQuery } from '@/composition/submissions'
import { cn } from '@/shared/cn'
import { formatTaipeiDate, formatTaipeiMinute, isDeadlinePassed, taipeiDateOf } from '@/shared/time'

/**
 * 公告與作業 › 公告的清單內容（C 階段規格① §4.1、AC-10；②的分頁殼掛這個元件，`{ cohortId, searchParams }`）。
 *
 * - 預設只列公告（含競賽資訊）。欄：標題（置頂圖示）、對象、狀態、發布時間、編輯／刪除；置頂放在列上的「⋯」。
 * - 工具列：搜尋（標題、對象；`?q=`）、狀態篩選（`?status=`），都是網址參數、伺服器篩好，不多查資料庫。
 * - 「種類」篩選暫留（②§12.3）：「全部」是全頁編輯器送出後回來的地方（`placement=all`），「逾期」是已截止還有人沒交的收件
 *   （AD-B7，只有這個篩選多讀一次全屆名單事實）。「榮譽」已搬到「成果展示」分頁的榮譽榜區（C1-09），
 *   舊的 `?placement=honor` 由殼先轉址（`legacy-redirects.ts`）。
 * - 刪除：不能刪時按鈕本身寫原因（`deleteBlockedText`）；已下架的收件要看有沒有人交過才知道，只對那幾份讀名單。
 */

export type NewsListSearchParams = {
  readonly placement?: string | string[]
  readonly q?: string | string[]
  readonly status?: string | string[]
}

const STATUS_FILTERS = [
  { key: 'any', label: '全部狀態' },
  { key: 'draft', label: '草稿' },
  { key: 'published', label: '發布中' },
  { key: 'archived', label: '已下架' },
] as const

/** 這裡的「種類」篩選：榮譽搬到成果展示（C1-09），其餘照 `AFFAIRS_FILTERS`。 */
const NEWS_FILTERS = AFFAIRS_FILTERS.filter((f) => f.key !== 'honor')

const GRID = 'md:grid-cols-[minmax(14rem,1fr)_9rem_7rem_7.5rem_minmax(9rem,auto)]'

function one(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** 這個元件認得的篩選（預設是公告）。殼與它用同一個函式決定屆別選單要不要列封存屆別。 */
export function newsFilterOf(searchParams: NewsListSearchParams): AffairsFilter {
  return NEWS_FILTERS.find((f) => f.key === one(searchParams.placement))?.key ?? 'news'
}

export async function AffairsNewsList({ cohortId, searchParams }: { cohortId: string; searchParams: NewsListSearchParams }) {
  const filter = newsFilterOf(searchParams)
  const status = STATUS_FILTERS.find((s) => s.key === one(searchParams.status))?.key ?? 'any'
  const q = (one(searchParams.q) ?? '').trim().slice(0, 100)

  const actor = await renderActor()
  const [rows, businessNow, facts] = await Promise.all([
    getItemQuery().list(cohortId),
    getBusinessClock().now(),
    filter === 'overdue' ? getRosterQuery().completionFacts(actor, cohortId) : Promise.resolve([]),
  ])
  // 每份收件的欠繳數：口徑同名單頁與首頁逾期卡（目前名單、不含免填與移出、沒有正式版本、狀態是逾期）。
  const overdueOf = new Map(facts.map((f) => [f.item.itemId, completionOf(f.item, f.entries, businessNow).overdue]))
  const needle = q.toLowerCase()
  const shown = rows
    .filter((r) =>
      filter === 'overdue'
        ? r.placement === 'submission' &&
          r.status === 'published' &&
          r.dueAt !== null &&
          isDeadlinePassed(businessNow, r.dueAt) &&
          (overdueOf.get(r.id) ?? 0) > 0
        : filter === 'all' || r.placement === filter,
    )
    .filter((r) => status === 'any' || r.status === status)
    .filter((r) => !needle || r.title.toLowerCase().includes(needle) || audienceText(r).toLowerCase().includes(needle))
  // 已下架的收件：有人交過（或存過草稿）就不能刪，按鈕要先寫原因——只對這幾份讀名單。
  const responses = await intakeResponseFacts(
    actor,
    shown.filter((r) => r.status === 'archived' && collectsResponses(r.placement)).map((r) => r.id),
  )

  const href = (patch: Record<string, string>) => {
    const next = new URLSearchParams({ cohort: cohortId, placement: filter, ...(status === 'any' ? {} : { status }), ...(q ? { q } : {}), ...patch })
    for (const [k, v] of [...next.entries()]) if (v === '' || (k === 'status' && v === 'any')) next.delete(k)
    return `/dashboard/admin/affairs?${next.toString()}`
  }

  const emptyText = q
    ? `沒有符合「${q}」的內容`
    : status !== 'any'
      ? `沒有「${STATUS_FILTERS.find((s) => s.key === status)!.label}」的項目。`
      : filter === 'all'
        ? '這一屆還沒有任何項目。按「新增」建立第一筆公告。'
        : filter === 'news'
          ? '這一屆還沒有公告。按「新增」建立第一筆。'
          : '這一屆目前沒有逾期未繳的文件繳交。'

  return (
    <>
      <Panel title={filter === 'news' ? '公告' : (AFFAIRS_FILTERS.find((f) => f.key === filter)!.label)} icon={<IconSpeakerphone />}>
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-5 py-3">
          <form action="/dashboard/admin/affairs" className="relative block max-sm:w-full" role="search">
            <input type="hidden" name="cohort" value={cohortId} />
            <input type="hidden" name="placement" value={filter} />
            {status === 'any' ? null : <input type="hidden" name="status" value={status} />}
            <label>
              <span className="sr-only">搜尋標題或對象</span>
              <IconSearch aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <input
                key={q}
                name="q"
                defaultValue={q}
                placeholder="搜尋標題、對象"
                className="h-9 w-48 rounded-lg border border-input bg-background pr-3 pl-8 text-sm outline-none transition-[border-color,box-shadow] focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary/25 max-sm:w-full pointer-coarse:h-11"
              />
            </label>
          </form>
          <nav aria-label="狀態" className="flex flex-wrap gap-1">
            {STATUS_FILTERS.map((s) => (
              <Link key={s.key} href={href({ status: s.key })} aria-current={status === s.key ? 'page' : undefined} className={pillClass(status === s.key)}>
                {s.label}
              </Link>
            ))}
          </nav>
          <nav aria-label="種類" className="flex flex-wrap gap-1 md:ml-auto">
            {NEWS_FILTERS.map((f) => (
              <Link key={f.key} href={href({ placement: f.key, status: '', q: '' })} aria-current={filter === f.key ? 'page' : undefined} className={pillClass(filter === f.key)}>
                {f.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className={cn('hidden gap-3 border-t border-border px-5 py-2 text-xs font-semibold text-muted-foreground md:grid', GRID)} aria-hidden>
          <span>標題</span>
          <span>對象</span>
          <span>狀態</span>
          <span>發布時間</span>
          <span className="text-right">動作</span>
        </div>
        <ul className="divide-y divide-border border-t border-border">
          {shown.map((r) => {
            const intake = collectsResponses(r.placement)
            const overdueText = filter === 'overdue' ? `逾期 ${overdueOf.get(r.id) ?? 0} ${unitWord(r.receiverUnit)}` : null
            const publicHref =
              r.status !== 'published' ? null : r.placement === 'news' ? `/news/${r.id}` : r.placement === 'honor' ? '/honors' : null
            return (
              <li key={r.id} data-testid="affair-row" className={cn('grid items-center gap-x-3 gap-y-1.5 px-5 py-3 transition-colors hover:bg-accent/40', GRID)}>
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-1.5">
                    {r.pinnedAt ? (
                      <span title="置頂" data-testid="pinned-pill" className="shrink-0 text-primary">
                        <IconPin aria-hidden className="size-4" />
                        <span className="sr-only">置頂</span>
                      </span>
                    ) : null}
                    {filter === 'news' ? null : <span className="shrink-0 text-xs font-semibold text-muted-foreground">{PLACEMENT_LABEL[r.placement]}</span>}
                    <Link href={`/dashboard/admin/editor/${r.id}`} className="link-ink block min-w-0 flex-1 truncate text-[15px] font-bold">
                      {r.title}
                    </Link>
                  </div>
                  <span className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                    {publicHref ? (
                      <Link href={publicHref} className="inline-flex items-center gap-0.5 whitespace-nowrap hover:text-foreground">
                        前台頁面 <IconExternalLink aria-hidden className="size-3" />
                      </Link>
                    ) : null}
                    {intake && r.status !== 'draft' ? (
                      <Link href={`/dashboard/admin/affairs/${r.id}`} className="font-semibold text-primary-on-subtle hover:underline">
                        繳交狀況
                      </Link>
                    ) : null}
                  </span>
                </div>
                <div className="min-w-0 text-xs text-muted-foreground md:text-sm">
                  <span className="block truncate">{audienceText(r)}</span>
                  <span className="block text-xs">{r.audienceKind === 'public' ? '網際網路公開' : '登入後可見'}</span>
                </div>
                <span className="flex flex-wrap gap-1">
                  <Pill tone={r.status === 'published' ? 'success' : 'default'}>{ITEM_STATUS_LABEL[r.status]}</Pill>
                  {overdueText ? (
                    <Pill tone="danger" data-testid="overdue-pill">
                      {overdueText}
                    </Pill>
                  ) : null}
                </span>
                <span className="text-xs text-muted-foreground tabular-nums md:text-sm">
                  {intake && r.dueAt
                    ? `截止 ${formatTaipeiMinute(r.dueAt)}`
                    : r.actualOpenedAt
                      ? formatTaipeiDate(taipeiDateOf(r.actualOpenedAt))
                      : '—'}
                </span>
                <RowActions
                  row={{
                    id: r.id,
                    title: r.title,
                    deleteBlocked: deleteBlockedText(r.status, intake ? (responses.get(r.id) ?? null) : null, r.receiverUnit),
                    canPin: r.placement === 'news' && r.status === 'published',
                    pinned: r.pinnedAt !== null,
                  }}
                />
              </li>
            )
          })}
        </ul>
        {shown.length === 0 ? <p className="border-t border-border px-4 py-10 text-center text-sm font-semibold">{emptyText}</p> : null}
      </Panel>
    </>
  )
}
