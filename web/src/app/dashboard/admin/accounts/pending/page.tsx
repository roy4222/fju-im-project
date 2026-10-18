import { IconUserCheck } from '@tabler/icons-react'
import { requireRole } from '@/app/_ui/guard'
import { PageTitle, Panel, PanelEmpty } from '@/app/_ui/dashboard/primitives'
import { DashboardShell } from '@/app/_ui/site-shell'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { AdminTabs } from '@/app/dashboard/admin/_tabs'
import { ACCOUNT_TABS } from '@/app/dashboard/admin/_tabs.consts'
import {
  EVIDENCE_LABEL,
  EVIDENCE_NEEDS_ATTENTION,
  getRegistrationCommand,
  VERIFICATION_LABEL,
  VERIFICATION_METHODS,
  VERIFICATION_NOTE_HINT,
  VERIFICATION_NOTE_REQUIRED,
} from '@/composition/accounts'
import { formatTaipeiMinute } from '@/shared/time'
import { BulkApproveCheckbox, BulkApproveDialog, BulkApproveProvider, BulkApproveSelectAll } from '../bulk-approve-dialog'
import { EvidencePills, ReviewDialog, type ReviewLabels } from '../review-dialog'

const REVIEW_LABELS: ReviewLabels = {
  evidence: EVIDENCE_LABEL,
  attention: EVIDENCE_NEEDS_ATTENTION,
  // google_email_match 是系統自動開通寫的（VB-6），系辦不能選；與 MANUAL_VERIFICATION_METHODS 同一份清單。
  methods: VERIFICATION_METHODS.filter((m) => m !== 'google_email_match'),
  methodLabel: VERIFICATION_LABEL,
  noteRequired: VERIFICATION_NOTE_REQUIRED,
  noteHint: VERIFICATION_NOTE_HINT,
}

export const metadata = { title: '待審核｜資管系專題平台' }

const BASE = '/dashboard/admin/accounts/pending'

/**
 * 帳號的「待審核」分頁（C 階段規格② §3.3）：原本在帳號頁最上面的待審 Panel 搬到這裡（C2-07），審核與批次核准的對話框不動
 * （核准一鍵、退回、去掉核實方式在 C2-10）。說明句是這條路由的 e2e 指紋（`e2e/fingerprints.ts`），改句子要一起改。
 */
export default async function AccountsPendingPage() {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  const actor = await requireRole(BASE, 'admin')

  // 用例自己再判一次授權（頁面通過不代表用例會放行）。
  const pendingResult = await getRegistrationCommand().listPending(actor)
  const pending = pendingResult.ok ? pendingResult.receipt : null
  const applications = pending?.applications ?? []
  // 名單比對不到或資料不符的人不能批次核准（伺服器會略過），勾到時按鈕旁提醒要逐一核對（Q93）。
  const offRosterIds = applications.filter((a) => a.match.status !== 'matched').map((a) => a.applicationId)

  return (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current={BASE}>
      <PageTitle title="帳號" />
      <div className="mt-4">
        <AdminTabs label="帳號分頁" current={BASE} items={ACCOUNT_TABS} />
      </div>
      <p data-testid="tab-intro" className="-mt-2 mb-4 text-sm text-muted-foreground">
        註冊後等系辦確認身分的申請，核准後才能登入使用。
      </p>
      {/* 第三波 W6：勾選後「核准勾選的 N 位」一起核准；需要人判斷的列由伺服器自動略過並寫原因。 */}
      <BulkApproveProvider pendingIds={applications.map((a) => a.applicationId)}>
        <Panel
          title={pending ? `待審核 ${applications.length} 位` : '待審核'}
          icon={<IconUserCheck />}
          description="名單比對只協助判斷，不會自動核准；核准前請以校方既有方式核對本人"
          action={
            applications.length > 0 ? (
              <div className="flex flex-wrap items-center gap-3">
                <label className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                  <BulkApproveSelectAll applicationIds={applications.map((a) => a.applicationId)} />
                  全選
                </label>
                <BulkApproveDialog labels={REVIEW_LABELS} offRosterIds={offRosterIds} />
              </div>
            ) : null
          }
          aria-label="待審核"
        >
          {pending && !pending.registrationOpenCohort ? (
            <p className="mx-5 mb-3 rounded-lg bg-brand-subtle px-3 py-2 text-sm text-brand-on-subtle" role="note">
              目前沒有設定新註冊學生加入的屆別：不在本屆名單上的人核准時要手動選屆別。可以到「屆別」頁設定。
            </p>
          ) : null}
          {!pending ? (
            <p role="alert" className="mx-5 mb-5 text-sm text-destructive">
              待審核清單載入失敗，請重新整理頁面。
            </p>
          ) : applications.length === 0 ? (
            <PanelEmpty title="目前沒有待審核的申請。" hint="學生改過資料時，要重新打開核對才能核准。" />
          ) : (
            // 每人一張卡。外層仍是 table／row：卡片是一列一列的同款資料，讀屏照表格念，既有 e2e 也照列找人。
            <table aria-label="待審核清單" className="block px-5 pb-5">
              <thead className="sr-only">
                <tr>
                  {['勾選', '姓名與 Email', '學號與系級', '比對結果', '送出時間', '操作'].map((h) => (
                    <th key={h} scope="col">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
                {applications.map((a) => (
                  <tr
                    key={a.applicationId}
                    className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1.5 rounded-lg border border-border bg-background p-3.5"
                  >
                    <td className="row-span-4 pt-0.5">
                      <BulkApproveCheckbox applicationId={a.applicationId} name={a.appliedName} />
                    </td>
                    <td className="min-w-0">
                      <span className="block truncate font-semibold text-foreground">{a.appliedName}</span>
                      <span className="block truncate text-xs text-muted-foreground" title={a.loginEmail}>
                        {a.loginEmail}
                      </span>
                    </td>
                    <td className="row-span-4 self-center">
                      <ReviewDialog
                        key={`r-${a.applicationId}-${a.revision}`}
                        application={a}
                        cohorts={pending.cohorts}
                        registrationOpenCohort={pending.registrationOpenCohort}
                        labels={REVIEW_LABELS}
                      />
                    </td>
                    <td className="text-sm">
                      <span className="tabular">{a.studentNo}</span>
                      <span className="text-muted-foreground">・{a.departmentClass || '—'}</span>
                    </td>
                    <td>
                      <EvidencePills flags={a.flags} labels={REVIEW_LABELS} />
                    </td>
                    <td className="tabular text-xs text-muted-foreground">
                      {formatTaipeiMinute(new Date(a.updatedAt))} 送出
                      {/* A19：不出現「第 N 版」；學生改過資料再送的，列尾一個灰字「已重送」。 */}
                      {a.revision > 1 ? <span className="ml-1">・已重送</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </BulkApproveProvider>
    </DashboardShell>
  )
}
