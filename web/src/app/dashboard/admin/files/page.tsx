import { notFound } from 'next/navigation'
import { PageTitle } from '@/app/_ui/dashboard-kit'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { AdminTabs } from '@/app/dashboard/admin/_tabs'
import { AFFAIRS_TABS } from '@/app/dashboard/admin/_tabs.consts'
import { FilesTab } from '@/app/dashboard/admin/files/files-tab'
import type { FileKind } from '@/app/dashboard/admin/files/files-view'
import { getFileListQuery } from '@/composition/files'

export const metadata = { title: '檔案｜資管系專題平台' }

/**
 * 檔案管理（票 35；原型 `/dashboard/admin/files`；產品模組 10「系辦在檔案管理看全部檔案、被誰引用、用量」）。
 *
 * 是同一個檔案服務的檢視，不是另一套系統：資料來自既有的 `stored_files`／`file_references`，
 * 下載一律走 `/api/files/<id>` 重新授權。分頁內容（說明、表格、刪除沒人用的檔）在 `files-tab.tsx`（C1-16）。
 */
export default async function AdminFilesPage({ searchParams }: { searchParams: Promise<{ kind?: string | string[] }> }) {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  const actor = await requireRole('/dashboard/admin/files', 'admin')
  const rows = await getFileListQuery().list(actor)
  if (!rows) notFound()

  const wanted = (await searchParams).kind
  const initialKind: FileKind | 'all' = wanted === 'item' || wanted === 'submission' || wanted === 'other' ? wanted : 'all'

  return (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current="/dashboard/admin/files">
      <div className="flex flex-col gap-5">
        <div>
          <PageTitle title="公告與作業" />
          <div className="mt-4">
            <AdminTabs label="公告與作業分頁" current="/dashboard/admin/files" items={AFFAIRS_TABS} />
          </div>
          <p data-testid="tab-intro" className="-mt-2 mb-4 text-sm text-muted-foreground">
            掛在公告、資源、作業底下的檔案，以及每個檔案被哪些項目引用。
          </p>
        </div>
        <FilesTab rows={rows} initialKind={initialKind} />
      </div>
    </DashboardShell>
  )
}
