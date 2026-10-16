import { requireRole } from '@/app/_ui/guard'
import { PageTitle } from '@/app/_ui/dashboard-kit'
import { EmptyState } from '@/app/_ui/primitives'
import { DashboardShell } from '@/app/_ui/site-shell'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { HONOR, HONOR_AUDIENCE, type EditorState } from '@/app/dashboard/admin/affairs/item-form-model'
import { editorVocabulary } from '@/app/dashboard/admin/affairs/vocabulary'
import { ItemEditor } from '@/app/dashboard/admin/editor/item-editor'
import { cohortLabel, getCohortStatusQuery } from '@/composition/cohorts'
import { ITEM_TEMPLATES } from '@/composition/items'

export const metadata = { title: '新增專題事務｜資管系專題平台' }

/**
 * 完整編輯器（新建）。這一頁**不在 GET 時建資料**：畫空白表單，第一次按「存草稿」或「發布」才建立項目，
 * 之後網址換成 `/dashboard/admin/editor/<id>`，一直是同一筆。
 */
export default async function NewItemPage({
  searchParams,
}: {
  searchParams: Promise<{ cohort?: string | string[]; placement?: string | string[] }>
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
        <PageTitle title="新增專題事務" description="寫內容、設繳交欄位與誰看得到，檢查過再發布；存草稿之前沒有人看得到。" />
        <EmptyState
        title="還沒有屆別"
        description="專題事務要綁在某一屆；先到屆別頁新增一屆。"
        action={{ href: '/dashboard/admin/cohorts', label: '前往屆別' }}
        />
      </div>,
    )
  }

  const initial: EditorState = {
    cohortId: cohort.id,
    placement: honor ? HONOR : 'news',
    title: '',
    summary: '',
    body: '',
    category: '',
    cover: null,
    attachments: [],
    audienceKind: honor ? HONOR_AUDIENCE : 'cohort_students',
    groupIds: [],
    receiverUnit: 'none',
    stageId: '',
    opensAt: '',
    dueAt: '',
    registrationDeadline: '',
    eventDate: '',
    awardedOn: '',
    fields: [],
  }

  return shell(
    <ItemEditor
      initial={initial}
      itemId={null}
      revision={0}
      status="draft"
      hasResponses={false}
      vocabulary={await editorVocabulary(cohort.id)}
      templates={ITEM_TEMPLATES}
      heading="新增專題事務"
      meta={`綁定屆別：${cohortLabel(cohort)}（建立後不能換）・存草稿之前沒有人看得到`}
    />,
  )
}
