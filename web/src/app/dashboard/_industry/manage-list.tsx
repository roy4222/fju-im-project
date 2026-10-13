import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import type { ManagedOpportunity, OpportunityStatus } from '@/application/groups'
import { IconAlertTriangle, IconBriefcase } from '@tabler/icons-react'
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
 * 狀態、公司與部門、發布日、連結的組別（可解除），以及編輯、發布、下架、重新發布。
 * 老師的頁面只傳自己的合作案進來（查詢層就只選自己的），系辦是全部。
 *
 * 外觀照原型（票 36）：一個 Panel（系辦「全部合作案」、老師「我的合作案」）裡一條條列，
 * 三欄＝狀態標籤＋公司＋部門・內容｜負責老師＋連結的組別｜動作。
 * 刪除不在這裡（第三波 §9 規則 1）：系辦頁另外在頁面底部放 `OpportunityDangerZone`。
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
    <Panel title={showOwner ? '全部合作案' : '我的合作案'} icon={<IconBriefcase />} description={`${items.length} 件`}>
      {items.length === 0 ? (
        <PanelEmpty title={empty.title} hint={empty.description} />
      ) : (
        <List items={items} statusLabel={statusLabel} labels={labels} showOwner={showOwner} reasonMaxLength={reasonMaxLength} />
      )}
    </Panel>
  )
}

/**
 * 系辦頁底部的「危險操作」區（第三波 W11；§9 規則 1：永久刪除跟日常按鈕拉開）：每一案一列「刪除」。
 * 不能刪的（發布中、連著組別）也列出來，旁邊直接寫原因，按下去的對話框說明要先做什麼（§9 規則 4）。
 * 刪除成功後那一列會消失，成功句子放在這一區的最上面。
 * 清單空了也**照樣渲染這一區**：成功句子的狀態掛在這一區裡，刪掉最後一件時若整區不見，句子會跟著卸載、使用者看不到「已刪除」。
 */
export function OpportunityDangerZone({
  items,
  statusLabel,
}: {
  items: readonly ManagedOpportunity[]
  statusLabel: Record<OpportunityStatus, string>
}) {
  return (
    <OpportunityNoticeProvider>
      <Panel
        title="危險操作"
        icon={<IconAlertTriangle />}
        description="刪除後不能恢復"
        aria-label="危險操作"
        className="border border-destructive/30"
      >
        <div className="space-y-3 border-t border-border/70 px-5 py-3">
          <p className="text-sm text-muted-foreground">
            只有草稿或已下架、而且沒連著組別的合作案可以刪除；刪除後從後台、負責老師的「我的合作案」與前台都消失，不能恢復。
          </p>
          <OpportunityNotice />
        </div>
        {items.length === 0 ? (
          <p className="border-t border-border/70 px-5 py-4 text-sm text-muted-foreground">目前沒有合作案。</p>
        ) : (
          <ul aria-label="合作案刪除清單" className="divide-y divide-border border-t border-border/70">
            {items.map((o) => {
              const name = `${o.fields.companyName}・${o.fields.department}`
              return (
                <li key={o.id} data-testid="danger-opportunity" className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Pill tone={STATUS_TONE[o.status]}>{statusLabel[o.status]}</Pill>
                      <span className="truncate text-sm font-semibold text-foreground">{name}</span>
                    </div>
                    {o.deleteBlocker ? <p className="mt-0.5 text-xs text-muted-foreground">{o.deleteBlocker}</p> : null}
                  </div>
                  <DeleteOpportunityButton
                    opportunityId={o.id}
                    revision={o.revision}
                    name={name}
                    ownerName={o.ownerName}
                    statusLabel={statusLabel[o.status]}
                    blocker={o.deleteBlocker}
                    requestId={randomUUID()}
                  />
                </li>
              )
            })}
          </ul>
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
              <Link href={`/industry/${o.id}`} className="link-ink mt-1 block truncate text-[15px] font-bold text-foreground">
                {o.fields.companyName}
              </Link>
              <p className="truncate text-sm text-muted-foreground">
                {o.fields.department}・{o.fields.content}
              </p>
            </div>
            <LinkedGroupsCell
              header={showOwner ? <span className="mb-0.5 block font-semibold text-foreground">{o.ownerName} 老師</span> : undefined}
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
            </div>
          </li>
        )
      })}
    </ul>
  )
}
