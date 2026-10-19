import Link from 'next/link'
import { requireRole } from '@/app/_ui/guard'
import { CohortPills, PageTitle, QuietState } from '@/app/_ui/dashboard/primitives'
import { DashboardShell } from '@/app/_ui/site-shell'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { AdminTabs } from '@/app/dashboard/admin/_tabs'
import { GRADING_TABS } from '@/app/dashboard/admin/_tabs.consts'
import { EvaluatorsPanel } from '@/app/dashboard/admin/grading/_content/evaluators-panel'
import { cohortLabel, getCohortStatusQuery } from '@/composition/cohorts'

export const metadata = { title: '評分老師｜資管系專題平台' }

const BASE = '/dashboard/admin/grading/teachers'

/**
 * 成績的「評分老師」分頁殼（C 階段規格② §2.2）：守衛、標題、分頁列、說明句、屆別膠囊；內容是規格①的 `EvaluatorsPanel`
 * （每組要幾位老師評與指派，見 `_content/evaluators-panel.tsx`；`?group=&stage=` 高亮那一列）。
 * 說明句是這條路由的 e2e 指紋（`e2e/fingerprints.ts`），改句子要一起改。
 */
export default async function GradingTeachersPage({
  searchParams,
}: {
  searchParams: Promise<{ cohort?: string | string[]; group?: string | string[]; stage?: string | string[] }>
}) {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  await requireRole(BASE, 'admin')

  const cohorts = await getCohortStatusQuery().list()
  const params = await searchParams
  const cohort =
    cohorts.find((c) => c.id === params.cohort) ??
    cohorts.find((c) => c.isDefaultWorking) ??
    cohorts.find((c) => c.status !== 'archived') ??
    cohorts[0] ??
    null

  return (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current={BASE}>
      <div className="flex flex-col gap-5">
        <div>
          <PageTitle title="成績" />
          <div className="mt-4">
            <AdminTabs label="成績分頁" current={BASE} items={GRADING_TABS} />
          </div>
          <p data-testid="tab-intro" className="-mt-2 text-sm text-muted-foreground">
            每一組由哪幾位老師評分，以及指派與改派。
          </p>
        </div>
        {cohort ? (
          <CohortPills
            cohorts={cohorts.map((c) => ({ id: c.id, code: c.status === 'archived' ? `${cohortLabel(c)}・已封存` : cohortLabel(c) }))}
            currentId={cohort.id}
            hrefFor={(id) => `${BASE}?cohort=${id}`}
          />
        ) : null}
        {cohort ? (
          <EvaluatorsPanel cohortId={cohort.id} searchParams={params} />
        ) : (
          <QuietState
            title="還沒有屆別"
            action={
              <Link href="/dashboard/admin/cohorts" className="text-sm font-semibold text-primary hover:underline">
                前往屆別
              </Link>
            }
          />
        )}
      </div>
    </DashboardShell>
  )
}
