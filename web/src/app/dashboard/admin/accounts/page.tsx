import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { Card, DataTable, PageHeader, Tile } from '@/app/_ui/primitives'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import type { DirectoryFilter, DirectorySort } from '@/application/accounts'
import {
  ACCOUNT_STATUS_LABEL,
  BULK_MAX_CHARS,
  DIRECTORY_ROLES,
  DIRECTORY_SORTS,
  DIRECTORY_STATUSES,
  directoryQueryString,
  EVIDENCE_LABEL,
  getAccountDirectoryCommand,
  EVIDENCE_NEEDS_ATTENTION,
  getRegistrationCommand,
  getRosterCommand,
  normalizeDirectoryFilter,
  ROLE_LABEL,
  SEARCH_MAX_LENGTH,
  VERIFICATION_LABEL,
  VERIFICATION_METHODS,
  VERIFICATION_NOTE_HINT,
  VERIFICATION_NOTE_REQUIRED,
} from '@/composition/accounts'
import { formatTaipeiMinute } from '@/shared/time'
import { AccountsTable, type SortHeader } from './accounts-table'
import { ImportRosterDialog } from './import-roster-dialog'
import { EvidencePills, ReviewDialog, type ReviewLabels } from './review-dialog'
import { NewTeacherDialog, TemporaryPasswordDialog, type VerificationLabels } from './teacher-dialogs'

const REVIEW_LABELS: ReviewLabels = {
  evidence: EVIDENCE_LABEL,
  attention: EVIDENCE_NEEDS_ATTENTION,
  methods: VERIFICATION_METHODS,
  methodLabel: VERIFICATION_LABEL,
  noteRequired: VERIFICATION_NOTE_REQUIRED,
  noteHint: VERIFICATION_NOTE_HINT,
}

const VERIFICATION_LABELS: VerificationLabels = {
  methods: VERIFICATION_METHODS,
  methodLabel: VERIFICATION_LABEL,
  noteRequired: VERIFICATION_NOTE_REQUIRED,
  noteHint: VERIFICATION_NOTE_HINT,
}

export const metadata = { title: '帳號管理｜資管系專題平台' }

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

