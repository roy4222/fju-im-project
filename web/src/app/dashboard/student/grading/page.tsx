import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { Card, PageHeader } from '@/app/_ui/primitives'
import { STUDENT_NAV } from '@/app/dashboard/_nav'

export const metadata = { title: '成績｜資管系專題平台' }

/**
 * 學生「成績」（票 23；原型 `/dashboard/student/grading`）：明確告訴學生看不到分數（產品模組 06 §4「7.6」）。
 *
 * 這一頁**刻意不查任何評分資料**：不只畫面不顯示，連伺服器都不讀，RSC payload 裡也就不可能有分數。
 * 學生零可見由 e2e `student-zero-visibility.spec.ts` 掃描全部學生可達頁面與 API 證明。
 */
export default async function StudentGradingPage() {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  await requireRole('/dashboard/student/grading', 'student')

  return (
    <DashboardShell roleLabel="學生" items={STUDENT_NAV} current="/dashboard/student/grading">
      <PageHeader title="成績" description="專題評分的說明。" />
      <Card title="評分由老師與系辦處理，學生不會看到分數">
        <p className="text-sm text-muted-foreground">
          指導老師與評分老師的分數、評語、平均與排名都只在老師與系辦的後台；這個網站不會在任何頁面、通知或匯出裡顯示給學生。
          成績有問題請直接詢問系辦。
        </p>
      </Card>
    </DashboardShell>
  )
}
