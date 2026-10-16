import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { EmptyState } from '@/app/_ui/primitives'
import { PageTitle, Pill, type PillTone } from '@/app/_ui/dashboard-kit'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { AdminTabs } from '@/app/dashboard/admin/_tabs'
import {
  AwardForm,
  BackfillForm,
  CreateDraftForm,
  DeleteEntry,
  DraftEditor,
  HomePositionForm,
  PublishPanel,
} from '@/app/dashboard/admin/showcase/showcase-forms'
import { cohortLabel, getCohortStatusQuery } from '@/composition/cohorts'
import { AWARD_LABEL_MAX, AWARD_LEVEL_LABEL, checkShowcaseLifecycle, getShowcaseQuery, SHOWCASE_STATUS_LABEL, VIDEO_URL_MESSAGE } from '@/composition/showcase'
import { cn } from '@/shared/cn'
import { formatTaipeiMinute } from '@/shared/time'

export const metadata = { title: '成果展示｜資管系專題平台' }

const STATUS_TONE: Record<'draft' | 'published' | 'withdrawn', PillTone> = { draft: 'default', published: 'success', withdrawn: 'danger' }
/** 卡片上的公開動作連結：跳到逐件管理裡那件作品的「公開」區。 */
const LIFECYCLE_LINK: Record<'draft' | 'published' | 'withdrawn', string> = { draft: '發布', published: '下架', withdrawn: '重新發布' }

/** 「公告與作業」底下的三個分頁（設計方案 §3.2；`/affairs`、`/files` 用同一組）。 */
const AFFAIRS_TABS = [
  { href: '/dashboard/admin/affairs', label: '公告與作業' },
  { href: '/dashboard/admin/showcase', label: '成果展示' },
  { href: '/dashboard/admin/files', label: '檔案' },
] as const

/**
 * 管理員「精選」（票 25／S11-03；第三波 W2，設計方案 §4）。
 *
 * 掛在「公告與作業」分頁列底下（AD-03，設計方案 §3.2）。上面是建立草稿／補登歷屆，接著作品一覽（每件一張卡；
 * 預設「全部（含歷屆）」：封存屆別的歷屆作品也在）；下面逐件：改草稿、發布（勾同意，Q31）、
 * 下架／重新發布、獎項、危險操作區的刪除。已刪除的不列。存草稿不會改到前台；發布時把草稿凍結成一個版本。
 * W15：補登歷屆作品（沒有組別）、首頁順序；封存屆別的作品管理員也能改內容與換海報，公開中的按「發布更新」換上前台。
 */
