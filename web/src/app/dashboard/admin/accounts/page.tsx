import Link from 'next/link'
import { redirect } from 'next/navigation'
import { IconUsers } from '@tabler/icons-react'
import { UserAvatar } from '@/app/_ui/avatar/user-avatar'
import { requireRole } from '@/app/_ui/guard'
import { loadAdminSummary } from '@/app/_ui/workload'
import { DashboardShell } from '@/app/_ui/site-shell'
import { ClearFilters, Pager, SearchForm } from '@/app/_ui/data-table'
import { FacetMenu } from '@/app/_ui/data-table-facet'
import { PageTitle, Panel } from '@/app/_ui/dashboard/primitives'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { AdminTabs } from '@/app/dashboard/admin/_tabs'
import { ACCOUNT_TABS } from '@/app/dashboard/admin/_tabs.consts'
import { legacyAdminRedirect } from '@/app/dashboard/admin/legacy-redirects'
import type { DirectoryFilter, DirectorySort } from '@/application/accounts'
import {
  ACCOUNT_STATUS_LABEL,
  DIRECTORY_ROLES,
  DIRECTORY_SORTS,
  DIRECTORY_STATUSES,
  directoryQueryString,
  getAccountDirectoryCommand,
  normalizeDirectoryFilter,
  ROLE_LABEL,
  SEARCH_MAX_LENGTH,
  VERIFICATION_LABEL,
  VERIFICATION_METHODS,
  VERIFICATION_NOTE_HINT,
  VERIFICATION_NOTE_REQUIRED,
} from '@/composition/accounts'
import { cn } from '@/shared/cn'
import { AccountsTable, type SortHeader } from './accounts-table'
import { NewMemberDialog } from './new-member-dialog'
import type { VerificationLabels } from './temporary-password-dialog'

const VERIFICATION_LABELS: VerificationLabels = {
  // 對話框還在問核實方式（C2-09／C2-11 才拿掉）：自動開通與系辦審核那三個新值不是人能選的，排除（C2-10 Review）。
  methods: VERIFICATION_METHODS.filter((m) => m !== 'google_email_match' && m !== 'office_review' && m !== 'email_roster_match'),
  methodLabel: VERIFICATION_LABEL,
  noteRequired: VERIFICATION_NOTE_REQUIRED,
  noteHint: VERIFICATION_NOTE_HINT,
  // 新增老師、替老師或職員發臨時密碼時不提學生證（T6 系5）。只換顯示文字，存進紀錄的核實方式代碼不變。
  teacherMethodLabel: { ...VERIFICATION_LABEL, id_document: '當面核對身分證件（教職員證、身分證）' },
  teacherNoteHint: { ...VERIFICATION_NOTE_HINT, id_document: '選填，例如「10/9 系辦核對教職員證」' },
}

export const metadata = { title: '帳號｜資管系專題平台' }

const BASE = '/dashboard/admin/accounts'

/** 排序欄的連結：點目前的欄就反轉方向，點別的欄從該欄的自然方向開始（建立時間新到舊，其他小到大）。 */
function sortHeaders(filter: DirectoryFilter): Record<DirectorySort, SortHeader> {
  const entries = DIRECTORY_SORTS.map((sort) => {
    const active = filter.sort === sort ? filter.dir : null
    const dir = active ? (active === 'asc' ? 'desc' : 'asc') : sort === 'createdAt' ? 'desc' : 'asc'
    return [sort, { href: `${BASE}${directoryQueryString(filter, { sort, dir, page: 1 })}`, active }] as const
  })
  return Object.fromEntries(entries) as Record<DirectorySort, SortHeader>
}

/** 帳號列表上方的篩選膠囊（D-6／Q116：取代三顆圓環磚）：數字跟字在同一顆，點了就篩、再點一次取消。 */
function StatusPill({ label, value, href, active, hot = false }: { label: string; value: number | null; href: string; active: boolean; hot?: boolean }) {
  return (
    <Link
      href={href}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-sm font-semibold whitespace-nowrap transition-colors',
        active ? 'border-ink bg-ink text-ink-foreground' : 'border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      {label}
      <span className={cn('tabular', !active && hot && value ? 'text-brand' : null)}>{value ?? '—'}</span>
    </Link>
  )
}

