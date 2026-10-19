import Link from 'next/link'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { CohortPills, PageTitle, QuietState } from '@/app/_ui/dashboard/primitives'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { AdminTabs } from '@/app/dashboard/admin/_tabs'
import { GRADING_TABS } from '@/app/dashboard/admin/_tabs.consts'
import { SettlementPanel } from '@/app/dashboard/admin/grading/_content/settlement-panel'
import { cohortLabel, getCohortStatusQuery } from '@/composition/cohorts'

export const metadata = { title: '成績結算｜資管系專題平台' }

const GRADING = '/dashboard/admin/grading'
const BASE = `${GRADING}/settle`

/**
 * 系辦「成績」的「結算」分頁殼（B 階段 AD-B1；C 階段規格② §2.2）：守衛、屆別膠囊、分頁列；
 * 內容是規格①的 `SettlementPanel`（`_content/settlement-panel.tsx`）。讀取三次：屆別（這裡）、`gradebook`、`settlements`。
 */
export default async function AdminGradingSettlePage({ searchParams }: { searchParams: Promise<{ cohort?: string | string[] }> }) {
  // 授權檢查在**頁面自己**（見 `_nav.ts` 與 `guard.ts`）。
  await requireRole(BASE, 'admin')
  const cohorts = await getCohortStatusQuery().list()
  const params = await searchParams
  const cohort =
    cohorts.find((c) => c.id === params.cohort) ??
    cohorts.find((c) => c.isDefaultWorking) ??
    cohorts.find((c) => c.status !== 'archived') ??
    cohorts[0] ??
    null

  const shell = (children: React.ReactNode) => (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current={GRADING}>
      <div className="flex flex-col gap-5">
        <div>
          <PageTitle title="成績" />
          <AdminTabs label="成績分頁" current={BASE} items={GRADING_TABS} />
        </div>
        <p data-testid="tab-intro" className="-mt-2 mb-4 text-sm text-muted-foreground">
          把老師送出的評分結算成各階段的正式成績。
        </p>
        {cohort ? (
          <CohortPills
            cohorts={cohorts.map((c) => ({ id: c.id, code: c.status === 'archived' ? `${cohortLabel(c)}・已封存` : cohortLabel(c) }))}
            currentId={cohort.id}
            hrefFor={(id) => `${BASE}?cohort=${id}`}
          />
        ) : null}
        {children}
      </div>
    </DashboardShell>
  )

  if (!cohort) {
    return shell(
      <QuietState
        title="還沒有屆別"
        action={
          <Link href="/dashboard/admin/cohorts" className="text-sm font-semibold text-primary hover:underline">
            前往屆別
          </Link>
        }
      />,
    )
  }

  return shell(<SettlementPanel cohortId={cohort.id} />)
}
