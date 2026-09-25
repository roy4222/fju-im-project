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
import type { InboxItem } from '@/application/notifications'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { TEACHER_NAV } from '@/app/dashboard/_nav'
import { PageTitle, Panel, PanelEmpty } from '@/app/dashboard/teacher/_ui/dash'
import { MarkAllReadButton, MarkReadButton } from '@/app/dashboard/teacher/inbox/inbox-forms'
import {
  getInboxQuery,
  inboxFilterParam,
  notificationKindLabel,
  parseInboxFilter,
  SOURCE_STATE_TEXT,
} from '@/composition/inbox'
import { cn } from '@/shared/cn'
import { formatTaipeiMinute } from '@/shared/time'

export const metadata = { title: '通知｜資管系專題平台' }

type Search = Promise<{ cohort?: string | string[]; cursor?: string | string[] }>

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)

/** 每一類通知的圖示（原型 `inbox/page.tsx` 的 KIND_ICON；正式碼多一類「分組」）。 */
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
 * 老師的通知匣（票 12；票 37 照原型 `/dashboard/teacher/inbox`）。
 *
 * 資料與規則跟三個角色共用的 `InboxView` 一樣（同一個 `getInboxQuery`、同一支標已讀的 Server Action）：
 * 預設看本人所有屆別與全站、新到舊；屆別篩選只列出本人通知裡出現過的屆別；點進去前逐筆回來源重驗。
 * 外觀換成原型：標題右邊「全部標為已讀」，一張「全部」白卡，每列一個分類圖示、未讀列淡底加小橘點。
 */
export default async function TeacherInboxPage({ searchParams }: { searchParams: Search }) {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  const actor = await requireRole('/dashboard/teacher/inbox', 'teacher')
  const params = await searchParams
  const basePath = '/dashboard/teacher/inbox'

  const query = getInboxQuery()
  const filter = parseInboxFilter(first(params.cohort))
  const [page, unread, cohorts] = await Promise.all([
    query.list(actor, filter, first(params.cursor) ?? null),
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
    <DashboardShell roleLabel="老師" items={TEACHER_NAV} current={basePath}>
      <div className="flex flex-col gap-5">
        <PageTitle
          title="通知"
          description={
            <>
              <span data-testid="inbox-unread">{unread > 0 ? `${unread} 則未讀` : '全部已讀'}</span>・跟你有關的事件都會出現在這裡
            </>
          }
          actions={<MarkAllReadButton cohort={filterValue ?? ''} disabled={unread === 0} />}
        />

        <nav aria-label="依屆別篩選" className="inline-flex w-fit max-w-full flex-wrap gap-1 rounded-xl border border-border bg-card p-1">
          {chips.map((chip) => {
            const active = chip.value === filterValue
            return (
              <Link
                key={chip.value ?? 'all'}
                href={hrefFor(chip.value)}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'tabular inline-flex h-9 items-center rounded-lg px-3 text-sm font-semibold transition-colors',
                  active ? 'bg-ink text-ink-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                {chip.label}
              </Link>
            )
          })}
        </nav>

        <Panel title={chips.find((c) => c.value === filterValue)?.label ?? '全部'} label="通知列表" icon={<IconBell />}>
          {page.items.length === 0 ? (
            <PanelEmpty
              icon={<IconBell />}
              title={filter.kind === 'all' ? '還沒有通知' : '這個範圍沒有通知'}
              hint={
                filter.kind === 'all'
                  ? '跟你有關的公告、截止、分組與簽核有變化時，會出現在這裡。'
                  : '換一個屆別，或點「全部」看所有通知。'
              }
            />
          ) : (
            <ul className="divide-y divide-border">
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
              className="text-sm font-semibold text-muted-foreground hover:text-foreground"
            >
              看更早的通知
            </Link>
          </div>
        ) : null}
      </div>
    </DashboardShell>
  )
}

function InboxRow({ item }: { item: InboxItem }) {
  const unread = item.readAt === null
  const blocked = item.source.state === 'forbidden' || item.source.state === 'withdrawn'
  const title = blocked ? SOURCE_STATE_TEXT[item.source.state as 'forbidden' | 'withdrawn'] : item.title
  const href = item.source.state === 'ok' || item.source.state === 'archived' ? item.source.href : null
  const Icon = KIND_ICON[item.kind] ?? IconSettings

  return (
    <li
      data-testid="inbox-item"
      data-read={unread ? 'false' : 'true'}
      className={cn('flex items-start gap-4 px-5 py-4 transition-colors hover:bg-accent/60', unread ? 'bg-accent/40' : '')}
    >
      <span className="mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground" aria-hidden>
        <Icon className="size-4.5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-muted-foreground">{notificationKindLabel(item.kind)}</span>
          <span className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">{item.cohortCode ?? '全站'}</span>
          {href ? (
            <Link href={href} className={cn('min-w-0 truncate text-[15px] text-foreground hover:underline', unread ? 'font-bold' : 'font-medium')}>
              {title}
            </Link>
          ) : (
            <span className={cn('min-w-0 truncate text-[15px] text-foreground', unread ? 'font-bold' : 'font-medium')}>{title}</span>
          )}
        </p>
        {item.source.state === 'archived' ? <p className="mt-0.5 text-sm text-muted-foreground">{SOURCE_STATE_TEXT.archived}</p> : null}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        <time dateTime={item.createdAt.toISOString()} className="tabular text-xs text-muted-foreground">
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
