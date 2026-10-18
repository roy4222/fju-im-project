import Link from 'next/link'
import { requireRole } from '@/app/_ui/guard'
import { PageTitle, pillClass } from '@/app/_ui/dashboard-kit'
import { EmptyState, LinkButton } from '@/app/_ui/primitives'
import { DashboardShell } from '@/app/_ui/site-shell'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { AdminTabs } from '@/app/dashboard/admin/_tabs'
import { AFFAIRS_TABS } from '@/app/dashboard/admin/_tabs.consts'
import { AffairsList } from '@/app/dashboard/admin/affairs/affairs-list'
import { AFFAIRS_TAB_PLACEMENTS, affairsView, toAffairRow } from '@/app/dashboard/admin/affairs/affairs-view'
import { QuickCreateDialog } from '@/app/dashboard/admin/affairs/quick-create-dialog'
import { editorVocabulary } from '@/app/dashboard/admin/affairs/vocabulary'
import { cohortLabel, getBusinessClock, getCohortStatusQuery } from '@/composition/cohorts'
import { getItemQuery } from '@/composition/items'

export const metadata = { title: '作業｜資管系專題平台' }

const BASE = '/dashboard/admin/affairs/assignments'
const PLACEMENTS: readonly string[] = AFFAIRS_TAB_PLACEMENTS.assignments

/**
 * 公告與作業的「作業」分頁（C 階段規格② §2.2）：文件繳交與專題需求，接既有的 `AffairsList`（舊 `?placement=submission|requirement`）。
 * 說明句以下的內容歸規格①；按鈕文字 C2-03 再改。
 */
export default async function AffairsAssignmentsPage({ searchParams }: { searchParams: Promise<{ cohort?: string | string[] }> }) {
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
        要學生或組別繳交的作業與專題需求；點「需要繳交」看誰還沒交。
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
  const [rows, vocabulary, businessNow] = await Promise.all([
    getItemQuery().list(cohort.id),
    editorVocabulary(cohort.id),
    getBusinessClock().now(),
  ])
  const list = rows.filter((r) => PLACEMENTS.includes(r.placement)).map((r) => toAffairRow(r, businessNow))

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
      <AffairsList rows={list} filters={[]} emptyText="這一屆還沒有作業。按「新增項目」建立第一筆。" />
    </>,
    <>
      <LinkButton href={`/dashboard/admin/editor/new?cohort=${cohort.id}`} variant="secondary">
        完整編輯器
      </LinkButton>
      <QuickCreateDialog cohortId={cohort.id} vocabulary={vocabulary} />
    </>,
  )
}
