import Link from 'next/link'
import { IconTrophy, IconPhoto } from '@tabler/icons-react'
import { Panel, Pill, pillClass, type PillTone } from '@/app/_ui/dashboard-kit'
import { EmptyState } from '@/app/_ui/primitives'
import { renderActor } from '@/app/_ui/guard'
import { RowActions } from '@/app/dashboard/admin/affairs/_content/list-actions'
import { deleteBlockedText } from '@/app/dashboard/admin/affairs/affairs-view'
import { EntryRowActions, HomeOrderPanel, ShowcaseDialogs, ShowcaseNewMenu, type ShowcaseDialogConfig } from '@/app/dashboard/admin/showcase/showcase-forms'
import { showcaseCohorts, type ShowcaseEntryView } from '@/app/dashboard/admin/showcase/showcase-view'
import { cohortLabel, getCohortStatusQuery } from '@/composition/cohorts'
import { getItemQuery, getPublicItemQuery, ITEM_STATUS_LABEL } from '@/composition/items'
import { AWARD_LABEL_MAX, AWARD_LEVEL_LABEL, checkShowcaseLifecycle, getShowcaseQuery, SHOWCASE_STATUS_LABEL, VIDEO_URL_MESSAGE } from '@/composition/showcase'
import { cn } from '@/shared/cn'
import { formatTaipeiMinute } from '@/shared/time'

/**
 * 公告與作業 › 成果展示的內容（C 階段規格① §4.5、AC-14／AC-14a；②的分頁殼掛這個元件，`{ cohortId, searchParams }`）。
 *
 * - 上半：作品清單，每件一列（海報縮圖、題目、組別、狀態、獎項、首頁順序、「編輯」「刪除」）；「編輯」開 `ShowcaseEditDialog`
 *   一次存齊。屆別選單預設「全部（含歷屆）」：封存屆別的歷屆作品也在。首頁輪播順序另有一塊可拖曳排序。
 * - 下半：「榮譽榜」（`placement='honor'`，跨屆的公開紀錄，原本在 `/affairs` 的「榮譽」篩選）：屆別選單含已封存的屆別，
 *   每列標題、得獎日期、狀態、「編輯」「刪除」（公告分頁同一組 `RowActions`，編輯開 `ItemFormDialog`）。
 * - 右上「新增」下拉：「作品」「補登歷屆作品」「榮譽」（榮譽帶榮譽榜區選的屆別）。沒有紅色危險操作區：刪除在列上。
 *
 * `?cohort=`：作品清單的屆別（沒帶＝全部）；`?honor=`：榮譽榜的屆別（沒帶跟著作品清單，再退到預設工作屆別）。
 */

export type ShowcaseSearchParams = {
  readonly cohort?: string | string[]
  readonly honor?: string | string[]
}

const STATUS_TONE: Record<'draft' | 'published' | 'withdrawn', PillTone> = { draft: 'default', published: 'success', withdrawn: 'danger' }
// 每列各自是一個 grid：欄寬要固定（不用 auto），列與列才對得齊。
const GRID = 'md:grid-cols-[4rem_minmax(12rem,1fr)_6rem_5.5rem_minmax(7rem,10rem)_4.5rem_12rem]'
const HONOR_GRID = 'md:grid-cols-[minmax(14rem,1fr)_7rem_6rem_12rem]'
const BASE = '/dashboard/admin/showcase'

function href(params: { cohort?: string | null; honor?: string | null }): string {
  const next = new URLSearchParams()
  if (params.cohort) next.set('cohort', params.cohort)
  if (params.honor) next.set('honor', params.honor)
  const query = next.toString()
  return query ? `${BASE}?${query}` : BASE
}

