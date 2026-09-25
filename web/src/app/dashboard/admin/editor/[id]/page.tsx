import { notFound } from 'next/navigation'
import { requireRole } from '@/app/_ui/guard'
import { IconHistory } from '@tabler/icons-react'
import { Panel } from '@/app/_ui/dashboard-kit'
import { DashboardShell } from '@/app/_ui/site-shell'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { fieldFromSchema, type EditorState } from '@/app/dashboard/admin/affairs/item-form-model'
import { editorVocabulary } from '@/app/dashboard/admin/affairs/vocabulary'
import { ItemEditor } from '@/app/dashboard/admin/editor/item-editor'
import { getCohortStatusQuery } from '@/composition/cohorts'
import { getItemQuery, ITEM_STATUS_LABEL } from '@/composition/items'
import { formatTaipeiMinute, toTaipeiDateTimeInput } from '@/shared/time'

export const metadata = { title: '編輯專題事務｜資管系專題平台' }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** `datetime-local` 用的臺灣時間（到分鐘）。 */
function minuteInput(instant: Date | null): string {
  return instant ? toTaipeiDateTimeInput(instant).slice(0, 16) : ''
}

const ACTION_LABEL: Record<string, string> = {
  publish: '發布',
  content_change: '改內容',
  schema_change: '改欄位',
  settings_change: '改對象或收件設定',
  deadline_change: '改截止',
  withdraw: '撤回',
  archive: '下架',
  republish: '重新發布',
}

/** 完整編輯器（既有項目；快速建立的「細調欄位」也進這裡，同一個項目 ID）。 */
export default async function EditItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await requireRole(`/dashboard/admin/editor/${UUID.test(id) ? id : 'new'}`, 'admin')
  if (!UUID.test(id)) notFound()

  const item = await getItemQuery().get(id)
  if (!item) notFound()
  const cohort = await getCohortStatusQuery().get(item.cohortId)

  const initial: EditorState = {
    cohortId: item.cohortId,
    placement: item.placement,
    title: item.title,
    summary: item.summary,
    body: item.bodyHtml,
    category: item.category ?? '',
    cover: item.cover,
    attachments: [...item.attachments],
    audienceKind: item.audienceKind,
    groupIds: [...item.groupIds],
    receiverUnit: item.receiverUnit,
    stageId: item.stageId ?? '',
    opensAt: minuteInput(item.opensAt),
    dueAt: minuteInput(item.dueAt),
    fields: item.fields.map(fieldFromSchema),
  }

  const versions =
    item.contentVersionNo !== null
      ? `內容 v${item.contentVersionNo}・欄位 v${item.schemaVersionNo}${item.receiverUnit === 'none' ? '' : `・應交 ${item.rosterCount} ${item.receiverUnit === 'group' ? '組' : '位'}`}`
      : '還沒發布過'
  const opened = item.actualOpenedAt ? `・實際開放 ${formatTaipeiMinute(item.actualOpenedAt)}` : ''

  return (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current="/dashboard/admin/affairs">
      <div className="flex flex-col gap-5">
        <ItemEditor
          initial={initial}
          itemId={item.id}
          revision={item.revision}
          status={item.status}
          hasResponses={item.hasResponses}
          vocabulary={await editorVocabulary(item.cohortId)}
          heading="編輯專題事務"
          meta={`${cohort?.code ?? ''}・${ITEM_STATUS_LABEL[item.status]}・${versions}${opened}`}
        />
        {item.publications.length > 0 ? (
          <Panel title="發布紀錄" icon={<IconHistory />} description={`${item.publications.length} 筆`} aria-label="發布紀錄">
            <ul className="divide-y divide-border border-t border-border text-sm">
              {item.publications.map((p, index) => (
                <li key={index} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2.5 tabular-nums">
                  <span className="font-semibold">{ACTION_LABEL[p.action] ?? p.action}</span>
                  <span className="text-muted-foreground">
                    {formatTaipeiMinute(p.realAt)}・{p.actorName}
                    {p.notify ? '・有通知' : '・未通知'}
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
        ) : null}
      </div>
    </DashboardShell>
  )
}
