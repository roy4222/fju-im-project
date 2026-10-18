import { randomUUID } from 'node:crypto'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { PageTitle } from '@/app/_ui/dashboard/primitives'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { AdminTabs } from '@/app/dashboard/admin/_tabs'
import { SETTINGS_TABS } from '@/app/dashboard/admin/_tabs.consts'
import { CohortCards, CreateCohortForm, type CohortRow } from '@/app/dashboard/admin/cohorts/cohort-forms'
import {
  COHORT_CODE_MAX_LENGTH,
  COHORT_FLAG_LABEL,
  COHORT_NAME_MAX_LENGTH,
  COHORT_STATUS_LABEL,
  COHORT_STATUS_REASON_MAX_LENGTH,
  cohortLabel,
  getCohortStatusQuery,
  getTimelineQuery,
  STAGE_COUNT,
} from '@/composition/cohorts'
import { getGroupQuery } from '@/composition/groups'
import { formatTaipeiMinute } from '@/shared/time'

export const metadata = { title: '屆別｜資管系專題平台' }

/**
 * 封存按鈕不能按時寫在旁邊的那一句；能按回 null。條件照用例的封存前置（`pg-cohorts.ts` 的 `#changeStatus`），
 * 這裡只是先在畫面上說，用例仍會再擋一次。已封存的卡沒有封存鈕（只剩「恢復」），不用原因。
 */
function archiveBlockedReason(cohort: { status: string; isDefaultWorking: boolean; isRegistrationOpen: boolean }): string | null {
  if (cohort.status === 'archived') return null
  if (cohort.status === 'preparing') return '還沒啟用的屆別不能封存'
  if (cohort.isDefaultWorking) return '這一屆是預設工作屆別，先把旗標換到別屆'
  if (cohort.isRegistrationOpen) return '這一屆是開放註冊屆別，先把旗標換到別屆'
  return null
}

/**
 * 屆別頁（票 5）：新增屆別、看狀態、指定「預設工作屆別」與「開放註冊屆別」。
 *
 * 票 11 加上「轉為進行中」（要先在時間軸設好階段與年度結束日）；第三波放進危險操作區、先確認再送。
 * AD-B4：進行中的卡有「封存」，已封存的卡顯示封存時間與「恢復」（解除封存），兩者都要填理由。
 * AD-12：掛「設定」分頁列，表格改每屆一張卡（學生數、組數），新增表單搬到分頁列右側。
 * C2-06（設計方案 §4.1）：「新增屆別」改按鈕開視窗；卡上按鈕只剩「編輯」「封存」，危險區拿掉；
 * 不能封存時按鈕 disabled，旁邊寫原因。
 */
