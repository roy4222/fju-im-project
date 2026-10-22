import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { PageTitle } from '@/app/_ui/dashboard-kit'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { AdminTabs } from '@/app/dashboard/admin/_tabs'
import { AFFAIRS_TABS } from '@/app/dashboard/admin/_tabs.consts'
import { ShowcaseTab } from '@/app/dashboard/admin/showcase/showcase-tab'

export const metadata = { title: '成果展示｜資管系專題平台' }

/**
 * 公告與作業的「成果展示」分頁（C 階段規格② §2.2：路由不變）。殼只管守衛、標題與分頁列；
 * 說明句以下的內容（作品清單＋編輯視窗＋榮譽榜）歸規格①的 `ShowcaseTab`（C1-09）。
 */
export default async function AdminShowcasePage({ searchParams }: { searchParams: Promise<{ cohort?: string | string[]; honor?: string | string[] }> }) {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  await requireRole('/dashboard/admin/showcase', 'admin')
  const params = await searchParams

  return (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current="/dashboard/admin/showcase">
      <PageTitle title="公告與作業" />
      <div className="mt-4">
        <AdminTabs label="公告與作業分頁" current="/dashboard/admin/showcase" items={AFFAIRS_TABS} />
      </div>
      <p data-testid="tab-intro" className="-mt-2 mb-4 text-sm text-muted-foreground">
        每一組的成果展示頁，發布後出現在前台的歷屆專題；歷屆榮譽也在這裡。
      </p>
      <ShowcaseTab cohortId={typeof params.cohort === 'string' ? params.cohort : null} searchParams={params} />
    </DashboardShell>
  )
}
