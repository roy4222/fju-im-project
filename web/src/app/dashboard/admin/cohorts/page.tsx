import { randomUUID } from 'node:crypto'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { Card, PageHeader } from '@/app/_ui/primitives'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { CohortTable, CreateCohortForm, type CohortRow } from '@/app/dashboard/admin/cohorts/cohort-forms'
import {
  COHORT_CODE_MAX_LENGTH,
  COHORT_FLAG_LABEL,
  COHORT_NAME_MAX_LENGTH,
  COHORT_STATUS_LABEL,
  getCohortStatusQuery,
} from '@/composition/cohorts'

export const metadata = { title: '屆別｜資管系專題平台' }

/**
 * 屆別頁（票 5）：新增屆別、看狀態、指定「預設工作屆別」與「開放註冊屆別」。
 *
 * 票 11 加上「轉為進行中」（要先在時間軸設好階段與年度結束日）；封存與解封在後面的票。
 */
export default async function AdminCohortsPage() {
  // 授權檢查在**頁面自己**：放在 layout 擋不住，App Router 會把 layout 與 page 並行渲染，
  // layout 丟掉 children 或 redirect 都來不及——那一頁已經被做出來、跟著 payload 送走了。
  await requireRole('/dashboard/admin/cohorts', 'admin')

  const cohorts = await getCohortStatusQuery().list()
  const registrationOpen = cohorts.find((cohort) => cohort.isRegistrationOpen) ?? null

  const rows: CohortRow[] = cohorts.map((cohort) => ({
    id: cohort.id,
    code: cohort.code,
    name: cohort.name,
    statusLabel: COHORT_STATUS_LABEL[cohort.status],
    canActivate: cohort.status === 'preparing',
    isDefaultWorking: cohort.isDefaultWorking,
    isRegistrationOpen: cohort.isRegistrationOpen,
    // 每次渲染都發新的編號：成功後頁面重整就換一組，同一張表單重送才會被認成同一次。
    requestIds: { defaultWorking: randomUUID(), registrationOpen: randomUUID(), activate: randomUUID() },
  }))

  return (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current="/dashboard/admin/cohorts">
      <PageHeader title="屆別" description="一屆專題從開放註冊到封存的整個流程。" />

      {registrationOpen ? null : (
        <div
          role="note"
          aria-label="尚未設定開放註冊屆別"
          className="mb-6 rounded-card border border-primary/40 bg-primary-subtle px-4 py-3 text-sm text-primary-on-subtle"
        >
          <p className="font-medium">還沒有設定開放註冊屆別</p>
          <p className="mt-1">
            沒命中名單的註冊者要靠它決定歸到哪一屆；沒有設定時，審核註冊會先請你指定，系統不會自己猜。
            {cohorts.length === 0 ? '先新增一屆，' : '在下面表格挑一屆，'}按「開放註冊」。
          </p>
        </div>
      )}

      <Card title="新增屆別" className="mb-6">
        <CreateCohortForm
          requestId={randomUUID()}
          codeMaxLength={COHORT_CODE_MAX_LENGTH}
          nameMaxLength={COHORT_NAME_MAX_LENGTH}
        />
      </Card>

      <CohortTable rows={rows} flagLabels={COHORT_FLAG_LABEL} />
      <p className="mt-3 text-xs text-muted-foreground">
        預設工作屆別與開放註冊屆別全系各只有一個；把它交給另一屆時，原本那一屆會自動取消。
        轉為進行中前，先到「時間軸」設好四個階段與年度結束日。
      </p>
    </DashboardShell>
  )
}
