import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { DataTable, EmptyState, PageHeader } from '@/app/_ui/primitives'
import { ADMIN_NAV } from '@/app/dashboard/_nav'

export const metadata = { title: '帳號管理｜資管系專題平台' }

/** 表格是**空的殼**：欄位先定下來，資料由 S01-11／S01-12 接上。不放假資料。 */
export default async function AdminAccountsPage() {
  // 授權檢查在**頁面自己**：放在 layout 擋不住，App Router 會把 layout 與 page 並行渲染，
  // layout 丟掉 children 或 redirect 都來不及——那一頁已經被做出來、跟著 payload 送走了。
  await requireRole('/dashboard/admin/accounts', 'admin')

  return (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current="/dashboard/admin/accounts">
      <PageHeader title="帳號" description="名單匯入、註冊審核、停用與臨時密碼都在這一區。" />
      <DataTable
        columns={['姓名', '學號', '系級', '角色', '狀態']}
        rows={[]}
        empty="還沒有帳號資料。名單匯入（S01-10）與註冊審核（S01-11）接上之後會出現在這裡。"
      />
      <div className="mt-6">
        <EmptyState
          pending
          title="審核與管理動作還沒做"
          description="匯入名單、核准／退回、停用／還原、發臨時密碼、匯出名單分別由 S01-10、S01-11、S01-12 與 S01-16 掛上來。"
        />
      </div>
    </DashboardShell>
  )
}
