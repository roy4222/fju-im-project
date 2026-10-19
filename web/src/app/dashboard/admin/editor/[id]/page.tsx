import { notFound } from 'next/navigation'
import { currentActor, requireRole } from '@/app/_ui/guard'
import { BackLink } from '@/app/_ui/dashboard-kit'
import { DashboardShell } from '@/app/_ui/site-shell'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { LazyItemFormPage } from '@/app/dashboard/admin/affairs/_form/item-form-dialog'
import { toInitial } from '@/app/dashboard/admin/affairs/item-form-model'
import { editorVocabulary } from '@/app/dashboard/admin/affairs/vocabulary'
import { cohortLabel, getCohortStatusQuery } from '@/composition/cohorts'
import { getGradingStageSettingQuery } from '@/composition/grading'
import { getItemQuery, ITEM_STATUS_LABEL, ITEM_TEMPLATES } from '@/composition/items'
import { getRosterQuery } from '@/composition/submissions'
import { formatTaipeiMinute } from '@/shared/time'

export const metadata = { title: '編輯公告或作業｜資管系專題平台' }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * 編輯公告或作業（全頁版共用表單 `ItemForm layout='page'`；C 階段規格① §2）。`ItemQuery.get` 的結果經 `toInitial` 變成表單初值；
 * 發布紀錄搬進表單「進階設定」最下方（操作者有頭像）。
 * 有人交過時另算交過幾組（「已有 N 組交過，欄位結構不能改」，AC-5）；作業另查有幾個評分項目對應它（進階設定唯讀顯示）。
 */
export default async function EditItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await requireRole(`/dashboard/admin/editor/${UUID.test(id) ? id : 'new'}`, 'admin')
  if (!UUID.test(id)) notFound()

  const item = await getItemQuery().get(id)
  if (!item) notFound()
  const actor = await currentActor()
  const collects = item.placement === 'submission' || item.placement === 'requirement'
  const [cohort, vocabulary, roster, settings] = await Promise.all([
    getCohortStatusQuery().get(item.cohortId),
    editorVocabulary(item.cohortId),
    item.hasResponses ? getRosterQuery().roster(actor, id) : Promise.resolve(null),
    collects ? getGradingStageSettingQuery().stageSettings(actor, item.cohortId) : Promise.resolve(null),
  ])
  const responseCount = roster ? roster.entries.filter((e) => e.latestVersionNo !== null).length : null
  const linkedStages = settings && settings.ok ? settings.receipt.filter((s) => s.itemId === id).length : null

  const versions =
    item.contentVersionNo !== null
      ? `內容第 ${item.contentVersionNo} 版・表單第 ${item.schemaVersionNo} 版${item.receiverUnit === 'none' ? '' : `・需要繳交 ${item.rosterCount} ${item.receiverUnit === 'group' ? '組' : '位'}`}`
      : '還沒發布過'
  const opened = item.actualOpenedAt ? `・實際開放 ${formatTaipeiMinute(item.actualOpenedAt)}` : ''
  const initial = toInitial(item, responseCount)

  return (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current="/dashboard/admin/affairs">
      <div className="flex flex-col gap-4">
        {/* 頁首由伺服器畫（表單按需載入）；回到這一筆所屬的屆別，不落回預設工作屆（設計方案 §13-2）。 */}
        <div className="flex flex-col gap-2">
          <BackLink href={`/dashboard/admin/affairs?cohort=${item.cohortId}&placement=all`} label="公告與作業" />
          <h1 className="text-xl font-extrabold tracking-tight">編輯公告或作業</h1>
          <p className="text-xs text-muted-foreground tabular-nums">{`${cohort ? cohortLabel(cohort) : ''}・${ITEM_STATUS_LABEL[item.status]}・${versions}${opened}`}</p>
        </div>
        <LazyItemFormPage
          placement={initial.placement}
          cohortId={item.cohortId}
          itemId={item.id}
          initial={initial}
          options={vocabulary}
          templates={ITEM_TEMPLATES}
          linkedStages={linkedStages}
        />
      </div>
    </DashboardShell>
  )
}
