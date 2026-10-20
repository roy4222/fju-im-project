import Link from 'next/link'
import { requireRole } from '@/app/_ui/guard'
import { PageTitle, pillClass } from '@/app/_ui/dashboard-kit'
import { EmptyState } from '@/app/_ui/primitives'
import { DashboardShell } from '@/app/_ui/site-shell'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { AdminTabs } from '@/app/dashboard/admin/_tabs'
import { AFFAIRS_TABS } from '@/app/dashboard/admin/_tabs.consts'
import { NewItemButton } from '@/app/dashboard/admin/affairs/_content/list-actions'
import { RulesEditor } from '@/app/dashboard/admin/affairs/_content/rules-editor'
import { affairsView } from '@/app/dashboard/admin/affairs/affairs-view'
import { editorVocabulary } from '@/app/dashboard/admin/affairs/vocabulary'
import { cohortLabel, getCohortStatusQuery } from '@/composition/cohorts'

export const metadata = { title: '專題規則｜資管系專題平台' }

const BASE = '/dashboard/admin/affairs/rules'

/**
 * 公告與作業的「專題規則」分頁（C 階段規格② §2.2）：舊 `?placement=rules` 轉到這裡。
 *
 * 說明句以下的內容歸規格①：`RulesEditor`（C1-08；一頁編輯全文＋章節拖曳排序，上移／下移保留）。
 * 封存屆別不會出現（`affairsView` 只列未封存的）。
 */
export default async function AffairsRulesPage({ searchParams }: { searchParams: Promise<{ cohort?: string | string[] }> }) {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  await requireRole(BASE, 'admin')

  const view = affairsView(await getCohortStatusQuery().list(), { cohort: (await searchParams).cohort })

  const shell = (children: React.ReactNode, actions?: React.ReactNode) => (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current={BASE}>
      <PageTitle title="公告與作業" />
      <div className="mt-4">
        <AdminTabs label="公告與作業分頁" current={BASE} items={AFFAIRS_TABS} actions={actions} />
      </div>
      <p data-testid="tab-intro" className="-mt-2 mb-4 text-sm text-muted-foreground">
        專題規則的各個章節；前台「專題規則」照這裡的順序顯示，用上移、下移調整。
      </p>
      <div className="flex flex-col gap-5">{children}</div>
    </DashboardShell>
  )

  if (view.state !== 'ok') {
    return shell(
      <EmptyState
        title={view.state === 'none' ? '還沒有屆別' : '屆別都已封存'}
        description="專題規則要綁在某一屆；先到屆別頁新增一屆。"
        action={{ href: '/dashboard/admin/cohorts', label: '前往屆別' }}
      />,
    )
  }

  const { cohorts, cohort } = view
  const vocabulary = await editorVocabulary(cohort.id)

  return shell(
    <>
      {cohorts.length > 1 ? (
        <nav aria-label="選擇屆別" className="flex flex-wrap gap-1.5">
          {cohorts.map((c) => (
            <Link
              key={c.id}
              href={`${BASE}?cohort=${c.id}`}
              aria-current={c.id === cohort.id ? 'page' : undefined}
              className={pillClass(c.id === cohort.id)}
            >
              {cohortLabel(c)}
            </Link>
          ))}
        </nav>
      ) : null}
      <RulesEditor cohortId={cohort.id} />
    </>,
    <>
      <NewItemButton cohortId={cohort.id} vocabulary={vocabulary} placement="rules" noun="規則" />
    </>,
  )
}
