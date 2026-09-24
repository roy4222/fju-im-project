import Link from 'next/link'
import type { ResolvedActor } from '@/application/accounts'
import type { InboxItem } from '@/application/notifications'
import { EmptyState } from '@/app/_ui/primitives'
import { MarkAllReadButton, MarkReadButton } from '@/app/dashboard/_inbox/inbox-forms'
import {
  getInboxQuery,
  inboxFilterParam,
  notificationKindLabel,
  parseInboxFilter,
  SOURCE_STATE_TEXT,
} from '@/composition/inbox'
import { cn } from '@/shared/cn'
import { formatTaipeiMinute } from '@/shared/time'

/**
 * 通知匣（票 12；原型 `/dashboard/<角色>/inbox`；產品模組 08 §4「通知匣」「通知內容及操作」）。
 *
 * 三個角色共用這一份畫面，差別只在外殼。預設看本人所有屆別與全站的通知，新到舊；
 * 上方的屆別篩選只列出本人通知裡出現過的屆別（含已封存的舊屆）。未讀的列底色較深、有點。
 */
export async function InboxView({
  actor,
  basePath,
  cohortParam,
  cursor,
}: {
  actor: ResolvedActor
  basePath: string
  cohortParam: string | undefined
  cursor: string | undefined
}) {
  const query = getInboxQuery()
  const filter = parseInboxFilter(cohortParam)
  const [page, unread, cohorts] = await Promise.all([
    query.list(actor, filter, cursor ?? null),
    query.unreadCount(actor),
    query.cohortOptions(actor),
  ])
  const filterValue = inboxFilterParam(filter)
  const hrefFor = (cohort: string | null) => (cohort ? `${basePath}?cohort=${cohort}` : basePath)
  const chips: { value: string | null; label: string }[] = [
    { value: null, label: '全部' },
    { value: 'global', label: '全站' },
    ...cohorts.map((c) => ({ value: c.cohortId, label: c.code })),
  ]

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground" data-testid="inbox-unread">
          {unread > 0 ? `${unread} 則未讀` : '全部已讀'}
        </p>
        <MarkAllReadButton cohort={filterValue ?? ''} disabled={unread === 0} />
      </div>

      <nav aria-label="依屆別篩選" className="mb-4 flex flex-wrap gap-2">
        {chips.map((chip) => {
          const active = chip.value === filterValue
          return (
            <Link
              key={chip.value ?? 'all'}
              href={hrefFor(chip.value)}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'rounded-full border px-3 py-1 text-sm',
                active ? 'border-primary bg-primary-subtle text-primary-on-subtle' : 'border-border text-ink hover:bg-muted',
              )}
            >
              {chip.label}
            </Link>
          )
        })}
      </nav>

      {page.items.length === 0 ? (
        <EmptyState
          title={filter.kind === 'all' ? '還沒有通知' : '這個範圍沒有通知'}
          description={
            filter.kind === 'all'
              ? '跟你有關的公告、截止、分組與簽核有變化時，會出現在這裡。'
              : '換一個屆別，或點「全部」看所有通知。'
          }
        />
      ) : (
        <section aria-label="通知列表" className="overflow-hidden rounded-card border border-border bg-background">
          <ul className="divide-y divide-border">
            {page.items.map((item) => (
              <InboxRow key={item.id} item={item} />
            ))}
          </ul>
        </section>
      )}

      {page.nextCursor ? (
        <div className="mt-4 text-center">
          <Link
            href={`${basePath}?${new URLSearchParams({ ...(filterValue ? { cohort: filterValue } : {}), cursor: page.nextCursor })}`}
            className="text-sm font-medium text-primary hover:underline"
          >
            看更早的通知
          </Link>
        </div>
      ) : null}
    </>
  )
}

function InboxRow({ item }: { item: InboxItem }) {
  const unread = item.readAt === null
  const blocked = item.source.state === 'forbidden' || item.source.state === 'withdrawn'
  const title = blocked ? SOURCE_STATE_TEXT[item.source.state as 'forbidden' | 'withdrawn'] : item.title
  const href = item.source.state === 'ok' || item.source.state === 'archived' ? item.source.href : null

  return (
    <li
      data-testid="inbox-item"
      data-read={unread ? 'false' : 'true'}
      className={cn('flex items-start gap-4 px-5 py-4', unread ? 'bg-primary-subtle/40' : '')}
    >
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2">
          <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-muted-foreground">
            {notificationKindLabel(item.kind)}
          </span>
          <span className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
            {item.cohortCode ?? '全站'}
          </span>
          {href ? (
            <Link href={href} className={cn('truncate text-[15px] hover:underline', unread ? 'font-bold' : 'font-medium')}>
              {title}
            </Link>
          ) : (
            <span className={cn('truncate text-[15px]', unread ? 'font-bold text-ink' : 'font-medium text-ink')}>{title}</span>
          )}
        </p>
        {item.source.state === 'archived' ? (
          <p className="mt-0.5 text-sm text-muted-foreground">{SOURCE_STATE_TEXT.archived}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        <time dateTime={item.createdAt.toISOString()} className="text-xs text-muted-foreground tabular-nums">
          {formatTaipeiMinute(item.createdAt)}
        </time>
        {unread ? (
          <>
            <span className="sr-only">未讀</span>
            <MarkReadButton notificationId={item.id} title={title} />
          </>
        ) : (
          <span className="text-xs text-muted-foreground">已讀</span>
        )}
      </div>
    </li>
  )
}
