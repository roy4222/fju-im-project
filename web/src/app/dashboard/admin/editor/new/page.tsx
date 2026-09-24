import { requireRole } from '@/app/_ui/guard'
import { EmptyState, PageHeader } from '@/app/_ui/primitives'
import { DashboardShell } from '@/app/_ui/site-shell'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import type { EditorState } from '@/app/dashboard/admin/affairs/item-form-model'
import { editorVocabulary } from '@/app/dashboard/admin/affairs/vocabulary'
import { ItemEditor } from '@/app/dashboard/admin/editor/item-editor'
import { getCohortStatusQuery } from '@/composition/cohorts'

export const metadata = { title: '新增專題事務｜資管系專題平台' }

/**
 * 完整編輯器（新建）。這一頁**不在 GET 時建資料**：畫空白表單，第一次按「存草稿」或「發布」才建立項目，
 * 之後網址換成 `/dashboard/admin/editor/<id>`，一直是同一筆。
 */
export default async function NewItemPage({ searchParams }: { searchParams: Promise<{ cohort?: string | string[] }> }) {
  await requireRole('/dashboard/admin/editor/new', 'admin')

  const cohorts = (await getCohortStatusQuery().list()).filter((c) => c.status !== 'archived')
  const wanted = (await searchParams).cohort
  const cohort = cohorts.find((c) => c.id === wanted) ?? cohorts.find((c) => c.isDefaultWorking) ?? cohorts[0] ?? null

  const shell = (children: React.ReactNode) => (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current="/dashboard/admin/affairs">
      <PageHeader title="新增專題事務" description="寫內容、設收件欄位與發布對象，檢查過再發布；存草稿之前沒有人看得到。" />
      {children}
    </DashboardShell>
  )

  if (!cohort) {
    return shell(
      <EmptyState
        title="還沒有屆別"
        description="專題事務要綁在某一屆；先到屆別頁新增一屆。"
        action={{ href: '/dashboard/admin/cohorts', label: '前往屆別' }}
      />,
    )
  }

  const initial: EditorState = {
    cohortId: cohort.id,
    placement: 'news',
    title: '',
    summary: '',
    body: '',
    category: '',
    cover: null,
    attachments: [],
    audienceKind: 'cohort_students',
    groupIds: [],
    receiverUnit: 'none',
    stageId: '',
    opensAt: '',
    dueAt: '',
    fields: [],
  }

  return shell(
    <>
      <p className="mb-3 text-sm text-muted-foreground">綁定屆別：{cohort.code}（建立後不能換）</p>
      <ItemEditor
        initial={initial}
        itemId={null}
        revision={0}
        status="draft"
        hasResponses={false}
        vocabulary={await editorVocabulary(cohort.id)}
      />
    </>,
  )
}
