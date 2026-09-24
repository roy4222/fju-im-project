import { requireRole } from '@/app/_ui/guard'
import { StageBanner } from '@/app/dashboard/_stage'
import { DashboardShell } from '@/app/_ui/site-shell'
import { EmptyState, PageHeader, Tile } from '@/app/_ui/primitives'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { getAccountCommand } from '@/composition/accounts'
import { getCohortStatusQuery } from '@/composition/cohorts'

export const metadata = { title: '系辦首頁｜資管系專題平台' }

export default async function AdminHomePage() {
  // 授權檢查在**頁面自己**：放在 layout 擋不住，App Router 會把 layout 與 page 並行渲染，
  // layout 丟掉 children 或 redirect 都來不及——那一頁已經被做出來、跟著 payload 送走了。
  const actor = await requireRole('/dashboard/admin', 'admin')
  const working = await getCohortStatusQuery().defaultWorking()
  const summaryResult = await getAccountCommand().summary(actor)
  const summary = summaryResult.ok ? summaryResult.receipt : null

  return (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current="/dashboard/admin">
      <PageHeader title="系辦首頁" description="待審的註冊、已開通的學生與目前在忙的屆別。" />
      <StageBanner actor={actor} perspective="staff" />
      <div className="grid gap-4 sm:grid-cols-3">
        <Tile
          label="待審核申請"
          value={summary?.pendingApplications ?? '—'}
          hint={summary && summary.pendingApplications > 0 ? '到「帳號」頁審核' : '目前沒有要審的申請'}
          href="/dashboard/admin/accounts"
        />
        <Tile
          label="已核准學生"
          value={summary?.activeStudents ?? '—'}
          hint="帳號正常、有學生身分的人"
          href="/dashboard/admin/accounts?status=active&role=student"
        />
        <Tile
          label="目前工作屆別"
          value={working?.code ?? '未設定'}
          hint={working ? working.name : '到「屆別」頁指定預設工作屆別'}
          href="/dashboard/admin/cohorts"
        />
      </div>
      <div className="mt-6">
        <EmptyState
          pending
          title="到期提醒與通知匣還沒做"
          description="之後這裡會列出今天到期的事與新通知。現在請從側欄的「帳號」「屆別」「時間軸」進去處理。"
        />
      </div>
    </DashboardShell>
  )
}
