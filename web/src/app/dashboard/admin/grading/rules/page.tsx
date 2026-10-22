import Link from 'next/link'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { CohortPills, PageTitle, QuietState } from '@/app/_ui/dashboard/primitives'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { AdminTabs } from '@/app/dashboard/admin/_tabs'
import { GRADING_TABS } from '@/app/dashboard/admin/_tabs.consts'
import { GradingRulesPanel } from '@/app/dashboard/admin/grading/_content/rules-panel'
import { cohortLabel, getCohortStatusQuery } from '@/composition/cohorts'

export const metadata = { title: '評分規則｜資管系專題平台' }

const GRADING = '/dashboard/admin/grading'
const BASE = `${GRADING}/rules`

/**
 * 系辦「成績」的「評分規則」分頁殼（AD-08；C 階段規格② §2.2）：守衛、標題、「← 回成績」、分頁列、屆別膠囊；
 * 內容是規格①的 `GradingRulesPanel`（目前版本、評分項目的對應作業／說明／評審組、版本紀錄，見 `_content/rules-panel.tsx`）。
 * 每組要幾位老師評與指派在「評分老師」分頁。守衛在頁面自己（`_nav.ts` 的 `PROTECTED_ROUTES` 有這一列，pages.spec 逐條驗三種回應）。
 */
export default async function AdminGradingRulesPage({
  searchParams,
}: {
  searchParams: Promise<{ cohort?: string | string[] }>
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

  const shell = (children: React.ReactNode) => (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current={GRADING}>
      <div className="flex flex-col gap-5">
        <div>
          <Link
            href={cohort ? `${GRADING}?cohort=${cohort.id}` : GRADING}
            className="mb-3 inline-flex text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            ← 回成績
          </Link>
          <PageTitle title="評分規則" />
          <div className="mt-4">
            <AdminTabs label="成績分頁" current={BASE} items={GRADING_TABS} />
          </div>
          <p data-testid="tab-intro" className="-mt-2 text-sm text-muted-foreground">
            評分項目、比例、細項與版本紀錄，以及每個評分項目的對應作業、說明與評審組。
          </p>
        </div>
        {/* 屆別膠囊獨立一列：測試站屆別多，放標題列右邊會把標題擠成直排（網站問題 #8）。 */}
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
        hint="先新增一屆，才能設定評分規則。"
        action={
          <Link href="/dashboard/admin/cohorts" className="text-sm font-semibold text-primary hover:underline">
            前往屆別
          </Link>
        }
      />,
    )
  }

  return shell(<GradingRulesPanel cohortId={cohort.id} />)
}
