import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { Card, EmptyState, PageHeader } from '@/app/_ui/primitives'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { CreateDraftForm, DraftEditor } from '@/app/dashboard/admin/showcase/showcase-forms'
import { getCohortStatusQuery } from '@/composition/cohorts'
import { GATE_PLACEHOLDER, getShowcaseQuery } from '@/composition/showcase'
import { cn } from '@/shared/cn'
import { formatTaipeiMinute } from '@/shared/time'

export const metadata = { title: '精選｜資管系專題平台' }

/**
 * 管理員「精選」（票 25／S11-03；原型沒有獨立頁，沿用簽核頁版型：上面建立、下面逐組）。
 *
 * 替一組建精選草稿，填題目、摘要、海報、影片連結後儲存；**只存草稿、不發布**。這份草稿之後被「最終文件授權」的
 * 簽核版本拿去凍結授權範圍（改草稿不影響已凍結的版本）。公開閘門在 S12，閘門欄固定顯示「尚無授權」。
 */
export default async function AdminShowcasePage({ searchParams }: { searchParams: Promise<{ cohort?: string | string[] }> }) {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  const actor = await requireRole('/dashboard/admin/showcase', 'admin')

  const cohorts = (await getCohortStatusQuery().list()).filter((c) => c.status !== 'archived')
  const params = await searchParams
  const cohort = cohorts.find((c) => c.id === params.cohort) ?? cohorts.find((c) => c.isDefaultWorking) ?? cohorts[0] ?? null

  const shell = (children: React.ReactNode) => (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current="/dashboard/admin/showcase">
      <PageHeader title="精選" description="替各組準備精選的題目、摘要、海報與影片連結；草稿不會公開。" />
      {children}
    </DashboardShell>
  )

  if (!cohort) {
    return shell(
      <EmptyState title="還沒有屆別" description="先到屆別頁新增一屆，才能替那一屆的組別建精選草稿。" action={{ href: '/dashboard/admin/cohorts', label: '前往屆別' }} />,
    )
  }

  const board = await getShowcaseQuery().adminBoard(actor, cohort.id)
  if (!board.ok) return shell(<EmptyState title="讀不到精選資料" description={board.message} />)
  const { drafts, groups } = board.receipt
  const withoutDraft = groups.filter((g) => g.entryId === null)

  return shell(
    <>
      {cohorts.length > 1 ? (
        <nav aria-label="選擇屆別" className="mb-4 flex flex-wrap gap-2">
          {cohorts.map((c) => (
            <Link
              key={c.id}
              href={`/dashboard/admin/showcase?cohort=${c.id}`}
              aria-current={c.id === cohort.id ? 'page' : undefined}
              className={cn(
                'rounded-full border px-3 py-1 text-sm',
                c.id === cohort.id ? 'border-primary bg-primary-subtle text-primary-on-subtle' : 'border-border text-ink hover:bg-muted',
              )}
            >
              {c.code}
            </Link>
          ))}
        </nav>
      ) : null}

      <Card
        title="建立精選草稿"
        description="一組一屆只有一份草稿。發布功能尚未交付：草稿只存不發布，之後要經授權、個資檢查與素材核閱才會公開。"
        className="mb-6"
      >
        {groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">這一屆還沒有組別；分組成立後才能建立精選草稿。</p>
        ) : (
          <CreateDraftForm groups={withoutDraft} requestId={randomUUID()} />
        )}
      </Card>

      <section aria-label="精選草稿" className="space-y-4">
        <h2 className="text-base font-semibold text-ink">草稿列表</h2>
        {drafts.length === 0 ? (
          <EmptyState title="尚無精選草稿" description="在上面選一組建立草稿，填好題目、摘要、海報與影片連結後儲存。" />
        ) : (
          drafts.map((d) => (
            <article key={d.entryId} className="rounded-card border border-border bg-background p-5" data-testid="showcase-draft">
              <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold text-ink">{d.groupCode}</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    最後儲存 {formatTaipeiMinute(d.updatedAt)}
                    {d.updatedByName ? `・${d.updatedByName}` : ''}
                    {d.frozenInVersions > 0 ? `・已有 ${d.frozenInVersions} 個簽核版本從這份草稿凍結授權範圍（改草稿不影響它們）` : ''}
                  </p>
                </div>
                <dl className="flex gap-4 text-xs">
                  <div>
                    <dt className="text-muted-foreground">狀態</dt>
                    <dd className="font-medium text-ink">草稿</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">公開閘門</dt>
                    <dd className="font-medium text-ink" data-testid="gate">
                      {GATE_PLACEHOLDER}
                    </dd>
                  </div>
                </dl>
              </header>
              <DraftEditor
                entryId={d.entryId}
                groupCode={d.groupCode}
                revision={d.revision}
                title={d.title}
                summary={d.summary}
                videoUrl={d.videoUrl}
                poster={d.poster ? { fileId: d.poster.fileId, name: d.poster.name } : null}
                requestId={randomUUID()}
                disabled={board.receipt.cohort.archived || d.groupDissolved}
              />
            </article>
          ))
        )}
      </section>
    </>,
  )
}
