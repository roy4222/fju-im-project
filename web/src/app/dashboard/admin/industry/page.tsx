import { requireRole } from '@/app/_ui/guard'
import { PageHeader, Tile } from '@/app/_ui/primitives'
import { DashboardShell } from '@/app/_ui/site-shell'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { ManageOpportunityList } from '@/app/dashboard/_industry/manage-list'
import {
  CHANGE_REASON_MAX_LENGTH,
  getOpportunityQuery,
  OPPORTUNITY_FIELD_LABEL,
  OPPORTUNITY_LIMITS,
  OPPORTUNITY_STATUS_LABEL,
} from '@/composition/groups'

export const metadata = { title: '合作案｜資管系專題平台' }

/**
 * 系辦「合作案」（票 20；原型 `/dashboard/admin/industry`）：全部合作案與組別連結。
 *
 * 系辦可以編輯、發布、下架、重新發布任何一案，也可以解除連結（理由必填）。建立由老師做（負責老師＝登入帳號）。
 */
export default async function AdminIndustryPage() {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  const actor = await requireRole('/dashboard/admin/industry', 'admin')
  const items = await getOpportunityQuery().manageList(actor)
  const published = items.filter((o) => o.status === 'published')
  const open = published.filter((o) => o.links.length === 0).length
  const linked = items.reduce((sum, o) => sum + o.links.length, 0)

  return (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current="/dashboard/admin/industry">
      <PageHeader title="合作案" description="全部合作案與組別連結；聯絡資訊只有負責老師與系辦看得到。" />
      <section aria-label="合作案摘要" className="mb-6 grid gap-4 sm:grid-cols-3">
        <Tile label="全部合作案" value={`${items.length} 件`} hint={`${published.length} 件發布中`} />
        <Tile label="發布中、尚無組別" value={`${open} 件`} />
        <Tile label="已連結組別" value={`${linked} 組`} />
      </section>
      <ManageOpportunityList
        items={items}
        statusLabel={OPPORTUNITY_STATUS_LABEL}
        labels={{ fields: OPPORTUNITY_FIELD_LABEL, limits: OPPORTUNITY_LIMITS }}
        showOwner
        reasonMaxLength={CHANGE_REASON_MAX_LENGTH}
        empty={{ title: '還沒有合作案', description: '老師在「我的合作案」建立後會出現在這裡。' }}
      />
      <p className="mt-3 text-xs text-muted-foreground">
        連結代表組別選用這個題目，不代表企業或老師已正式承諾合作。
      </p>
    </DashboardShell>
  )
}
