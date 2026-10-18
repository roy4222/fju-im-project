import { requireRole } from '@/app/_ui/guard'
import { PageTitle, Panel, PanelEmpty } from '@/app/_ui/dashboard/primitives'
import { DashboardShell } from '@/app/_ui/site-shell'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { AdminTabs } from '@/app/dashboard/admin/_tabs'
import { GROUP_TABS } from '@/app/dashboard/admin/_tabs.consts'

export const metadata = { title: '未分組學生｜資管系專題平台' }

const BASE = '/dashboard/admin/groups/unassigned'

/**
 * 分組的「未分組學生」分頁（C 階段規格② §2.2）：C2-01 只做外殼（守衛、標題、分頁列、說明句），
 * 說明句以下的內容由規格③接上；說明句是這條路由的 e2e 指紋（`e2e/fingerprints.ts`），改句子要一起改。
 */
export default async function GroupsUnassignedPage() {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  await requireRole(BASE, 'admin')

  return (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current={BASE}>
      <PageTitle title="分組" />
      <div className="mt-4">
        <AdminTabs label="分組分頁" current={BASE} items={GROUP_TABS} />
      </div>
      <p data-testid="tab-intro" className="-mt-2 mb-4 text-sm text-muted-foreground">
        這一屆還沒有加入任何組別的學生。
      </p>
      <p className="-mt-2 mb-4 text-sm text-muted-foreground">
        名單接上後，每一列會連到該學生在「帳號」的那一列，可以看他的屆別、狀態與聯絡信箱。
      </p>
      <Panel title="未分組學生">
        <PanelEmpty title="這個分頁還在建置中" hint="未分組學生的名單之後會列在這裡；目前請在「全部組別」分頁的「未分組學生」區塊查看。" />
      </Panel>
    </DashboardShell>
  )
}
