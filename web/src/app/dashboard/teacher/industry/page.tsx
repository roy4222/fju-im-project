import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import { requireRole } from '@/app/_ui/guard'
import { PageHeader } from '@/app/_ui/primitives'
import { DashboardShell } from '@/app/_ui/site-shell'
import { TEACHER_NAV } from '@/app/dashboard/_nav'
import { ManageOpportunityList } from '@/app/dashboard/_industry/manage-list'
import { OpportunityFormDialog } from '@/app/dashboard/_industry/opportunity-forms'
import {
  CHANGE_REASON_MAX_LENGTH,
  getOpportunityQuery,
  OPPORTUNITY_FIELD_LABEL,
  OPPORTUNITY_LIMITS,
  OPPORTUNITY_STATUS_LABEL,
} from '@/composition/groups'

export const metadata = { title: '我的合作案｜資管系專題平台' }

/**
 * 老師「我的合作案」（票 20；原型 `/dashboard/teacher/industry`）。
 *
 * 建立、編輯、發布、下架、重新發布自己的合作案；聯絡資料只有自己與系辦看得到。
 * 下方每一案列出連結的組別，可以解除（理由必填，通知該組與自己）。其他老師的合作案在前台「產學合作」看。
 */
export default async function TeacherIndustryPage() {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  const actor = await requireRole('/dashboard/teacher/industry', 'teacher')
  const items = await getOpportunityQuery().manageList(actor)
  const labels = { fields: OPPORTUNITY_FIELD_LABEL, limits: OPPORTUNITY_LIMITS }
  const published = items.filter((o) => o.status === 'published').length
  const linked = items.reduce((sum, o) => sum + o.links.length, 0)

  return (
    <DashboardShell roleLabel="老師" items={TEACHER_NAV} current="/dashboard/teacher/industry">
      <PageHeader title="我的合作案" description="建立、編輯、下架自己的合作案；地址、聯絡人、電話、Email 只有你與系辦看得到。" />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground tabular-nums" data-testid="industry-summary">
          {items.length} 件・發布中 {published} 件・連結 {linked} 組・
          <Link href="/industry" className="font-semibold text-primary hover:underline">
            看全部已發布的合作案
          </Link>
        </p>
        <OpportunityFormDialog labels={labels} requestId={randomUUID()} />
      </div>
      <ManageOpportunityList
        items={items}
        statusLabel={OPPORTUNITY_STATUS_LABEL}
        labels={labels}
        showOwner={false}
        reasonMaxLength={CHANGE_REASON_MAX_LENGTH}
        empty={{ title: '尚無合作案', description: '按「新增合作案」填公司、部門與內容；可以先存草稿，確認後再發布給學生看。' }}
      />
    </DashboardShell>
  )
}