export default async function AdminCohortsPage() {
  // 授權檢查在**頁面自己**：放在 layout 擋不住，App Router 會把 layout 與 page 並行渲染，
  // layout 丟掉 children 或 redirect 都來不及——那一頁已經被做出來、跟著 payload 送走了。
  await requireRole('/dashboard/admin/cohorts', 'admin')

  const cohorts = await getCohortStatusQuery().list()
  const registrationOpen = cohorts.find((cohort) => cohort.isRegistrationOpen) ?? null
  const defaultWorking = cohorts.find((cohort) => cohort.isDefaultWorking) ?? null
  // 卡上的學生數、組數：一句 SQL 算完全部屆別（不逐屆查），沒出現在 Map 裡的屆別是 0。
  const counts = await getGroupQuery().countsByCohort()
  // 籌備中的屆別才有「轉為進行中」：先看時程排好了沒（四個階段＋年度結束日，跟用例的前置相同），沒排好就停用並寫原因。
  // 只查籌備中的屆，通常只有一兩屆。
  const scheduleReady = new Map(
    await Promise.all(
      cohorts
        .filter((cohort) => cohort.status === 'preparing')
        .map(async (cohort) => {
          const schedule = await getTimelineQuery().schedule(cohort.id)
          return [cohort.id, schedule.stages.length === STAGE_COUNT && schedule.yearEndDate !== null] as const
        }),
    ),
  )

  const rows: CohortRow[] = cohorts.map((cohort) => ({
    id: cohort.id,
    code: cohort.code,
    name: cohort.name,
    label: cohortLabel(cohort),
    statusLabel: COHORT_STATUS_LABEL[cohort.status],
    archived: cohort.status === 'archived',
    archivedAtLabel: cohort.archivedAt ? formatTaipeiMinute(cohort.archivedAt) : null,
    canArchive: archiveBlockedReason(cohort) === null,
    archiveBlockedReason: archiveBlockedReason(cohort),
    canActivate: cohort.status === 'preparing',
    activateBlockedReason: scheduleReady.get(cohort.id) === false ? '先到專題時程排好四個階段' : null,
    isDefaultWorking: cohort.isDefaultWorking,
    isRegistrationOpen: cohort.isRegistrationOpen,
    studentCount: counts.get(cohort.id)?.students ?? 0,
    groupCount: counts.get(cohort.id)?.groups ?? 0,
    // 每次渲染都發新的編號：成功後頁面重整就換一組，同一張表單重送才會被認成同一次。
    requestIds: {
      defaultWorking: randomUUID(),
      registrationOpen: randomUUID(),
      activate: randomUUID(),
      archive: randomUUID(),
      unarchive: randomUUID(),
    },
  }))

  return (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current="/dashboard/admin/cohorts">
      {/* 分頁列自帶下方間距（`mb-5`），所以標題＋分頁列在外層，內容另一層 `gap-5`。 */}
      <div>
        <PageTitle title="設定" />
        <div className="mt-3">
          <AdminTabs
            label="設定分頁"
            current="/dashboard/admin/cohorts"
            items={SETTINGS_TABS}
            actions={<CreateCohortForm requestId={randomUUID()} codeMaxLength={COHORT_CODE_MAX_LENGTH} nameMaxLength={COHORT_NAME_MAX_LENGTH} />}
          />
        </div>
        <p data-testid="tab-intro" className="-mt-2 mb-4 text-sm text-muted-foreground">
          每一屆的開始、旗標與狀態；新註冊的人會加入開放註冊的那一屆。
        </p>
        <div className="flex flex-col gap-5">
          {registrationOpen ? null : (
            <div
              role="note"
              aria-label="尚未設定新註冊學生加入的屆別"
              className="rounded-[14px] border border-brand/30 bg-brand-subtle px-5 py-3.5 text-sm text-brand-on-subtle"
            >
              <p className="font-bold">還沒有設定新註冊學生加入的屆別</p>
              <p className="mt-1">
                不在本屆名單上的註冊者要靠它決定歸到哪一屆；沒有設定時，審核註冊會先請你指定，系統不會自己猜。
                {cohorts.length === 0 ? '先新增一屆，' : '在下面挑一屆，'}
                按「編輯」裡的「設為新註冊加入的屆別」。
              </p>
            </div>
          )}

          {/* 兩個全系唯一的旗標：卡片列上方一行看目前是哪一屆；要換就開那一屆卡上的「編輯」。 */}
          {cohorts.length > 0 ? (
            <p className="text-sm text-muted-foreground">
              {COHORT_FLAG_LABEL.defaultWorking}：
              <span className="font-semibold text-foreground">{defaultWorking ? cohortLabel(defaultWorking) : '未設定'}</span>
              <span aria-hidden>・</span>
              {COHORT_FLAG_LABEL.registrationOpen}：
              <span className="font-semibold text-foreground">{registrationOpen ? cohortLabel(registrationOpen) : '未設定'}</span>
              。交給另一屆時，原本那一屆會自動取消。
            </p>
          ) : null}

          <CohortCards rows={rows} flagLabels={COHORT_FLAG_LABEL} reasonMaxLength={COHORT_STATUS_REASON_MAX_LENGTH} />
        </div>
      </div>
    </DashboardShell>
  )
}
