import { IconUserOff } from '@tabler/icons-react'
import { UserAvatar } from '@/app/_ui/avatar/user-avatar'
import { ClearFilters, Pager, SearchForm } from '@/app/_ui/data-table'
import { FacetMenu } from '@/app/_ui/data-table-facet'
import { requireRole } from '@/app/_ui/guard'
import { PageTitle, Panel } from '@/app/_ui/dashboard/primitives'
import { DashboardShell } from '@/app/_ui/site-shell'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { AdminTabs } from '@/app/dashboard/admin/_tabs'
import { ACCOUNT_TABS } from '@/app/dashboard/admin/_tabs.consts'
import type { DirectoryFilter, DirectorySort } from '@/application/accounts'
import {
  ACCOUNT_STATUS_LABEL,
  BULK_MAX_CHARS,
  DIRECTORY_ROLES,
  DIRECTORY_SORTS,
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
import { AccountsTable, type SortHeader } from '../accounts-table'
import { BulkDisableDialog } from '../bulk-disable-dialog'
import type { VerificationLabels } from '../temporary-password-dialog'

// 已停用的人沒有「發臨時密碼」，表格仍要這份型別；跟全部帳號頁同一份文字。
const VERIFICATION_LABELS: VerificationLabels = {
  methods: VERIFICATION_METHODS,
  methodLabel: VERIFICATION_LABEL,
  noteRequired: VERIFICATION_NOTE_REQUIRED,
  noteHint: VERIFICATION_NOTE_HINT,
  teacherMethodLabel: { ...VERIFICATION_LABEL, id_document: '當面核對身分證件（教職員證、身分證）' },
  teacherNoteHint: { ...VERIFICATION_NOTE_HINT, id_document: '選填，例如「10/9 系辦核對教職員證」' },
}

export const metadata = { title: '已停用｜資管系專題平台' }

const BASE = '/dashboard/admin/accounts/disabled'

/**
 * 帳號的「已停用」分頁（C 階段規格② §3.5）：帳號表格固定只列停用的人（每列「恢復」、更多裡「刪除個人資料」），
 * 「批次停用」從原本的危險操作區搬到標題列（C2-07）。搜尋、角色、屆別、排序、匯出跟全部帳號一樣在網址上。
 * 說明句是這條路由的 e2e 指紋（`e2e/fingerprints.ts`），改句子要一起改。
 */
export default async function AccountsDisabledPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  const actor = await requireRole(BASE, 'admin')

  // 狀態固定是已停用：網址上的 status 不算數；連結一律不帶 status（這一頁本身就是那個篩選）。
  const filter: DirectoryFilter = { ...normalizeDirectoryFilter(await searchParams), status: 'disabled' }
  const qs = (overrides: Partial<DirectoryFilter>) => `${BASE}${directoryQueryString({ ...filter, status: null }, overrides)}`
  const hrefWith = (overrides: Partial<DirectoryFilter>) => qs({ ...overrides, page: 1 })

  // 用例自己再判一次授權（頁面通過不代表用例會放行）。
  const directoryResult = await getAccountDirectoryCommand().list(actor, filter)
  const directory = directoryResult.ok ? directoryResult.receipt : null
  const totalPages = directory ? Math.max(1, Math.ceil(directory.total / directory.pageSize)) : 1
  const page = Math.min(filter.page, totalPages)
  const filtered = Boolean(filter.q || filter.role || filter.cohortId || filter.orphan)
  const sortHeaders = Object.fromEntries(
    DIRECTORY_SORTS.map((sort) => {
      const active = filter.sort === sort ? filter.dir : null
      const dir = active ? (active === 'asc' ? 'desc' : 'asc') : sort === 'createdAt' ? 'desc' : 'asc'
      return [sort, { href: qs({ sort, dir, page: 1 }), active }] as const
    }),
  ) as Record<DirectorySort, SortHeader>

  return (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current={BASE}>
      <PageTitle title="帳號" />
      <div className="mt-4">
        <AdminTabs label="帳號分頁" current={BASE} items={ACCOUNT_TABS} actions={<BulkDisableDialog maxChars={BULK_MAX_CHARS} />} />
      </div>
      <p data-testid="tab-intro" className="-mt-2 mb-4 text-sm text-muted-foreground">
        已停用、不能登入的帳號，可以在這裡恢復。
      </p>
      <Panel
        title="已停用帳號"
        icon={<IconUserOff />}
        description="停用不是刪除：資料與紀錄都保留、可以逐一恢復。批次停用可以上傳 TXT 或貼上學號，先預覽再確認。"
        bodyClassName="p-4"
        aria-label="帳號"
      >
        {directory ? (
          <div className="space-y-3">
            <AccountsTable
              rows={directory.rows}
              // 重設頭像對話框要顯示的目前頭像（UserAvatar 是 Server Component，在這裡先畫好再傳進 client 表格）。
              avatars={Object.fromEntries(
                directory.rows.map((r) => [
                  r.userId,
                  <UserAvatar key={r.userId} size={64} user={{ id: r.userId, name: r.name, avatarPreset: r.avatarPreset, avatarFileId: r.avatarFileId }} />,
                ]),
              )}
              total={directory.total}
              filter={filter}
              currentUserId={actor.kind === 'authenticated' ? actor.userId : ''}
              statusLabel={ACCOUNT_STATUS_LABEL}
              roleLabel={ROLE_LABEL}
              sortHeaders={sortHeaders}
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
                      orphan: filter.orphan ? '1' : null,
                      // 換搜尋時保留目前的排序。
                      sort: filter.sort,
                      dir: filter.dir,
                    }}
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
              prevHref={filter.page > 1 ? qs({ page: Math.min(filter.page - 1, totalPages) }) : null}
              nextHref={filter.page < totalPages ? qs({ page: filter.page + 1 }) : null}
            />
          </div>
        ) : (
          <p role="alert" className="text-sm text-destructive">
            帳號列表載入失敗，請重新整理頁面。
          </p>
        )}
      </Panel>
    </DashboardShell>
  )
}
