import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import type { ManagedOpportunity, OpportunityStatus } from '@/application/groups'
import { IconBriefcase } from '@tabler/icons-react'
import { AvatarImg } from '@/app/_ui/avatar/avatar-img'
import { Panel, PanelEmpty, Pill } from '@/app/_ui/dashboard/primitives'
import {
  DeleteOpportunityButton,
  OpportunityFormDialog,
  LinkedGroupsCell,
  OpportunityNotice,
  OpportunityNoticeProvider,
  OpportunityStatusButton,
  type OpportunityFormLabels,
} from '@/app/dashboard/_industry/opportunity-forms'
import { cohortLabel } from '@/composition/cohorts'
import { formatTaipeiDate, taipeiDateOf } from '@/shared/time'

/**
 * 合作案管理清單（票 20；原型 `/dashboard/teacher/industry`、`/dashboard/admin/industry` 的清單）：
 * 狀態、公司與部門、發布日、連結的組別（可解除），以及編輯、發布、下架、重新發布、刪除。
 * 老師的頁面只傳自己的合作案進來（查詢層就只選自己的），系辦是全部。
 *
 * 外觀照原型（票 36）：一個 Panel（系辦「全部合作案」、老師「我的合作案」）裡一條條列，
 * 三欄＝狀態標籤＋公司＋部門・內容｜負責老師（頭像＋名字）＋連結的組別｜動作。
 * C3-10（規格③ §6.5）：「刪除」放在每列動作裡，不能刪的 disabled 並直接寫原因；原本頁尾的「危險操作」區拿掉。
 * 刪除成功後那一列會消失，成功句子掛在清單外層（`OpportunityNoticeProvider`），清單空了也還看得到。
 */

const STATUS_TONE: Record<OpportunityStatus, 'success' | 'info' | 'default'> = {
  published: 'success',
  draft: 'info',
  withdrawn: 'default',
}

export function ManageOpportunityList({
  items,
  statusLabel,
  labels,
  showOwner,
  reasonMaxLength,
  empty,
}: {
  items: readonly ManagedOpportunity[]
  statusLabel: Record<OpportunityStatus, string>
  labels: OpportunityFormLabels
  showOwner: boolean
  reasonMaxLength: number
  empty: { title: string; description: string }
}) {
  return (
    <OpportunityNoticeProvider>
      <Panel title={showOwner ? '全部合作案' : '我的合作案'} icon={<IconBriefcase />} description={`${items.length} 件`}>
        <div className="border-t border-border/70 px-5 py-3 empty:hidden">
          <OpportunityNotice />
        </div>
        {items.length === 0 ? (
          <PanelEmpty title={empty.title} hint={empty.description} />
        ) : (
          <List items={items} statusLabel={statusLabel} labels={labels} showOwner={showOwner} reasonMaxLength={reasonMaxLength} />
        )}
      </Panel>
    </OpportunityNoticeProvider>
  )
}

function List({
  items,
  statusLabel,
  labels,
  showOwner,
  reasonMaxLength,
}: {
  items: readonly ManagedOpportunity[]
  statusLabel: Record<OpportunityStatus, string>
  labels: OpportunityFormLabels
  showOwner: boolean
  reasonMaxLength: number
}) {
  return (
    <ul aria-label="合作案清單" className="divide-y divide-border border-t border-border/70">
      {items.map((o) => {
        const name = `${o.fields.companyName}・${o.fields.department}`
        return (
          <li
            key={o.id}
            data-testid="managed-opportunity"
            className="grid items-center gap-3 px-5 py-4 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_auto]"
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Pill tone={STATUS_TONE[o.status]}>{statusLabel[o.status]}</Pill>
                {o.links.length > 0 ? <Pill>已有 {o.links.length} 組</Pill> : o.status === 'published' ? <Pill tone="brand">尚未指派</Pill> : null}
                {o.publishedAt ? (
                  <span className="tabular text-xs text-muted-foreground">{formatTaipeiDate(taipeiDateOf(o.publishedAt))} 發布</span>
                ) : null}
              </div>
              <Link href={`/industry/${o.id}`} className="link-ink mt-1 block truncate text-[15px] font-bold text-foreground hover:text-primary">
                {o.fields.companyName}
              </Link>
              <p className="truncate text-sm text-muted-foreground">
                {o.fields.department}・{o.fields.content}
              </p>
            </div>
            <LinkedGroupsCell
              header={
                showOwner ? (
                  // 負責老師：頭像 24px＋名字（C3 §2.2；名字就在旁邊，頭像不再唸一次）。
                  <span className="mb-1 flex items-center gap-1.5 font-semibold text-foreground">
                    <AvatarImg
                      user={{ id: o.ownerUserId, name: o.ownerName, avatarPreset: o.ownerAvatarPreset, avatarFileId: o.ownerAvatarFileId }}
                      size={24}
                      decorative
                    />
                    {o.ownerName} 老師
                  </span>
                ) : undefined
              }
              links={o.links.map((l) => ({ linkId: l.linkId, groupCode: l.groupCode, cohortLabel: cohortLabel({ name: l.cohortName, code: l.cohortCode }) }))}
              opportunityName={name}
              requestId={randomUUID()}
              reasonMaxLength={reasonMaxLength}
            />
            <div className="flex flex-wrap items-center gap-2 md:justify-self-end">
              {o.status !== 'withdrawn' ? (
                <OpportunityFormDialog
                  labels={labels}
                  requestId={randomUUID()}
                  initial={{ opportunityId: o.id, revision: o.revision, values: o.fields, name }}
                />
              ) : null}
              <OpportunityStatusButton
                opportunityId={o.id}
                revision={o.revision}
                name={name}
                kind={o.status === 'published' ? 'withdraw' : o.status === 'withdrawn' ? 'republish' : 'publish'}
                requestId={randomUUID()}
              />
              <DeleteOpportunityButton
                opportunityId={o.id}
                revision={o.revision}
                name={name}
                ownerName={o.ownerName}
                statusLabel={statusLabel[o.status]}
                blocker={o.deleteBlocker}
                requestId={randomUUID()}
              />
            </div>
          </li>
        )
      })}
    </ul>
  )
}
