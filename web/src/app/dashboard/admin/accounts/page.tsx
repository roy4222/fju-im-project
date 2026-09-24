import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { Card, DataTable, EmptyState, PageHeader } from '@/app/_ui/primitives'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import {
  EVIDENCE_LABEL,
  EVIDENCE_NEEDS_ATTENTION,
  getRegistrationCommand,
  getRosterCommand,
  VERIFICATION_LABEL,
  VERIFICATION_METHODS,
  VERIFICATION_NOTE_HINT,
  VERIFICATION_NOTE_REQUIRED,
} from '@/composition/accounts'
import { formatTaipeiMinute } from '@/shared/time'
import { ImportRosterDialog } from './import-roster-dialog'
import { EvidencePills, ReviewDialog, type ReviewLabels } from './review-dialog'

const REVIEW_LABELS: ReviewLabels = {
  evidence: EVIDENCE_LABEL,
  attention: EVIDENCE_NEEDS_ATTENTION,
  methods: VERIFICATION_METHODS,
  methodLabel: VERIFICATION_LABEL,
  noteRequired: VERIFICATION_NOTE_REQUIRED,
  noteHint: VERIFICATION_NOTE_HINT,
}

export const metadata = { title: '帳號管理｜資管系專題平台' }

export default async function AdminAccountsPage() {
  // 授權檢查在**頁面自己**：放在 layout 擋不住，App Router 會把 layout 與 page 並行渲染，
  // layout 丟掉 children 或 redirect 都來不及——那一頁已經被做出來、跟著 payload 送走了。
  const actor = await requireRole('/dashboard/admin/accounts', 'admin')

  // 用例自己再判一次授權（頁面通過不代表用例會放行）。
  const listed = await getRosterCommand().listVersions(actor)
  const versions = listed.ok ? listed.receipt.versions : []
  const pendingResult = await getRegistrationCommand().listPending(actor)
  const pending = pendingResult.ok ? pendingResult.receipt : null

  return (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current="/dashboard/admin/accounts">
      <PageHeader title="帳號" description="名單匯入、註冊審核、停用與臨時密碼都在這一區。" />

      <Card
        title={`待審核${pending ? `（${pending.applications.length}）` : ''}`}
        description="名單比對只協助判斷，不會自動核准；核准前請以校方既有方式核對本人。學生改過資料時，要重新打開核對才能核准。"
        className="mb-6"
      >
        {pending && !pending.registrationOpenCohort ? (
          <p className="mb-3 rounded-md bg-primary-subtle px-3 py-2 text-sm text-primary-on-subtle" role="note">
            目前沒有設定開放註冊屆別：沒命中名單的人核准時要手動選屆別。可以到「屆別」頁設定。
          </p>
        ) : null}
        <DataTable
          columns={['姓名', '學號', '系級', '比對結果', '最後更新', '操作']}
          rows={(pending?.applications ?? []).map((a) => [
            <span key="n" className="font-medium text-ink">
              {a.appliedName}
            </span>,
            <span key="s" className="tabular-nums">
              {a.studentNo}
            </span>,
            a.departmentClass || '—',
            <EvidencePills key="f" flags={a.flags} labels={REVIEW_LABELS} />,
            <span key="t" className="whitespace-nowrap tabular-nums text-muted-foreground">
              {formatTaipeiMinute(new Date(a.updatedAt))}
              {a.revision > 1 ? <span className="ml-1 text-xs">（第 {a.revision} 版）</span> : null}
            </span>,
            <ReviewDialog
              key={`r-${a.applicationId}-${a.revision}`}
              application={a}
              cohorts={pending!.cohorts}
              registrationOpenCohort={pending!.registrationOpenCohort}
              labels={REVIEW_LABELS}
            />,
          ])}
          empty="目前沒有待審核的註冊。"
        />
      </Card>

      <Card
        title="名單"
        description="每次匯入都是一個新版本；名單只協助審核比對，不會自動核准任何人。"
        className="mb-6"
      >
        <div className="mb-4">
          <ImportRosterDialog />
        </div>
        <DataTable
          columns={['屆別', '匯入者', '匯入時間', '有效', '重複／缺欄／衝突', '原檔']}
          rows={versions.map((v) => [
            `${v.cohortName}（${v.cohortCode}）`,
            v.importedBy,
            <span key="t" className="tabular-nums">{formatTaipeiMinute(new Date(v.importedAt))}</span>,
            <span key="n" className="tabular-nums">{v.counts.valid}</span>,
            <span key="s" className="whitespace-nowrap tabular-nums">
              {v.counts.duplicate}／{v.counts.missing}／{v.counts.conflict}
            </span>,
            v.fileId ? (
              // 下載每次都經 /api/files/[id] 重新授權；別人拿到這個網址也打不開。
              <a
                key="d"
                href={`/api/files/${v.fileId}`}
                title={v.fileName ?? undefined}
                aria-label={`下載原檔${v.fileName ? ` ${v.fileName}` : ''}`}
                className="whitespace-nowrap text-primary-on-subtle underline"
                download
              >
                下載
              </a>
            ) : (
              '—'
            ),
          ])}
          empty="還沒有匯入過名單。按「匯入名單 CSV」上傳本屆名單。"
        />
      </Card>

      <DataTable
        columns={['姓名', '學號', '系級', '角色', '狀態']}
        rows={[]}
        empty="帳號列表由票 9 掛上來。"
      />
      <div className="mt-6">
        <EmptyState
          pending
          title="帳號管理動作還沒做"
          description="停用／還原、發臨時密碼、匯出名單分別由票 9、票 8 掛上來。"
        />
      </div>
    </DashboardShell>
  )
}