export default async function AdminAccountsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  // 授權檢查在**頁面自己**：放在 layout 擋不住，App Router 會把 layout 與 page 並行渲染，
  // layout 丟掉 children 或 redirect 都來不及——那一頁已經被做出來、跟著 payload 送走了。
  const actor = await requireRole('/dashboard/admin/accounts', 'admin')

  // 用例自己再判一次授權（頁面通過不代表用例會放行）。
  const listed = await getRosterCommand().listVersions(actor)
  const versions = listed.ok ? listed.receipt.versions : []
  const pendingResult = await getRegistrationCommand().listPending(actor)
  const pending = pendingResult.ok ? pendingResult.receipt : null
  const filter = normalizeDirectoryFilter(await searchParams)
  const accounts = getAccountDirectoryCommand()
  const directoryResult = await accounts.list(actor, filter)
  const directory = directoryResult.ok ? directoryResult.receipt : null
  const summaryResult = await accounts.summary(actor)
  const summary = summaryResult.ok ? summaryResult.receipt : null
  const totalPages = directory ? Math.max(1, Math.ceil(directory.total / directory.pageSize)) : 1
  const statusHref = (status: DirectoryFilter['status']) =>
    `${BASE}${directoryQueryString({ ...filter, status: filter.status === status ? null : status, page: 1 })}`

  return (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current="/dashboard/admin/accounts">
      <PageHeader title="帳號" description="名單匯入、註冊審核、停用、匯出與臨時密碼都在這一區。" />
      {/* 票 8：新增老師與發臨時密碼（用 Email 找人）。每一列的「發臨時密碼」在下方帳號表格裡。 */}
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <NewTeacherDialog labels={VERIFICATION_LABELS} />
        <TemporaryPasswordDialog labels={VERIFICATION_LABELS} />
        <span className="text-xs text-muted-foreground">系統不存可查看的密碼，只能核發一次性臨時密碼。</span>
      </div>
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Tile
          label="待審核"
          value={summary?.pending ?? '—'}
          hint={summary ? `其中 ${summary.pendingApplications} 筆申請等你審核` : undefined}
          href={statusHref('pending')}
          active={filter.status === 'pending'}
        />
        <Tile
          label="已核准"
          value={summary?.active ?? '—'}
          hint={summary ? `學生 ${summary.activeStudents} 人` : undefined}
          href={statusHref('active')}
          active={filter.status === 'active'}
        />
        <Tile
          label="已停用"
          value={summary?.disabled ?? '—'}
          hint="停用不是刪除，可以恢復"
          href={statusHref('disabled')}
          active={filter.status === 'disabled'}
        />
      </div>

      <Card
        title={`待審核${pending ? `（${pending.applications.length}）` : ''}`}
        description="名單比對只協助判斷，不會自動核准；核准前請以校方既有方式核對本人。學生改過資料時，要重新打開核對才能核准。"
        className="mb-6"
      >
        {pending && !pending.registrationOpenCohort ? (
          <p className="mb-3 rounded-md bg-primary-subtle px-3 py-2 text-sm text-primary-on-subtle" role="note">
            目前沒有設定開放註冊屆別：沒命中名單的人核准時要手動選屆別。可以到「屆別」頁設定。
          </p>
        ) : null}
        <DataTable
          columns={['姓名', '學號', '系級', '比對結果', '最後更新', '操作']}
          rows={(pending?.applications ?? []).map((a) => [
            <span key="n" className="whitespace-nowrap font-medium text-ink">
              {a.appliedName}
            </span>,
            <span key="s" className="tabular-nums">
              {a.studentNo}
            </span>,
            <span key="d" className="whitespace-nowrap">
              {a.departmentClass || '—'}
            </span>,
            <EvidencePills key="f" flags={a.flags} labels={REVIEW_LABELS} />,
            <span key="t" className="whitespace-nowrap tabular-nums text-muted-foreground">
              {formatTaipeiMinute(new Date(a.updatedAt))}
              {a.revision > 1 ? <span className="ml-1 text-xs">（第 {a.revision} 版）</span> : null}
            </span>,
            <ReviewDialog
              key={`r-${a.applicationId}-${a.revision}`}
              application={a}
              cohorts={pending!.cohorts}
              registrationOpenCohort={pending!.registrationOpenCohort}
              labels={REVIEW_LABELS}
            />,
          ])}
          empty="目前沒有待審核的註冊。"
        />
      </Card>

      <Card
        title="名單"
        description="每次匯入都是一個新版本；名單只協助審核比對，不會自動核准任何人。"
        className="mb-6"
      >
        <div className="mb-4">
          <ImportRosterDialog />
        </div>
        <DataTable
          columns={['屆別', '匯入者', '匯入時間', '有效', '重複／缺欄／衝突', '原檔']}
          rows={versions.map((v) => [
            `${v.cohortName}（${v.cohortCode}）`,
            v.importedBy,
            <span key="t" className="tabular-nums">{formatTaipeiMinute(new Date(v.importedAt))}</span>,
            <span key="n" className="tabular-nums">{v.counts.valid}</span>,
            <span key="s" className="whitespace-nowrap tabular-nums">
              {v.counts.duplicate}／{v.counts.missing}／{v.counts.conflict}
            </span>,
            v.fileId ? (
              // 下載每次都經 /api/files/[id] 重新授權；別人拿到這個網址也打不開。
              <a
                key="d"
                href={`/api/files/${v.fileId}`}
                title={v.fileName ?? undefined}
                aria-label={`下載原檔${v.fileName ? ` ${v.fileName}` : ''}`}
                className="whitespace-nowrap text-primary-on-subtle underline"
                download
              >
                下載
              </a>
            ) : (
              '—'
            ),
          ])}
          empty="還沒有匯入過名單。按「匯入名單 CSV」上傳本屆名單。"
        />
      </Card>

      <Card
        title={filter.status ? `${ACCOUNT_STATUS_LABEL[filter.status]}帳號` : '全部帳號'}
        description="搜尋、篩選、排序；勾選或全選篩選結果後匯出 CSV。停用的人下一個動作就會被登出。"
      >
        <form method="get" action={BASE} className="mb-4 flex flex-wrap items-end gap-3" role="search" aria-label="篩選帳號">
          <label className="flex min-w-0 basis-56 flex-1 flex-col gap-1 text-sm text-ink">
            搜尋
            <input
              type="search"
              name="q"
              defaultValue={filter.q}
              maxLength={SEARCH_MAX_LENGTH}
              placeholder="姓名、學號或 Email"
              className="rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
          </label>
          <label className="flex min-w-0 max-w-full flex-col gap-1 text-sm text-ink">
            角色
            <select name="role" defaultValue={filter.role ?? ''} className="max-w-full rounded-md border border-border bg-background px-3 py-2 text-sm">
              <option value="">全部</option>
              {DIRECTORY_ROLES.map((role) => (
                <option key={role} value={role}>
                  {ROLE_LABEL[role]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-0 max-w-full flex-col gap-1 text-sm text-ink">
            屆別
            <select name="cohort" defaultValue={filter.cohortId ?? ''} className="max-w-full rounded-md border border-border bg-background px-3 py-2 text-sm">
              <option value="">全部</option>
              {(directory?.cohorts ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}（{c.code}）
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-0 max-w-full flex-col gap-1 text-sm text-ink">
            狀態
            <select name="status" defaultValue={filter.status ?? ''} className="max-w-full rounded-md border border-border bg-background px-3 py-2 text-sm">
              <option value="">全部</option>
              {DIRECTORY_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {ACCOUNT_STATUS_LABEL[status]}
                </option>
              ))}
            </select>
          </label>
          {/* 換篩選時保留目前的排序。 */}
          <input type="hidden" name="sort" value={filter.sort} />
          <input type="hidden" name="dir" value={filter.dir} />
          <button type="submit" className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
            套用
          </button>
          {directoryQueryString(filter) ? (
            <a href={BASE} className="px-2 py-2 text-sm text-muted-foreground underline">
              清除篩選
            </a>
          ) : null}
        </form>

        {directory ? (
          <>
            <AccountsTable
              rows={directory.rows}
              total={directory.total}
              filter={filter}
              currentUserId={actor.kind === 'authenticated' ? actor.userId : ''}
              statusLabel={ACCOUNT_STATUS_LABEL}
              roleLabel={ROLE_LABEL}
              sortHeaders={sortHeaders(filter)}
              bulkMaxChars={BULK_MAX_CHARS}
              verificationLabels={VERIFICATION_LABELS}
            />
            <nav className="mt-3 flex items-center justify-between text-sm text-muted-foreground" aria-label="分頁">
              <span>
                共 {directory.total} 筆・第 {Math.min(filter.page, totalPages)}／{totalPages} 頁
              </span>
              <span className="flex gap-3">
                {filter.page > 1 ? (
                  <a className="underline" href={`${BASE}${directoryQueryString(filter, { page: Math.min(filter.page - 1, totalPages) })}`}>
                    上一頁
                  </a>
                ) : null}
                {filter.page < totalPages ? (
                  <a className="underline" href={`${BASE}${directoryQueryString(filter, { page: filter.page + 1 })}`}>
                    下一頁
                  </a>
                ) : null}
              </span>
            </nav>
          </>
        ) : (
          <p role="alert" className="text-sm text-danger-on-subtle">
            帳號列表載入失敗，請重新整理頁面。
          </p>
        )}
      </Card>
    </DashboardShell>
  )
}