export default async function AdminShowcasePage({ searchParams }: { searchParams: Promise<{ cohort?: string | string[] }> }) {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  const actor = await requireRole('/dashboard/admin/showcase', 'admin')

  const cohorts = await getCohortStatusQuery().list()
  const params = await searchParams
  const picked = cohorts.find((c) => c.id === params.cohort) ?? null
  const open = cohorts.filter((c) => c.status !== 'archived')
  // 建立草稿用的屆別：篩選的屆別沒封存就用它，否則用預設工作屆別。
  const createCohort = picked && picked.status !== 'archived' ? picked : (open.find((c) => c.isDefaultWorking) ?? open[0] ?? null)
  // 補登歷屆作品：任何屆別都可以（含已封存）；篩選中的屆別排第一個當預設。
  const backfillCohorts = [...(picked ? [picked] : []), ...cohorts.filter((c) => c.id !== picked?.id)].map((c) => ({
    id: c.id,
    label: c.status === 'archived' ? `${cohortLabel(c)}・已封存` : cohortLabel(c),
  }))

  const shell = (children: React.ReactNode) => (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current="/dashboard/admin/showcase">
      <div className="mb-5">
        <PageTitle title="公告與作業" />
        <div className="mt-4">
          <AdminTabs label="公告與作業分頁" current="/dashboard/admin/showcase" items={AFFAIRS_TABS} />
        </div>
      </div>
      {children}
    </DashboardShell>
  )

  if (cohorts.length === 0) {
    return shell(
      <EmptyState title="還沒有屆別" description="先到屆別頁新增一屆，才能替那一屆的組別建成果展示草稿。" action={{ href: '/dashboard/admin/cohorts', label: '前往屆別' }} />,
    )
  }

  const board = await getShowcaseQuery().adminBoard(actor, { cohortId: picked?.id ?? null, createCohortId: createCohort?.id ?? null })
  if (!board.ok) return shell(<EmptyState title="讀不到成果展示資料" description={board.message} />)
  const { drafts, groups } = board.receipt
  const withoutDraft = groups.filter((g) => g.entryId === null)
  const groupLabel = (code: string | null) => code ?? '（歷屆補登）'

  return shell(
    <>
      <nav aria-label="選擇屆別" className="mb-4 flex flex-wrap gap-2">
        {[{ id: null, code: '全部（含歷屆）' }, ...cohorts.map((c) => ({ id: c.id, code: c.status === 'archived' ? `${cohortLabel(c)}・已封存` : cohortLabel(c) }))].map((c) => {
          const active = (picked?.id ?? null) === c.id
          return (
            <Link
              key={c.id ?? 'all'}
              href={c.id ? `/dashboard/admin/showcase?cohort=${c.id}` : '/dashboard/admin/showcase'}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'rounded-full border px-3 py-1 text-sm',
                active ? 'border-primary bg-primary-subtle text-primary-on-subtle' : 'border-border text-ink hover:bg-muted',
              )}
            >
              {c.code}
            </Link>
          )
        })}
      </nav>

      {/* 建立草稿與補登歷屆：表單是 V3 的元件（不改），直接攤開，不再包說明卡。 */}
      <div className="mb-6 grid gap-4 rounded-card border border-border bg-background p-4 lg:grid-cols-2">
        <section aria-labelledby="showcase-create-heading" className="space-y-2">
          <p className="flex flex-wrap items-baseline gap-x-2">
            <span id="showcase-create-heading" className="text-sm font-semibold text-ink">
              建立草稿{createCohort ? `・${cohortLabel(createCohort)}` : ''}
            </span>
            <span className="text-xs text-muted-foreground">草稿不會公開。</span>
          </p>
          {!createCohort ? (
            <p className="text-sm text-muted-foreground">目前沒有進行中的屆別，只能補登歷屆作品。</p>
          ) : groups.length === 0 ? (
            <p className="text-sm text-muted-foreground">這一屆還沒有組別；分組成立後才能建立成果展示草稿。</p>
          ) : (
            <CreateDraftForm groups={withoutDraft} requestId={randomUUID()} />
          )}
        </section>
        <section aria-labelledby="showcase-backfill-heading" className="space-y-2 lg:border-l lg:border-border lg:pl-4">
          <p id="showcase-backfill-heading" className="text-sm font-semibold text-ink">
            補登歷屆
          </p>
          <BackfillForm cohorts={backfillCohorts} requestId={randomUUID()} />
        </section>
      </div>

      <section aria-label="作品一覽" className="mb-6 space-y-3">
        <h2 className="text-base font-semibold text-ink">作品一覽</h2>
        {drafts.length === 0 ? (
          <EmptyState title="尚無成果展示草稿" description="在上面選一組建立草稿，填好題目、摘要、海報與影片連結後儲存，再勾同意發布。" />
        ) : (
          <ul className="grid gap-3 md:grid-cols-2">
            {drafts.map((d) => (
              <li key={d.entryId} data-testid="entry-card" className="flex flex-col gap-3 rounded-card border border-border bg-background p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="font-semibold break-words text-ink">{d.title || '（未填題目）'}</h3>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      <span data-testid="entry-group">{groupLabel(d.groupCode)}</span>・{cohortLabel({ name: d.cohortName, code: d.cohortCode })}
                    </p>
                  </div>
                  <Pill tone={STATUS_TONE[d.status]} data-testid="entry-status">
                    {SHOWCASE_STATUS_LABEL[d.status]}
                  </Pill>
                </div>
                <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
                  <div className="flex gap-1.5">
                    <dt className="text-muted-foreground">獎項</dt>
                    <dd className="font-medium text-ink" data-testid="entry-award">
                      {d.award ? (d.awardLabel ?? AWARD_LEVEL_LABEL[d.award]) : '—'}
                    </dd>
                  </div>
                  <div className="flex gap-1.5">
                    <dt className="text-muted-foreground">首頁順序</dt>
                    <dd className="font-medium text-ink tabular-nums" data-testid="entry-home-position">
                      {d.homePosition ?? '—'}
                    </dd>
                  </div>
                </dl>
                <div className="mt-auto flex flex-wrap gap-4 text-sm font-semibold">
                  <a href={`#entry-${d.entryId}`} className="text-primary underline-offset-2 hover:underline">
                    編輯
                  </a>
                  <a href={`#entry-${d.entryId}-publish`} className="text-primary underline-offset-2 hover:underline">
                    {LIFECYCLE_LINK[d.status]}
                  </a>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="成果展示" className="space-y-4">
        {drafts.length === 0 ? null : <h2 className="text-base font-semibold text-ink">逐件管理</h2>}
        {drafts.map((d) => {
          const label = `${cohortLabel({ name: d.cohortName, code: d.cohortCode })} ${groupLabel(d.groupCode)}`
          const ref = { entryId: d.entryId, revision: d.entryRevision, label }
          // 封存屆別的作品管理員照樣能改（優秀專題是跨屆的公開紀錄，W15）；只有解散的組鎖內容。
          const locked = d.groupDissolved ? '這一組已解散，內容只能查看。' : null
          return (
            <article
              key={d.entryId}
              id={`entry-${d.entryId}`}
              className="scroll-mt-20 rounded-card border border-border bg-background p-5"
              data-testid="showcase-draft"
            >
              <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold text-ink">
                    {groupLabel(d.groupCode)}
                    <span className="ml-2 text-sm font-normal text-muted-foreground">{cohortLabel({ name: d.cohortName, code: d.cohortCode })}</span>
                  </h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    最後儲存 {formatTaipeiMinute(d.updatedAt)}
                    {d.updatedByName ? `・${d.updatedByName}` : ''}
                    {d.frozenInVersions > 0 ? `・已有 ${d.frozenInVersions} 份站內同意書鎖定了這份草稿當時的內容（改草稿不影響它們）` : ''}
                  </p>
                </div>
                <dl className="flex gap-4 text-xs">
                  <div>
                    <dt className="text-muted-foreground">狀態</dt>
                    <dd className="mt-0.5">
                      <Pill tone={STATUS_TONE[d.status]}>{SHOWCASE_STATUS_LABEL[d.status]}</Pill>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">獎項</dt>
                    <dd className="mt-0.5 font-medium text-ink">{d.award ? (d.awardLabel ?? AWARD_LEVEL_LABEL[d.award]) : '沒有'}</dd>
                  </div>
                </dl>
              </header>

              {d.status !== 'draft' && d.hasUnpublishedChanges ? (
                <p className="mb-3 text-xs text-muted-foreground" data-testid="unpublished-changes">
                  前台目前顯示的是發布時那一版（題目「{d.publishedTitle}」）；下面草稿的修改要按「發布更新」才會換上前台。
                </p>
              ) : null}
              {locked ? <p className="mb-3 text-xs text-muted-foreground">{locked}</p> : null}

              {d.hasDraft ? (
                <DraftEditor
                  entryId={d.entryId}
                  groupCode={groupLabel(d.groupCode)}
                  revision={d.revision}
                  title={d.title}
                  summary={d.summary}
                  videoUrl={d.videoUrl}
                  poster={d.poster ? { fileId: d.poster.fileId, name: d.poster.name } : null}
                  requestId={randomUUID()}
                  disabled={locked !== null}
                  videoUrlMessage={VIDEO_URL_MESSAGE}
                />
              ) : (
                <p className="text-sm text-muted-foreground">這件作品只有發布的版本，沒有可以改的草稿。</p>
              )}

              <div className="mt-5 grid gap-5 border-t border-border pt-4 lg:grid-cols-2">
                <div id={`entry-${d.entryId}-publish`} className="scroll-mt-20 space-y-2" role="group" aria-label="公開">
                  <h4 className="text-sm font-semibold text-ink">公開</h4>
                  <PublishPanel
                    {...ref}
                    requestId={randomUUID()}
                    status={d.status}
                    titleMissing={d.title.trim() === ''}
                    hasUnpublishedChanges={d.hasUnpublishedChanges}
                  />
                </div>
                <div className="space-y-2" role="group" aria-label="獎項">
                  <h4 className="text-sm font-semibold text-ink">獎項</h4>
                  <AwardForm {...ref} requestId={randomUUID()} award={d.award} awardLabel={d.awardLabel} labelMax={AWARD_LABEL_MAX} />
                </div>
                <div className="space-y-2" role="group" aria-label="首頁順序">
                  <h4 className="text-sm font-semibold text-ink">首頁順序</h4>
                  <HomePositionForm
                    {...ref}
                    requestId={randomUUID()}
                    homePosition={d.homePosition}
                    showsOnHome={d.status === 'published' && d.award !== null}
                    max={99}
                  />
                </div>
              </div>

              <div className="mt-5 rounded-lg border border-destructive/30 bg-destructive-subtle/40 p-4" aria-label="危險操作" role="group">
                <h4 className="mb-2 text-sm font-semibold text-destructive-on-subtle">危險操作</h4>
                <DeleteEntry {...ref} requestId={randomUUID()} title={d.title} blockedReason={checkShowcaseLifecycle('delete', d.status)} />
              </div>
            </article>
          )
        })}
      </section>
    </>,
  )
}
