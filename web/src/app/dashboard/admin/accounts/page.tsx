import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { Card, DataTable, EmptyState, PageHeader } from '@/app/_ui/primitives'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { getRosterCommand } from '@/composition/accounts'
import { formatTaipeiMinute } from '@/shared/time'
import { ImportRosterDialog } from './import-roster-dialog'

export const metadata = { title: '帳號管理｜資管系專題平台' }

export default async function AdminAccountsPage() {
  // 授權檢查在**頁面自己**：放在 layout 擋不住，App Router 會把 layout 與 page 並行渲染，
  // layout 丟掉 children 或 redirect 都來不及——那一頁已經被做出來、跟著 payload 送走了。
  const actor = await requireRole('/dashboard/admin/accounts', 'admin')

  // 用例自己再判一次授權（頁面通過不代表用例會放行）。
  const listed = await getRosterCommand().listVersions(actor)
  const versions = listed.ok ? listed.receipt.versions : []

  return (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current="/dashboard/admin/accounts">
      <PageHeader title="帳號" description="名單匯入、註冊審核、停用與臨時密碼都在這一區。" />

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
        empty="還沒有帳號資料。註冊審核（S01-11）接上之後會出現在這裡。"
      />
      <div className="mt-6">
        <EmptyState
          pending
          title="審核與管理動作還沒做"
          description="核准／退回、停用／還原、發臨時密碼、匯出名單分別由 S01-11、S01-12 與 S01-16 掛上來。"
        />
      </div>
    </DashboardShell>
  )
}
