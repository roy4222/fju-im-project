import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { Card, DataTable, EmptyState, PageHeader } from '@/app/_ui/primitives'
import { Pill, type PillTone } from '@/app/_ui/dashboard-kit'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import {
  AwardForm,
  BackfillForm,
  CreateDraftForm,
  DeleteEntry,
  DraftEditor,
  HomePositionForm,
  PublishPanel,
} from '@/app/dashboard/admin/showcase/showcase-forms'
import { getCohortStatusQuery } from '@/composition/cohorts'
import { AWARD_LABEL_MAX, AWARD_LEVEL_LABEL, checkShowcaseLifecycle, getShowcaseQuery, SHOWCASE_STATUS_LABEL } from '@/composition/showcase'
import { cn } from '@/shared/cn'
import { formatTaipeiMinute } from '@/shared/time'

export const metadata = { title: '成果展示｜資管系專題平台' }

const STATUS_TONE: Record<'draft' | 'published' | 'withdrawn', PillTone> = { draft: 'default', published: 'success', withdrawn: 'danger' }

/**
 * 管理員「精選」（票 25／S11-03；第三波 W2，設計方案 §4）。
 *
 * 上面是作品一覽（預設「全部（含歷屆）」：封存屆別的歷屆作品也在）；下面逐件：改草稿、發布（勾同意，Q31）、
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
    label: c.status === 'archived' ? `${c.code}（已封存）` : c.code,
  }))

  const shell = (children: React.ReactNode) => (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current="/dashboard/admin/showcase">
      <PageHeader
        title="成果展示"
        description="勾選同意並按「發布」後，登入的師生就能在「歷屆專題一覽」看到；有選獎項的才會出現在訪客看得到的「優秀專題」與首頁輪播。草稿不會公開。"
      />
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
        {[{ id: null, code: '全部（含歷屆）' }, ...cohorts.map((c) => ({ id: c.id, code: c.status === 'archived' ? `${c.code}（已封存）` : c.code }))].map((c) => {
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

      <Card
        title="建立成果展示草稿"
        description={
          createCohort
            ? `替 ${createCohort.code} 屆的一組建草稿（一組一屆只有一份）。填好內容後，在下面那件作品勾同意並按「發布」才會公開。`
            : '目前沒有進行中的屆別；歷屆作品可以用下面的「補登歷屆作品」新增，或直接在逐件管理裡修改。'
        }
        className="mb-6"
      >
        {!createCohort ? null : groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">這一屆還沒有組別；分組成立後才能建立成果展示草稿。</p>
        ) : (
          <CreateDraftForm groups={withoutDraft} requestId={randomUUID()} />
        )}
      </Card>

      <Card
        title="補登歷屆作品"
        description="沒有組別的歷屆作品（例如系統上線前的得獎作品）：選屆別、填題目建立，再在下面補摘要與海報、勾同意發布。"
        className="mb-6"
      >
        <BackfillForm cohorts={backfillCohorts} requestId={randomUUID()} />
      </Card>

      <section aria-label="作品一覽" className="mb-6 space-y-2">
        <h2 className="text-base font-semibold text-ink">作品一覽</h2>
        <DataTable
          columns={['題目', '屆別', '組別', '狀態', '獎項', '首頁順序', '動作']}
          empty={picked ? '這一屆還沒有作品；在上面選一組建立草稿。' : '還沒有任何作品；在上面選一組建立草稿。'}
          rows={drafts.map((d) => [
            <span key="t" className="font-medium text-ink">
              {d.title || '（未填題目）'}
            </span>,
            d.cohortCode,
            groupLabel(d.groupCode),
            <Pill key="s" tone={STATUS_TONE[d.status]} data-testid="entry-status">
              {SHOWCASE_STATUS_LABEL[d.status]}
            </Pill>,
            <span key="a" data-testid="entry-award">
              {d.award ? (d.awardLabel ?? AWARD_LEVEL_LABEL[d.award]) : '—'}
            </span>,
            d.homePosition ?? '—',
            <a key="m" href={`#entry-${d.entryId}`} className="text-sm font-semibold text-primary underline-offset-2 hover:underline">
              管理
            </a>,
          ])}
        />
      </section>

      <section aria-label="成果展示" className="space-y-4">
        <h2 className="text-base font-semibold text-ink">逐件管理</h2>
        {drafts.length === 0 ? (
          <EmptyState title="尚無成果展示草稿" description="在上面選一組建立草稿，填好題目、摘要、海報與影片連結後儲存，再勾同意發布。" />
        ) : (
          drafts.map((d) => {
            const label = `${d.cohortCode} ${groupLabel(d.groupCode)}`
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
                      <span className="ml-2 text-sm font-normal text-muted-foreground">{d.cohortCode} 屆</span>
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
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">這件作品只有發布的版本，沒有可以改的草稿。</p>
                )}

                <div className="mt-5 grid gap-5 border-t border-border pt-4 lg:grid-cols-2">
                  <div className="space-y-2" role="group" aria-label="公開">
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
          })
        )}
      </section>
    </>,
  )
}
