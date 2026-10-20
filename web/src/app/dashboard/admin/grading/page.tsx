import Link from 'next/link'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { CohortPills, PageTitle, QuietState } from '@/app/_ui/dashboard/primitives'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { AdminTabs } from '@/app/dashboard/admin/_tabs'
import { GRADING_TABS } from '@/app/dashboard/admin/_tabs.consts'
import { GradeTable } from '@/app/dashboard/admin/grading/_content/grade-table'
import { cohortLabel, getCohortStatusQuery } from '@/composition/cohorts'

export const metadata = { title: '成績｜資管系專題平台' }

const BASE = '/dashboard/admin/grading'
const RULES = `${BASE}/rules`

/**
 * 系辦「成績」的「成績表」分頁殼（AD-08；C 階段規格② §2.2）：守衛、屆別膠囊、分頁列；內容是規格①的 `GradeTable`
 * （評分進度卡片、成績表與匯出、需要重新確認的更正，見 `_content/grade-table.tsx`）。
 * 評分規則、評分老師、結算是另外三個分頁；計算明細、退回、更正與復核在 `/dashboard/admin/grading/<組別>`。
 *
 * 讀取兩次：屆別清單（這裡）、屆別評分快照（`GradeTable`，≤32 句 SQL，AC-A-15）。
 */
export default async function AdminGradingPage({
  searchParams,
}: {
  searchParams: Promise<{
    cohort?: string | string[]
    stage?: string | string[]
    fstage?: string | string[]
    fgroup?: string | string[]
    fstatus?: string | string[]
    applied?: string | string[]
  }>
}) {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  await requireRole(BASE, 'admin')

  // 封存的屆別也可選（產品模組 02 §11.3「封存後…管理員可查與匯出」）：只能看與匯出。
  const cohorts = await getCohortStatusQuery().list()
  const params = await searchParams
  const cohort =
    cohorts.find((c) => c.id === params.cohort) ??
    cohorts.find((c) => c.isDefaultWorking) ??
    cohorts.find((c) => c.status !== 'archived') ??
    cohorts[0] ??
    null

  const shell = (children: React.ReactNode) => (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current={BASE}>
      <div className="flex flex-col gap-5">
        <div>
          <PageTitle title="成績" />
          <AdminTabs
            label="成績分頁"
            current={BASE}
            items={GRADING_TABS}
            actions={
              <Link
                href={cohort ? `${RULES}?cohort=${cohort.id}` : RULES}
                className="inline-flex min-h-9 items-center px-2 text-sm font-semibold text-primary underline-offset-2 hover:underline"
              >
                評分規則<span aria-hidden>&nbsp;↗</span>
              </Link>
            }
          />
        </div>
        <p data-testid="tab-intro" className="-mt-2 mb-4 text-sm text-muted-foreground">
          每一組各評分項目的成績與老師的評分進度。
        </p>
        {/* 屆別膠囊獨立一列：測試站屆別多，跟分頁擠同一列會把分頁推亂（網站問題 #8）。 */}
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

  return shell(<GradeTable cohortId={cohort.id} searchParams={params} />)
}
