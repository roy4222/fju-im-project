import Link from 'next/link'
import type { ReactNode } from 'react'
import {
  IconBell,
  IconCalendarDue,
  IconChecklist,
  IconSettings,
  IconSignature,
  IconUpload,
  IconUserCheck,
  IconUsersGroup,
  type Icon,
} from '@tabler/icons-react'
import type { ResolvedActor } from '@/application/accounts'
import type { InboxItem } from '@/application/notifications'
import { PageTitle, Panel, pillClass } from '@/app/_ui/dashboard-kit'
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
 * 三個角色共用這一份畫面（連頁首），差別只在外殼。預設看本人所有屆別與全站的通知，新到舊；
 * 屆別篩選只列出本人通知裡出現過的屆別（含已封存的舊屆）。未讀的列底色較深、有點。
 *
 * 外觀照原型（票 35）：頁首「通知／N 則未讀」＋右側「全部標為已讀」，下面一張「全部」卡，
 * 每列左邊是類型圖示方塊。原型整列是連結；這裡列上還有「標為已讀」表單，所以只有標題是連結。
 */

const KIND_ICON: Record<string, Icon> = {
  due: IconCalendarDue,
  submission: IconUpload,
  signoff: IconSignature,
  grading: IconChecklist,
  account: IconUserCheck,
  group: IconUsersGroup,
  system: IconSettings,
}
export async function InboxView({
  actor,
  basePath,
  cohortParam,
  cursor,
  children,
}: {
  actor: ResolvedActor
  basePath: string
  cohortParam: string | undefined
  cursor: string | undefined
  /** 頁首與列表之間（系辦的「發一則測試通知」）。 */
  children?: ReactNode
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
  const active = chips.find((c) => c.value === filterValue) ?? chips[0]!

  return (
    <div className="flex flex-col gap-5">
      <PageTitle
        title="通知"
        description={<span data-testid="inbox-unread">{unread > 0 ? `${unread} 則未讀` : '全部已讀'}</span>}
        actions={<MarkAllReadButton cohort={filterValue ?? ''} disabled={unread === 0} />}
      />
      {children}

      <Panel
        title={active.label}
        icon={<IconBell />}
        action={
          <nav aria-label="依屆別篩選" className="flex flex-wrap gap-1">
            {chips.map((chip) => {
              const on = chip.value === filterValue
              return (
                <Link
                  key={chip.value ?? 'all'}
                  href={hrefFor(chip.value)}
                  aria-current={on ? 'page' : undefined}
                  className={pillClass(on)}
                >
                  {chip.label}
                </Link>
              )
            })}
          </nav>
        }
      >
        {page.items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 border-t border-border px-4 py-10 text-center">
            <IconBell aria-hidden className="size-7 text-muted-foreground/50" />
            <p className="text-sm font-semibold">{filter.kind === 'all' ? '還沒有通知' : '這個範圍沒有通知'}</p>
            <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">
              {filter.kind === 'all'
                ? '跟你有關的公告、截止、分組與簽核有變化時，會出現在這裡。'
                : '換一個屆別，或點「全部」看所有通知。'}
            </p>
          </div>
        ) : (
          <ul aria-label="通知列表" className="divide-y divide-border border-t border-border">
            {page.items.map((item) => (
              <InboxRow key={item.id} item={item} />
            ))}
          </ul>
        )}
      </Panel>

      {page.nextCursor ? (
        <div className="text-center">
          <Link
            href={`${basePath}?${new URLSearchParams({ ...(filterValue ? { cohort: filterValue } : {}), cursor: page.nextCursor })}`}
            className="text-sm font-semibold text-primary hover:underline"
          >
            看更早的通知
          </Link>
        </div>
      ) : null}
    </div>
  )
}

function InboxRow({ item }: { item: InboxItem }) {
  const unread = item.readAt === null
  const blocked = item.source.state === 'forbidden' || item.source.state === 'withdrawn'
  const title = blocked ? SOURCE_STATE_TEXT[item.source.state as 'forbidden' | 'withdrawn'] : item.title
  const href = item.source.state === 'ok' || item.source.state === 'archived' ? item.source.href : null
  const KindIcon = KIND_ICON[item.kind] ?? IconSettings

  return (
    <li
      data-testid="inbox-item"
      data-read={unread ? 'false' : 'true'}
      className={cn('flex items-start gap-4 px-5 py-4 transition-colors hover:bg-accent/60', unread ? 'bg-accent/40' : '')}
    >
      <span
        aria-hidden
        className={cn(
          'mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted',
          item.kind === 'system' ? 'text-muted-foreground' : 'text-foreground',
        )}
      >
        <KindIcon className="size-4.5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2">
          <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-muted-foreground">
            {notificationKindLabel(item.kind)}
          </span>
          <span className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
            {item.cohortCode ?? '全站'}
          </span>
          {href ? (
            <Link href={href} className={cn('min-w-0 truncate text-[15px] hover:underline', unread ? 'font-bold' : 'font-medium')}>
              {title}
            </Link>
          ) : (
            <span className={cn('min-w-0 truncate text-[15px]', unread ? 'font-bold' : 'font-medium')}>{title}</span>
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
            <span className="size-2 rounded-full bg-primary" aria-hidden />
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