function one(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export async function ShowcaseTab({ cohortId, searchParams }: { cohortId: string | null; searchParams: ShowcaseSearchParams }) {
  const actor = await renderActor()
  const cohorts = await getCohortStatusQuery().list()
  if (cohorts.length === 0) {
    return (
      <EmptyState title="還沒有屆別" description="先到屆別頁新增一屆，才能替那一屆的組別建成果展示草稿。" action={{ href: '/dashboard/admin/cohorts', label: '前往屆別' }} />
    )
  }
  const view = showcaseCohorts(cohorts, { cohort: cohortId ?? undefined, honor: searchParams.honor })
  const { picked, createCohort, honorCohort } = view
  const label = (c: (typeof cohorts)[number]) => (c.status === 'archived' ? `${cohortLabel(c)}・已封存` : cohortLabel(c))
  const honorParam = one(searchParams.honor) ?? null

  const [board, honorRows, publicHonors] = await Promise.all([
    getShowcaseQuery().adminBoard(actor, { cohortId: picked?.id ?? null, createCohortId: createCohort?.id ?? null }),
    honorCohort ? getItemQuery().list(honorCohort.id) : Promise.resolve([]),
    // 得獎日期只在前台卡片上有（清單列沒有這一欄）：發布中的從榮譽榜的同一個查詢拿，草稿顯示「—」。
    honorCohort ? getPublicItemQuery().list(actor, 'honor', { limit: 200, order: 'awarded' }) : Promise.resolve([]),
  ])
  if (!board.ok) return <EmptyState title="讀不到成果展示資料" description={board.message} />
  const { drafts, groups } = board.receipt
  const awardedOn = new Map(publicHonors.map((h) => [h.id, h.awardedOn]))
  const honors = honorRows.filter((r) => r.placement === 'honor')

  const entries: ShowcaseEntryView[] = drafts.map((d) => ({
    entryId: d.entryId,
    entryRevision: d.entryRevision,
    draftRevision: d.revision,
    cohortLabel: cohortLabel({ name: d.cohortName, code: d.cohortCode }),
    groupLabel: d.groupCode ?? '（歷屆補登）',
    status: d.status,
    title: d.title,
    summary: d.summary,
    videoUrl: d.videoUrl ?? '',
    poster: d.poster ? { fileId: d.poster.fileId, name: d.poster.name } : null,
    award: d.award,
    awardLabel: d.awardLabel ?? '',
    homePosition: d.homePosition,
    hasDraft: d.hasDraft,
    hasUnpublishedChanges: d.hasUnpublishedChanges,
    publishedTitle: d.publishedTitle,
    // 封存屆別的作品照樣能改（優秀專題是跨屆的公開紀錄，W15）；只有解散的組鎖內容。
    locked: d.groupDissolved ? '這一組已解散，內容只能查看。' : null,
    // 按鈕本身寫原因（同公告分頁的說法）；規則照用例（公開中不能直接刪）。
    deleteBlocked: checkShowcaseLifecycle('delete', d.status) ? '公開中，先下架才能刪' : null,
    savedNote: [
      `最後儲存 ${formatTaipeiMinute(d.updatedAt)}${d.updatedByName ? `・${d.updatedByName}` : ''}`,
      d.frozenInVersions > 0 ? `已有 ${d.frozenInVersions} 份站內同意書鎖定了這份草稿當時的內容（改草稿不影響它們）` : null,
    ]
      .filter(Boolean)
      .join('・'),
  }))
  const awardText = (e: ShowcaseEntryView) => (e.award ? e.awardLabel || AWARD_LEVEL_LABEL[e.award] : '—')
  const config: ShowcaseDialogConfig = { videoUrlMessage: VIDEO_URL_MESSAGE, awardLabelMax: AWARD_LABEL_MAX }
  // 首頁輪播只放有獎項而且公開中的作品；依目前順序（沒填的排後面）。
  const onHome = entries
    .filter((e) => e.status === 'published' && e.award !== null)
    .sort((a, b) => (a.homePosition ?? Number.MAX_SAFE_INTEGER) - (b.homePosition ?? Number.MAX_SAFE_INTEGER))

  return (
    <ShowcaseDialogs config={config}>
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <nav aria-label="選擇屆別" className="flex flex-wrap gap-1.5">
            {[{ id: null, text: '全部（含歷屆）' }, ...cohorts.map((c) => ({ id: c.id, text: label(c) }))].map((c) => (
              <Link
                key={c.id ?? 'all'}
                href={href({ cohort: c.id, honor: honorParam })}
                aria-current={(picked?.id ?? null) === c.id ? 'page' : undefined}
                className={pillClass((picked?.id ?? null) === c.id)}
              >
                {c.text}
              </Link>
            ))}
          </nav>
          {/* 換行時也靠右：「新增」下拉是靠右展開的。 */}
          <div className="ml-auto flex items-center gap-3">
            <span className="text-xs text-muted-foreground">草稿不會公開。</span>
            <ShowcaseNewMenu
              create={createCohort ? { cohortLabel: cohortLabel(createCohort), groups: groups.filter((g) => g.entryId === null) } : null}
              backfillCohorts={view.backfillCohorts.map((c) => ({ id: c.id, label: label(c) }))}
              honorCohort={honorCohort ? { id: honorCohort.id, label: cohortLabel(honorCohort) } : null}
            />
          </div>
        </div>

        <Panel title="作品" icon={<IconPhoto />}>
          {entries.length === 0 ? (
            <div className="border-t border-border p-5">
              <EmptyState title="尚無成果展示草稿" description="按右上「新增 › 作品」替一組建草稿，填好題目、摘要後儲存；海報在「編輯」上傳，勾同意就能發布。" />
            </div>
          ) : (
            <>
              <div className={cn('hidden gap-3 border-t border-border px-5 py-2 text-xs font-semibold text-muted-foreground md:grid', GRID)} aria-hidden>
                <span>海報</span>
                <span>題目</span>
                <span>組別</span>
                <span>狀態</span>
                <span>獎項</span>
                <span>首頁順序</span>
                <span className="text-right">動作</span>
              </div>
              <ul aria-label="作品清單" className="divide-y divide-border border-t border-border">
                {entries.map((e) => (
                  <li key={e.entryId} data-testid="entry-row" className={cn('grid items-center gap-x-3 gap-y-1.5 px-5 py-3', GRID)}>
                    <span className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-md border border-border bg-muted">
                      {e.poster ? (
                        // 草稿海報走 /api/files（每次重新授權）；只有系辦看這頁。
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={`/api/files/${e.poster.fileId}`} alt="" className="h-full w-full object-cover" loading="lazy" />
                      ) : (
                        <IconPhoto aria-hidden className="size-5 text-muted-foreground" />
                      )}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate font-semibold text-ink" data-testid="entry-title">
                        {e.title || '（未填題目）'}
                      </span>
                      <span className="block text-xs text-muted-foreground">{e.cohortLabel}</span>
                    </span>
                    <span className="text-sm" data-testid="entry-group">
                      {e.groupLabel}
                    </span>
                    <span>
                      <Pill tone={STATUS_TONE[e.status]} data-testid="entry-status">
                        {SHOWCASE_STATUS_LABEL[e.status]}
                      </Pill>
                    </span>
                    <span className="truncate text-sm" data-testid="entry-award">
                      {awardText(e)}
                    </span>
                    <span className="text-sm tabular-nums" data-testid="entry-home-position">
                      {e.homePosition ?? '—'}
                    </span>
                    <EntryRowActions entry={e} />
                  </li>
                ))}
              </ul>
            </>
          )}
          {onHome.length > 1 ? (
            <section aria-labelledby="home-order-heading" className="space-y-2 border-t border-border px-5 py-4">
              <h3 id="home-order-heading" className="text-sm font-semibold text-ink">
                首頁輪播順序
              </h3>
              <HomeOrderPanel
                entries={onHome.map((e) => ({ entryId: e.entryId, title: e.title, groupLabel: e.groupLabel, homePosition: e.homePosition, entryRevision: e.entryRevision }))}
              />
            </section>
          ) : null}
        </Panel>

        <Panel title="榮譽榜" icon={<IconTrophy />}>
          <div className="space-y-2 border-t border-border px-5 py-3">
            <p className="text-sm text-muted-foreground" data-testid="honor-board-hint">
              榮譽是跨屆的公開紀錄：屆別含已封存的，選那一屆就看得到歷屆榮譽，可以編輯、下架、重新發布或刪除；封存屆別也能「新增 › 榮譽」。發布中的會出現在前台
              <Link href="/honors" className="mx-0.5 font-semibold text-foreground underline underline-offset-2">
                「榮譽榜」
              </Link>
              。
            </p>
            <nav aria-label="榮譽榜屆別" className="flex flex-wrap gap-1.5">
              {cohorts.map((c) => (
                <Link
                  key={c.id}
                  href={href({ cohort: picked?.id ?? null, honor: c.id })}
                  aria-current={honorCohort?.id === c.id ? 'page' : undefined}
                  className={pillClass(honorCohort?.id === c.id)}
                >
                  {cohortLabel(c)}
                  {c.status === 'archived' ? <span className="ml-1 text-xs font-normal opacity-80">（已封存）</span> : null}
                </Link>
              ))}
            </nav>
          </div>
          <div className={cn('hidden gap-3 border-t border-border px-5 py-2 text-xs font-semibold text-muted-foreground md:grid', HONOR_GRID)} aria-hidden>
            <span>標題</span>
            <span>得獎日期</span>
            <span>狀態</span>
            <span className="text-right">動作</span>
          </div>
          <ul aria-label="榮譽清單" className="divide-y divide-border border-t border-border">
            {honors.map((r) => (
              <li key={r.id} data-testid="honor-row" className={cn('grid items-center gap-x-3 gap-y-1.5 px-5 py-3', HONOR_GRID)}>
                <span className="min-w-0 truncate font-semibold text-ink">{r.title}</span>
                <span className="text-sm text-muted-foreground tabular-nums">{awardedOn.get(r.id) ?? '—'}</span>
                <span>
                  <Pill tone={r.status === 'published' ? 'success' : 'default'}>{ITEM_STATUS_LABEL[r.status]}</Pill>
                </span>
                <RowActions row={{ id: r.id, title: r.title, deleteBlocked: deleteBlockedText(r.status, null, r.receiverUnit), canPin: false, pinned: false }} />
              </li>
            ))}
          </ul>
          {honors.length === 0 ? (
            <p className="border-t border-border px-4 py-8 text-center text-sm font-semibold">
              {honorCohort ? `${cohortLabel(honorCohort)}還沒有榮譽。按右上「新增 › 榮譽」建立第一則。` : '還沒有屆別。'}
            </p>
          ) : null}
        </Panel>
      </div>
    </ShowcaseDialogs>
  )
}
