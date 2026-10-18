import { requireRole } from '@/app/_ui/guard'
import { PageTitle, Panel, PanelEmpty } from '@/app/_ui/dashboard/primitives'
import { DashboardShell } from '@/app/_ui/site-shell'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { AdminTabs } from '@/app/dashboard/admin/_tabs'
import { ACCOUNT_TABS } from '@/app/dashboard/admin/_tabs.consts'

export const metadata = { title: '已停用｜資管系專題平台' }

const BASE = '/dashboard/admin/accounts/disabled'

/**
 * 帳號的「已停用」分頁（C 階段規格② §2.2）：C2-01 只做外殼（守衛、標題、分頁列、說明句），
 * 說明句以下的內容由C2-07接上；說明句是這條路由的 e2e 指紋（`e2e/fingerprints.ts`），改句子要一起改。
 */
export default async function AccountsDisabledPage() {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  await requireRole(BASE, 'admin')

  return (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current={BASE}>
      <PageTitle title="帳號" />
      <div className="mt-4">
        <AdminTabs label="帳號分頁" current={BASE} items={ACCOUNT_TABS} />
      </div>
      <p data-testid="tab-intro" className="-mt-2 mb-4 text-sm text-muted-foreground">
        已停用、不能登入的帳號，可以在這裡恢復。
      </p>
      <Panel title="已停用">
        <PanelEmpty title="這個分頁還在建置中" hint="目前停用與恢復仍在「全部帳號」分頁處理。" />
      </Panel>
    </DashboardShell>
  )
}
