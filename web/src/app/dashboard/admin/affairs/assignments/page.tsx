import Link from 'next/link'
import { requireRole } from '@/app/_ui/guard'
import { PageTitle, pillClass } from '@/app/_ui/dashboard-kit'
import { EmptyState } from '@/app/_ui/primitives'
import { DashboardShell } from '@/app/_ui/site-shell'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { AdminTabs } from '@/app/dashboard/admin/_tabs'
import { AFFAIRS_TABS } from '@/app/dashboard/admin/_tabs.consts'
import { AffairsAssignmentList } from '@/app/dashboard/admin/affairs/_content/assignment-list'
import { AssignmentListActions } from '@/app/dashboard/admin/affairs/_content/list-actions'
import { affairsView } from '@/app/dashboard/admin/affairs/affairs-view'
import { editorVocabulary } from '@/app/dashboard/admin/affairs/vocabulary'
import { cohortLabel, getCohortStatusQuery } from '@/composition/cohorts'

export const metadata = { title: '作業｜資管系專題平台' }

const BASE = '/dashboard/admin/affairs/assignments'

/**
 * 公告與作業的「作業」分頁（C 階段規格② §2.2）：文件繳交與專題需求，掛規格①的 `AffairsAssignmentList`（舊 `?placement=submission|requirement`）。
 * 說明句以下的內容歸規格①。
 */
export default async function AffairsAssignmentsPage({ searchParams }: { searchParams: Promise<{ cohort?: string | string[] }> }) {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  await requireRole(BASE, 'admin')

  const params = await searchParams
  const view = affairsView(await getCohortStatusQuery().list(), { cohort: params.cohort })

  const shell = (children: React.ReactNode, actions?: React.ReactNode) => (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current={BASE}>
      <PageTitle title="公告與作業" />
      <div className="mt-4">
        <AdminTabs label="公告與作業分頁" current={BASE} items={AFFAIRS_TABS} actions={actions} />
      </div>
      <p data-testid="tab-intro" className="-mt-2 mb-4 text-sm text-muted-foreground">
        要學生或組別繳交的作業與專題需求；點標題看誰還沒交。
      </p>
      <div className="flex flex-col gap-5">{children}</div>
    </DashboardShell>
  )

  if (view.state !== 'ok') {
    return shell(
      <EmptyState
        title={view.state === 'none' ? '還沒有屆別' : '屆別都已封存'}
        description="作業要綁在某一屆；先到屆別頁新增一屆。"
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
      <AffairsAssignmentList cohortId={cohort.id} searchParams={params} />
    </>,
    <>
      <AssignmentListActions cohortId={cohort.id} vocabulary={vocabulary} />
    </>,
  )
}
