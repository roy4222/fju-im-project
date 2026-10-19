import { requireRole } from '@/app/_ui/guard'
import { BackLink, PageTitle } from '@/app/_ui/dashboard-kit'
import { EmptyState } from '@/app/_ui/primitives'
import { DashboardShell } from '@/app/_ui/site-shell'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { LazyItemFormPage } from '@/app/dashboard/admin/affairs/_form/item-form-dialog'
import { formPlacementOf, HONOR } from '@/app/dashboard/admin/affairs/item-form-model'
import { editorVocabulary } from '@/app/dashboard/admin/affairs/vocabulary'
import { cohortLabel, getCohortStatusQuery } from '@/composition/cohorts'
import { ITEM_TEMPLATES } from '@/composition/items'

export const metadata = { title: '新增公告或作業｜資管系專題平台' }

/**
 * 新增公告或作業（全頁版共用表單 `ItemForm layout='page'`；C 階段規格① §2）。這一頁**不在 GET 時建資料**：
 * 畫空白表單，第一次按「儲存（先不發布）」或「發布」才建立項目；儲存後網址換成 `/dashboard/admin/editor/<id>`，一直是同一筆。
 * 沒有分頁脈絡，所以表單上方可以選「顯示在哪一區」（`?placement=` 預選；`?consent=form|upload` 開同意書作業）。
 */
export default async function NewItemPage({
  searchParams,
}: {
  searchParams: Promise<{ cohort?: string | string[]; placement?: string | string[]; consent?: string | string[] }>
}) {
  await requireRole('/dashboard/admin/editor/new', 'admin')

  const params = await searchParams
  // 榮譽是跨屆的公開紀錄（第三波 W1）：`?placement=honor` 時封存屆別也能選（補登歷屆得獎）；其他位置只給未封存的屆別。
  const honor = params.placement === HONOR
  const cohorts = (await getCohortStatusQuery().list()).filter((c) => honor || c.status !== 'archived')
  const wanted = params.cohort
  const cohort = cohorts.find((c) => c.id === wanted) ?? cohorts.find((c) => c.isDefaultWorking) ?? cohorts[0] ?? null

  const shell = (children: React.ReactNode) => (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current="/dashboard/admin/affairs">
      {children}
    </DashboardShell>
  )

  if (!cohort) {
    return shell(
      <div className="flex flex-col gap-5">
        <PageTitle title="新增公告或作業" description="寫內容、設繳交欄位與誰看得到，再發布；儲存之前沒有人看得到。" />
        <EmptyState
          title="還沒有屆別"
          description="公告與作業要綁在某一屆；先到屆別頁新增一屆。"
          action={{ href: '/dashboard/admin/cohorts', label: '前往屆別' }}
        />
      </div>,
    )
  }

  const placement = formPlacementOf(typeof params.placement === 'string' ? params.placement : 'news')
  const consent = params.consent === 'form' || params.consent === 'upload' ? params.consent : undefined

  return shell(
    <div className="flex flex-col gap-4">
      <EditorHeader
        cohortId={cohort.id}
        heading="新增公告或作業"
        meta={`綁定屆別：${cohortLabel(cohort)}（建立後不能換）・儲存之前沒有人看得到`}
      />
      <LazyItemFormPage
        placement={consent ? 'submission' : placement}
        consentMode={consent}
        cohortId={cohort.id}
        options={await editorVocabulary(cohort.id)}
        templates={ITEM_TEMPLATES}
        placementSelectable={!consent}
      />
    </div>,
  )
}

/** 全頁的頁首（伺服器畫；表單按需載入，首屏先有返回連結、標題與屆別說明）。回到這一筆所屬的屆別，不落回預設工作屆（設計方案 §13-2）。 */
function EditorHeader({ cohortId, heading, meta }: { cohortId: string; heading: string; meta: string }) {
  return (
    <div className="flex flex-col gap-2">
      <BackLink href={`/dashboard/admin/affairs?cohort=${cohortId}&placement=all`} label="公告與作業" />
      <h1 className="text-xl font-extrabold tracking-tight">{heading}</h1>
      <p className="text-xs text-muted-foreground tabular-nums">{meta}</p>
    </div>
  )
}
