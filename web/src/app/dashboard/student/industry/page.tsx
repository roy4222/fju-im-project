import Link from 'next/link'
import { IconArrowRight, IconBuilding } from '@tabler/icons-react'
import { requireRole } from '@/app/_ui/guard'
import { PageTitle, Pill } from '@/app/_ui/dashboard-primitives'
import { EmptyState } from '@/app/_ui/primitives'
import { DashboardShell } from '@/app/_ui/site-shell'
import { STUDENT_NAV } from '@/app/dashboard/_nav'
import { getOpportunityQuery } from '@/composition/groups'

export const metadata = { title: '產學合作｜資管系專題平台' }

const PATH = '/dashboard/student/industry'

/**
 * 學生「產學合作」（票 38；原型 `/dashboard/student/industry`）：已發布的合作案卡片，點進前台詳情。
 *
 * 讀取跟前台 `/industry` 同一個查詢（`OpportunityQuery.list`）：只有已發布的案、只有公開欄位
 * （公司、部門、內容摘要、負責老師、連結組數）；草稿、已下架、聯絡資料都不在這裡（產品 6.1：聯絡資料只有案主與系辦）。
 * 產學組的組長在「我的組別」連結合作案。
 */
export default async function StudentIndustryPage() {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  const actor = await requireRole(PATH, 'student')
  const cards = await getOpportunityQuery().list(actor)

  return (
    <DashboardShell roleLabel="學生" items={STUDENT_NAV} current={PATH}>
      <div className="flex flex-col gap-5">
        <PageTitle
          title="產學合作"
          description="老師建立的合作案；產學組的組長可以在「我的組別」把組別連結到合作案。"
          actions={
            <Link
              href="/industry"
              className="press inline-flex h-10 items-center gap-1.5 rounded-lg border border-border bg-background px-4 text-sm font-medium transition-colors hover:bg-muted [&_svg]:size-4"
            >
              前台列表 <IconArrowRight />
            </Link>
          }
        />
        {cards.length === 0 ? (
          <EmptyState title="目前沒有發布中的合作案" description="老師建立並發布合作案後會出現在這裡。" />
        ) : (
          <ul className="grid gap-4 md:grid-cols-2" aria-label="合作案">
            {cards.map((card) => (
              <li key={card.id}>
                <Link
                  href={`/industry/${card.id}`}
                  data-testid="student-opportunity-card"
                  className="card-lift flex items-center gap-4 rounded-xl border border-border bg-card p-5"
                >
                  <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg bg-brand-subtle text-brand-on-subtle">
                    <IconBuilding className="size-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-bold">{card.companyName}</span>
                    <span className="block truncate text-sm text-muted-foreground">
                      {card.department ? `${card.department}・` : ''}
                      {card.summary}
                    </span>
                  </span>
                  {card.linkedGroupCount > 0 ? <Pill tone="info">已有 {card.linkedGroupCount} 組</Pill> : <Pill tone="brand">尚無組別</Pill>}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </DashboardShell>
  )
}
