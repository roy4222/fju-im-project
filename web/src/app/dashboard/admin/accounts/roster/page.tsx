import { IconFileSpreadsheet } from '@tabler/icons-react'
import { requireRole } from '@/app/_ui/guard'
import { PageTitle, Panel, PanelEmpty } from '@/app/_ui/dashboard/primitives'
import { DashboardShell } from '@/app/_ui/site-shell'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { AdminTabs } from '@/app/dashboard/admin/_tabs'
import { ACCOUNT_TABS } from '@/app/dashboard/admin/_tabs.consts'
import { getRosterCommand } from '@/composition/accounts'
import { formatTaipeiMinute } from '@/shared/time'
import { ImportRosterDialog } from '../import-roster-dialog'

export const metadata = { title: '名單匯入｜資管系專題平台' }

const BASE = '/dashboard/admin/accounts/roster'

/**
 * 帳號的「名單匯入」分頁（C 階段規格② §3.6）：原本收在帳號頁「名單與停用」裡的匯入與歷次匯入搬到這裡（C2-07）。
 * 說明句是這條路由的 e2e 指紋（`e2e/fingerprints.ts`），改句子要一起改。
 */
export default async function AccountsRosterPage() {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  const actor = await requireRole(BASE, 'admin')

  // 用例自己再判一次授權（頁面通過不代表用例會放行）。
  const listed = await getRosterCommand().listVersions(actor)
  const versions = listed.ok ? listed.receipt.versions : []

  return (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current={BASE}>
      <PageTitle title="帳號" actions={<ImportRosterDialog />} />
      <div className="mt-4">
        <AdminTabs label="帳號分頁" current={BASE} items={ACCOUNT_TABS} />
      </div>
      <p data-testid="tab-intro" className="-mt-2 mb-4 text-sm text-muted-foreground">
        匯入系上提供的學生名單，名單上的人註冊時可以自動開通。
      </p>
      <div className="flex flex-col gap-5">
        <p className="text-sm text-muted-foreground">
          名單用來自動開通：Google 登入、或 Email 註冊且已驗證的學生，Email、學號、姓名跟名單同一列就不用等審核。上傳本屆名單 CSV，每次匯入都另存一份，舊的不會被蓋掉。
        </p>

        <Panel title="歷次匯入" icon={<IconFileSpreadsheet />} aria-label="歷次匯入">
          {!listed.ok ? (
            <p role="alert" className="mx-5 mb-5 text-sm text-destructive">
              歷次匯入載入失敗，請重新整理頁面。
            </p>
          ) : versions.length === 0 ? (
            <PanelEmpty title="還沒有匯入過名單。" />
          ) : (
            <ul className="grid gap-3 px-5 pb-5 md:grid-cols-2 2xl:grid-cols-3">
              {versions.map((v) => (
                <li key={v.id}>
                  <article
                    aria-label={`${v.cohortName}（${v.cohortCode}）名單`}
                    className="flex h-full flex-col gap-1 rounded-lg border border-border bg-background p-3.5 text-sm"
                  >
                    <span className="font-semibold text-foreground">
                      {v.cohortName}（{v.cohortCode}）
                    </span>
                    <span className="tabular text-xs text-muted-foreground">
                      {formatTaipeiMinute(new Date(v.importedAt))}・{v.importedBy}
                    </span>
                    <span className="tabular">
                      有效 <span className="font-semibold">{v.counts.valid}</span> 筆
                      <span className="text-muted-foreground">
                        ・重複 {v.counts.duplicate}・缺欄 {v.counts.missing}・衝突 {v.counts.conflict}
                      </span>
                    </span>
                    {v.fileId ? (
                      // 下載每次都經 /api/files/[id] 重新授權；別人拿到這個網址也打不開。
                      <a
                        href={`/api/files/${v.fileId}`}
                        title={v.fileName ?? undefined}
                        aria-label={`下載原檔${v.fileName ? ` ${v.fileName}` : ''}`}
                        className="mt-auto truncate pt-1 font-semibold text-primary underline-offset-4 hover:underline"
                        download
                      >
                        下載原檔{v.fileName ? `・${v.fileName}` : ''}
                      </a>
                    ) : null}
                  </article>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </DashboardShell>
  )
}
