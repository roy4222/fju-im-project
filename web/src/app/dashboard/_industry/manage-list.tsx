import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import type { ManagedOpportunity, OpportunityStatus } from '@/application/groups'
import { EmptyState } from '@/app/_ui/primitives'
import {
  OpportunityFormDialog,
  LinkedGroupsCell,
  OpportunityStatusButton,
  type OpportunityFormLabels,
} from '@/app/dashboard/_industry/opportunity-forms'
import { cn } from '@/shared/cn'
import { formatTaipeiDate, taipeiDateOf } from '@/shared/time'

/**
 * 合作案管理清單（票 20；原型 `/dashboard/teacher/industry`、`/dashboard/admin/industry` 的清單）：
 * 狀態、公司與部門、發布日、連結的組別（可解除），以及編輯、發布、下架、重新發布。
 * 老師的頁面只傳自己的合作案進來（查詢層就只選自己的），系辦是全部。
 */

const STATUS_TONE: Record<OpportunityStatus, string> = {
  draft: 'bg-muted text-muted-foreground',
  published: 'bg-primary-subtle text-primary-on-subtle',
  withdrawn: 'bg-danger-subtle text-danger-on-subtle',
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
  if (items.length === 0) return <EmptyState title={empty.title} description={empty.description} />
  return (
    <ul aria-label="合作案清單" className="divide-y divide-border rounded-card border border-border bg-background">
      {items.map((o) => {
        const name = `${o.fields.companyName}・${o.fields.department}`
        return (
          <li key={o.id} data-testid="managed-opportunity" className="grid gap-3 px-5 py-4 md:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold', STATUS_TONE[o.status])}>{statusLabel[o.status]}</span>
                {o.publishedAt ? (
                  <span className="text-xs text-muted-foreground tabular-nums">{formatTaipeiDate(taipeiDateOf(o.publishedAt))} 發布</span>
                ) : null}
                {showOwner ? <span className="text-xs font-semibold text-ink">{o.ownerName} 老師</span> : null}
              </div>
              <Link href={`/industry/${o.id}`} className="mt-1 block truncate text-base font-semibold text-ink hover:text-primary">
                {name}
              </Link>
              <p className="line-clamp-2 text-sm text-muted-foreground">{o.fields.content}</p>
              <div className="mt-3 flex flex-wrap items-start gap-2">
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
            </div>
            <LinkedGroupsCell
              links={o.links.map((l) => ({ linkId: l.linkId, groupCode: l.groupCode, cohortCode: l.cohortCode }))}
              opportunityName={name}
              requestId={randomUUID()}
              reasonMaxLength={reasonMaxLength}
            />
          </li>
        )
      })}
    </ul>
  )
}
