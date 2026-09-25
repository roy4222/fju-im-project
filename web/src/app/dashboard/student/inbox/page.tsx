import Link from 'next/link'
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
import { Panel } from '@/app/_ui/dashboard-primitives'
import { requireRole } from '@/app/_ui/guard'
import { EmptyState } from '@/app/_ui/primitives'
import { DashboardShell } from '@/app/_ui/site-shell'
import { STUDENT_NAV } from '@/app/dashboard/_nav'
import { MarkAllReadButton, MarkReadButton } from '@/app/dashboard/_inbox/inbox-forms'
import type { InboxItem } from '@/application/notifications'
import { getInboxQuery, inboxFilterParam, notificationKindLabel, parseInboxFilter, SOURCE_STATE_TEXT } from '@/composition/inbox'
import { cn } from '@/shared/cn'
import { formatTaipeiMinute } from '@/shared/time'

export const metadata = { title: '通知｜資管系專題平台' }

type Search = Promise<{ cohort?: string | string[]; cursor?: string | string[] }>

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)

const BASE = '/dashboard/student/inbox'

/** 每種通知的小圖示（原型 inbox 的 KIND_ICON）。 */
const KIND_ICON: Record<string, Icon> = {
  due: IconCalendarDue,
  submission: IconUpload,
  signoff: IconSignature,
  grading: IconChecklist,
  account: IconUserCheck,
  group: IconUsersGroup,
  system: IconSettings,
}

/**
 * 學生的通知匣（票 12；原型 `/dashboard/student/inbox`，票 38 換成原型版型）：頁標題寫未讀數、右上「全部標為已讀」，
 * 一張白卡裡一則一列（種類圖示、種類標籤、標題、屆別，右邊時間與未讀點）。
 *
 * 讀取與動作跟三個角色共用的 `_inbox/inbox-view.tsx` 同一份（`InboxQuery`、`MarkAllReadButton`／`MarkReadButton`）；
 * 這裡只換版型，老師與系辦的通知匣由各自的票再對原型。依屆別篩選（原型沒有）保留在卡片上方。
 */
export default async function StudentInboxPage({ searchParams }: { searchParams: Search }) {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  const actor = await requireRole(BASE, 'student')
  const params = await searchParams
  const cursor = first(params.cursor)

  const query = getInboxQuery()
  const filter = parseInboxFilter(first(params.cohort))
  const [page, unread, cohorts] = await Promise.all([query.list(actor, filter, cursor ?? null), query.unreadCount(actor), query.cohortOptions(actor)])
  const filterValue = inboxFilterParam(filter)
  const hrefFor = (cohort: string | null) => (cohort ? `${BASE}?cohort=${cohort}` : BASE)
  const chips: { value: string | null; label: string }[] = [
    { value: null, label: '全部' },
    { value: 'global', label: '全站' },
    ...cohorts.map((c) => ({ value: c.cohortId, label: c.code })),
  ]

  return (
    <DashboardShell roleLabel="學生" items={STUDENT_NAV} current={BASE}>
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-[24px] font-extrabold tracking-tight">通知</h1>
            <p className="mt-1 text-sm text-muted-foreground" data-testid="inbox-unread">
              {unread > 0 ? `${unread} 則未讀` : '全部已讀'}
            </p>
          </div>
          <MarkAllReadButton cohort={filterValue ?? ''} disabled={unread === 0} />
        </div>

        <Panel
          title={chips.find((c) => c.value === filterValue)?.label ?? '全部'}
          icon={<IconBell />}
          description="跟你有關的事件；已讀狀態跟著帳號"
        >
          <nav aria-label="依屆別篩選" className="flex flex-wrap gap-1.5 border-b border-border/70 px-5 pb-3">
            {chips.map((chip) => {
              const active = chip.value === filterValue
              return (
                <Link
                  key={chip.value ?? 'all'}
                  href={hrefFor(chip.value)}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'inline-flex h-9 items-center rounded-full border px-3.5 text-sm font-semibold transition-colors',
                    active ? 'border-ink bg-ink text-ink-foreground' : 'border-border text-foreground hover:bg-accent',
                  )}
                >
                  {chip.label}
                </Link>
              )
            })}
          </nav>

          {page.items.length === 0 ? (
            <div className="p-5">
              <EmptyState
                title={filter.kind === 'all' ? '還沒有通知' : '這個範圍沒有通知'}
                description={
                  filter.kind === 'all' ? '跟你有關的公告、截止、分組與簽核有變化時，會出現在這裡。' : '換一個屆別，或點「全部」看所有通知。'
                }
              />
            </div>
          ) : (
            <section aria-label="通知列表">
              <ul className="divide-y divide-border">
                {page.items.map((item) => (
                  <Row key={item.id} item={item} />
                ))}
              </ul>
            </section>
          )}

          {page.nextCursor ? (
            <div className="border-t border-border/70 px-5 py-3 text-center">
              <Link
                href={`${BASE}?${new URLSearchParams({ ...(filterValue ? { cohort: filterValue } : {}), cursor: page.nextCursor })}`}
                className="text-sm font-semibold text-ink hover:underline"
              >
                看更早的通知
              </Link>
            </div>
          ) : null}
        </Panel>
      </div>
    </DashboardShell>
  )
}

/** 一則通知（原型一列：圖示方塊、種類標籤＋標題、右邊時間與未讀點）。整列不做成連結：右邊有「標為已讀」按鈕。 */
function Row({ item }: { item: InboxItem }) {
  const unread = item.readAt === null
  const blocked = item.source.state === 'forbidden' || item.source.state === 'withdrawn'
  const title = blocked ? SOURCE_STATE_TEXT[item.source.state as 'forbidden' | 'withdrawn'] : item.title
  const href = item.source.state === 'ok' || item.source.state === 'archived' ? item.source.href : null
  const KindIcon = KIND_ICON[item.kind] ?? IconBell

  return (
    <li
      data-testid="inbox-item"
      data-read={unread ? 'false' : 'true'}
      className={cn('flex items-start gap-4 px-5 py-4 transition-colors hover:bg-accent/60', unread ? 'bg-accent/40' : '')}
    >
      <span className="mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground" aria-hidden>
        <KindIcon className="size-4.5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2">
          <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-muted-foreground">{notificationKindLabel(item.kind)}</span>
          {href ? (
            <Link href={href} className={cn('min-w-0 truncate text-[15px] hover:underline', unread ? 'font-bold' : 'font-medium')}>
              {title}
            </Link>
          ) : (
            <span className={cn('min-w-0 truncate text-[15px]', unread ? 'font-bold' : 'font-medium')}>{title}</span>
          )}
        </p>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {item.cohortCode ?? '全站'}
          {item.source.state === 'archived' ? `・${SOURCE_STATE_TEXT.archived}` : ''}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        <time dateTime={item.createdAt.toISOString()} className="tabular text-xs text-muted-foreground">
          {formatTaipeiMinute(item.createdAt)}
        </time>
        {unread ? (
          <>
            <span className="size-2 rounded-full bg-brand" aria-hidden />
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