export default async function AdminAccountsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  // 授權檢查在**頁面自己**：放在 layout 擋不住，App Router 會把 layout 與 page 並行渲染，
  // layout 丟掉 children 或 redirect 都來不及——那一頁已經被做出來、跟著 payload 送走了。
  const actor = await requireRole('/dashboard/admin/accounts', 'admin')
  const params = await searchParams
  // 舊的 `?status=pending|disabled` 書籤：守衛之後轉到「待審核」「已停用」分頁，其餘 query 照帶（`legacy-redirects.ts`）。
  const legacy = legacyAdminRedirect(BASE, params)
  if (legacy) redirect(legacy)

  // 用例自己再判一次授權（頁面通過不代表用例會放行）。
  const filter = normalizeDirectoryFilter(params)
  const accounts = getAccountDirectoryCommand()
  const directoryResult = await accounts.list(actor, filter)
  const directory = directoryResult.ok ? directoryResult.receipt : null
  // 跟側欄徽章共用同一份（SH-P2，React cache）：同一請求只查一次 summary。
  const summary = await loadAdminSummary(actor.userId)
  const totalPages = directory ? Math.max(1, Math.ceil(directory.total / directory.pageSize)) : 1
  const statusHref = (status: DirectoryFilter['status']) =>
    `${BASE}${directoryQueryString({ ...filter, status: filter.status === status ? null : status, orphan: false, page: 1 })}`
  // 「待審核」「已停用」各有自己的分頁（C 階段規格② §3.1）：膠囊直接連過去，搜尋字照帶。
  const tabHref = (tab: 'pending' | 'disabled') => `${BASE}/${tab}${directoryQueryString({ ...filter, status: null, orphan: false, page: 1 })}`
  const everyone = summary ? summary.pending + summary.active + summary.disabled : 0
  const hrefWith = (overrides: Partial<DirectoryFilter>) => `${BASE}${directoryQueryString({ ...filter, ...overrides, page: 1 })}`
  const filtered = Boolean(filter.q || filter.role || filter.cohortId || filter.status || filter.orphan)
  const listTitle = filter.orphan
    ? `尚未設定身分的帳號${filter.status ? `（${ACCOUNT_STATUS_LABEL[filter.status]}）` : ''}`
    : filter.status
      ? `${ACCOUNT_STATUS_LABEL[filter.status]}帳號`
      : '帳號列表'
  const page = Math.min(filter.page, totalPages)

  return (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current={BASE}>
      {/* C 階段規格② §3.1：這一頁只剩帳號列表；待審核、已停用、名單匯入各有自己的分頁。 */}
      {/* 標題列只有一顆「新增成員」（A18）；「發臨時密碼」在每一列（A15）。 */}
      <PageTitle title="帳號" actions={<NewMemberDialog cohorts={directory?.cohorts ?? []} />} />
      <div className="mt-4">
        <AdminTabs label="帳號分頁" current={BASE} items={ACCOUNT_TABS} />
      </div>
      <p data-testid="tab-intro" className="-mt-2 mb-4 text-sm text-muted-foreground">
        系上所有帳號都在這裡，可以搜尋、篩選、排序與匯出；系統不存可查看的密碼，只能核發一次性臨時密碼。
      </p>
      <div className="flex flex-col gap-5">
        <Panel
          title={listTitle}
          icon={<IconUsers />}
          description={filtered ? undefined : '搜尋、篩選、排序；勾選或全選篩選結果後匯出 CSV'}
          bodyClassName="p-4"
          aria-label="帳號"
        >
          {directory ? (
            <div className="space-y-3">
              {/* D-6（Q116）：原本的三顆圓環磚改成表格上方一列帶數字的篩選膠囊；「未設定身分」（票 10b）一起留著。 */}
              <nav aria-label="依狀態篩選" className="flex flex-wrap gap-2">
                <StatusPill label="全部" value={summary ? everyone : null} href={hrefWith({ status: null, orphan: false })} active={!filter.status && !filter.orphan} />
                <StatusPill label="待審核" value={summary?.pending ?? null} href={tabHref('pending')} active={false} hot />
                <StatusPill label="已核准" value={summary?.active ?? null} href={statusHref('active')} active={filter.status === 'active' && !filter.orphan} />
                <StatusPill label="已停用" value={summary?.disabled ?? null} href={tabHref('disabled')} active={false} />
                <StatusPill
                  label="未設定身分"
                  value={summary?.orphans ?? null}
                  href={`${BASE}${directoryQueryString({ ...filter, status: null, orphan: !filter.orphan, page: 1 })}`}
                  active={filter.orphan}
                  hot
                />
              </nav>
              <AccountsTable
                rows={directory.rows}
                // 重設頭像對話框要顯示的目前頭像（UserAvatar 是 Server Component，在這裡先畫好再傳進 client 表格）。
                avatars={Object.fromEntries(
                  directory.rows
                    .filter((r) => r.status === 'active' || r.status === 'disabled')
                    .map((r) => [r.userId, <UserAvatar key={r.userId} size={64} user={{ id: r.userId, name: r.name, avatarPreset: r.avatarPreset, avatarFileId: r.avatarFileId }} />]),
                )}
                total={directory.total}
                filter={filter}
                currentUserId={actor.kind === 'authenticated' ? actor.userId : ''}
                statusLabel={ACCOUNT_STATUS_LABEL}
                roleLabel={ROLE_LABEL}
                sortHeaders={sortHeaders(filter)}
                verificationLabels={VERIFICATION_LABELS}
                toolbar={
                  <>
                <SearchForm
                  action={BASE}
                  label="篩選帳號"
                  placeholder="搜尋姓名、學號或 Email"
                  defaultValue={filter.q}
                  maxLength={SEARCH_MAX_LENGTH}
                  hidden={{
                    role: filter.role,
                    cohort: filter.cohortId,
                    status: filter.status,
                    orphan: filter.orphan ? '1' : null,
                    // 換搜尋時保留目前的排序。
                    sort: filter.sort,
                    dir: filter.dir,
                  }}
                />
                <FacetMenu
                  label="狀態"
                  value={filter.status ?? ''}
                  options={[
                    { value: '', label: '全部', href: hrefWith({ status: null }) },
                    ...DIRECTORY_STATUSES.map((s) => ({ value: s, label: ACCOUNT_STATUS_LABEL[s], href: hrefWith({ status: s }) })),
                  ]}
                />
                <FacetMenu
                  label="角色"
                  value={filter.role ?? ''}
                  options={[
                    { value: '', label: '全部', href: hrefWith({ role: null }) },
                    ...DIRECTORY_ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r], href: hrefWith({ role: r }) })),
                  ]}
                />
                <FacetMenu
                  label="屆別"
                  value={filter.cohortId ?? ''}
                  options={[
                    { value: '', label: '全部', href: hrefWith({ cohortId: null }) },
                    ...directory.cohorts.map((c) => ({ value: c.id, label: `${c.name}（${c.code}）`, href: hrefWith({ cohortId: c.id }) })),
                  ]}
                />
                {filtered ? <ClearFilters href={BASE} /> : null}
                  </>
                }
              />
              <Pager
                total={directory.total}
                page={page}
                pages={totalPages}
                prevHref={filter.page > 1 ? `${BASE}${directoryQueryString(filter, { page: Math.min(filter.page - 1, totalPages) })}` : null}
                nextHref={filter.page < totalPages ? `${BASE}${directoryQueryString(filter, { page: filter.page + 1 })}` : null}
              />
            </div>
          ) : (
            <p role="alert" className="text-sm text-destructive">
              帳號列表載入失敗，請重新整理頁面。
            </p>
          )}
        </Panel>

      </div>
    </DashboardShell>
  )
}
