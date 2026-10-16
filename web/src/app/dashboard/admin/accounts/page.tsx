import Link from 'next/link'
import { IconAlertTriangle, IconChevronRight, IconFileSpreadsheet, IconUserCheck, IconUsers } from '@tabler/icons-react'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { ClearFilters, Pager, SearchForm } from '@/app/_ui/data-table'
import { FacetMenu } from '@/app/_ui/data-table-facet'
import { PageTitle, Panel, PanelEmpty } from '@/app/_ui/dashboard/primitives'
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
import { cn } from '@/shared/cn'
import { formatTaipeiMinute } from '@/shared/time'
import { AccountsTable, type SortHeader } from './accounts-table'
import { BulkDisableDialog } from './bulk-disable-dialog'
import { BulkApproveCheckbox, BulkApproveDialog, BulkApproveProvider, BulkApproveSelectAll } from './bulk-approve-dialog'
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
  // 新增老師、替老師或職員發臨時密碼時不提學生證（T6 系5）。只換顯示文字，存進紀錄的核實方式代碼不變。
  teacherMethodLabel: { ...VERIFICATION_LABEL, id_document: '當面核對身分證件（教職員證、身分證）' },
  teacherNoteHint: { ...VERIFICATION_NOTE_HINT, id_document: '選填，例如「10/9 系辦核對教職員證」' },
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

  // 用例自己再判一次授權（頁面通過不代表用例會放行）。
  const listed = await getRosterCommand().listVersions(actor)
  const versions = listed.ok ? listed.receipt.versions : []
  const pendingResult = await getRegistrationCommand().listPending(actor)
  const pending = pendingResult.ok ? pendingResult.receipt : null
  const applications = pending?.applications ?? []
  // 名單比對不到或資料不符的人不能批次核准（伺服器會略過），勾到時按鈕旁提醒要逐一核對（Q93）。
  const offRosterIds = applications.filter((a) => a.match.status !== 'matched').map((a) => a.applicationId)
  const filter = normalizeDirectoryFilter(await searchParams)
  const accounts = getAccountDirectoryCommand()
  const directoryResult = await accounts.list(actor, filter)
  const directory = directoryResult.ok ? directoryResult.receipt : null
  const summaryResult = await accounts.summary(actor)
  const summary = summaryResult.ok ? summaryResult.receipt : null
  const totalPages = directory ? Math.max(1, Math.ceil(directory.total / directory.pageSize)) : 1
  const statusHref = (status: DirectoryFilter['status']) =>
    `${BASE}${directoryQueryString({ ...filter, status: filter.status === status ? null : status, orphan: false, page: 1 })}`
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
      {/* AD-11（設計方案 §3.5）：審核在前 → 帳號列表（篩選膠囊帶數字）→ 收合的「名單與停用」。 */}
      <div className="flex flex-col gap-5">
        <PageTitle
          title="帳號"
          description="系統不存可查看的密碼，只能核發一次性臨時密碼。"
          actions={
            <>
              {/* 票 8：新增老師與發臨時密碼（用 Email 找人）。每一列的「發臨時密碼」在下方帳號表格裡。 */}
              <TemporaryPasswordDialog labels={VERIFICATION_LABELS} />
              <NewTeacherDialog labels={VERIFICATION_LABELS} />
            </>
          }
        />

        {/* 第三波 W6：勾選後「核准勾選的 N 位」一起核准；需要人判斷的列由伺服器自動略過並寫原因。 */}
        <BulkApproveProvider pendingIds={applications.map((a) => a.applicationId)}>
        <Panel
          title={pending ? `待審核 ${applications.length} 位` : '待審核'}
          icon={<IconUserCheck />}
          description="名單比對只協助判斷，不會自動核准；核准前請以校方既有方式核對本人"
          action={
            applications.length > 0 ? (
              <div className="flex flex-wrap items-center gap-3">
                <label className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                  <BulkApproveSelectAll applicationIds={applications.map((a) => a.applicationId)} />
                  全選
                </label>
                <BulkApproveDialog labels={REVIEW_LABELS} offRosterIds={offRosterIds} />
              </div>
            ) : null
          }
          aria-label="待審核"
        >
          {pending && !pending.registrationOpenCohort ? (
            <p className="mx-5 mb-3 rounded-lg bg-brand-subtle px-3 py-2 text-sm text-brand-on-subtle" role="note">
              目前沒有設定新註冊學生加入的屆別：不在本屆名單上的人核准時要手動選屆別。可以到「屆別」頁設定。
            </p>
          ) : null}
          {applications.length === 0 ? (
            <PanelEmpty title="目前沒有待審核的註冊。" hint="學生改過資料時，要重新打開核對才能核准。" />
          ) : (
            // 每人一張卡。外層仍是 table／row：卡片是一列一列的同款資料，讀屏照表格念，既有 e2e 也照列找人。
            <table aria-label="待審核清單" className="block px-5 pb-5">
              <thead className="sr-only">
                <tr>
                  {['勾選', '姓名與 Email', '學號與系級', '比對結果', '送出時間', '操作'].map((h) => (
                    <th key={h} scope="col">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
                {applications.map((a) => (
                  <tr
                    key={a.applicationId}
                    className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1.5 rounded-lg border border-border bg-background p-3.5"
                  >
                    <td className="row-span-4 pt-0.5">
                      <BulkApproveCheckbox applicationId={a.applicationId} name={a.appliedName} />
                    </td>
                    <td className="min-w-0">
                      <span className="block truncate font-semibold text-foreground">{a.appliedName}</span>
                      <span className="block truncate text-xs text-muted-foreground" title={a.loginEmail}>
                        {a.loginEmail}
                      </span>
                    </td>
                    <td className="row-span-4 self-center">
                      <ReviewDialog
                        key={`r-${a.applicationId}-${a.revision}`}
                        application={a}
                        cohorts={pending!.cohorts}
                        registrationOpenCohort={pending!.registrationOpenCohort}
                        labels={REVIEW_LABELS}
                      />
                    </td>
                    <td className="text-sm">
                      <span className="tabular">{a.studentNo}</span>
                      <span className="text-muted-foreground">・{a.departmentClass || '—'}</span>
                    </td>
                    <td>
                      <EvidencePills flags={a.flags} labels={REVIEW_LABELS} />
                    </td>
                    <td className="tabular text-xs text-muted-foreground">
                      {formatTaipeiMinute(new Date(a.updatedAt))} 送出
                      {a.revision > 1 ? <span className="ml-1">（第 {a.revision} 版）</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
        </BulkApproveProvider>

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
                <StatusPill label="待審核" value={summary?.pending ?? null} href={statusHref('pending')} active={filter.status === 'pending' && !filter.orphan} hot />
                <StatusPill label="已核准" value={summary?.active ?? null} href={statusHref('active')} active={filter.status === 'active' && !filter.orphan} />
                <StatusPill label="已停用" value={summary?.disabled ?? null} href={statusHref('disabled')} active={filter.status === 'disabled' && !filter.orphan} />
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

        {/* 少用的整批動作收進預設收合的一區（不是另一頁）；`<details>` 收合不需要 JS。 */}
        <details className="dash-card group/roster overflow-hidden">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-3.5 text-[15px] font-bold text-foreground [&::-webkit-details-marker]:hidden">
            <IconChevronRight aria-hidden className="size-4 text-muted-foreground transition-transform group-open/roster:rotate-90" />
            名單與停用
          </summary>
          <div className="flex flex-col gap-5 border-t border-border/70 px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">
                上傳本屆名單 CSV。每次匯入都另存一份，舊的不會被蓋掉；名單只協助審核比對，不會自動核准任何人。
              </p>
              <ImportRosterDialog />
            </div>

            <section aria-label="歷次匯入">
              <h3 className="mb-2 flex items-center gap-2 text-sm font-bold text-foreground">
                <IconFileSpreadsheet aria-hidden className="size-4 text-muted-foreground" />
                歷次匯入
              </h3>
              {versions.length === 0 ? (
                <p className="text-sm text-muted-foreground">還沒有匯入過名單。</p>
              ) : (
                <ul className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
                  {versions.map((v) => (
                    <li key={v.id}>
                      <article
                        aria-label={`${v.cohortName}（${v.cohortCode}）名單`}
                        className="flex h-full flex-col gap-1 rounded-lg border border-border bg-background p-3.5 text-sm"
                      >
                        <span className="font-semibold text-foreground">
                          {v.cohortName}（{v.cohortCode}）
                        </span>
                        <span className="tabular text-xs text-muted-foreground">
                          {formatTaipeiMinute(new Date(v.importedAt))}・{v.importedBy}
                        </span>
                        <span className="tabular">
                          有效 <span className="font-semibold">{v.counts.valid}</span> 筆
                          <span className="text-muted-foreground">
                            ・重複 {v.counts.duplicate}・缺欄 {v.counts.missing}・衝突 {v.counts.conflict}
                          </span>
                        </span>
                        {v.fileId ? (
                          // 下載每次都經 /api/files/[id] 重新授權；別人拿到這個網址也打不開。
                          <a
                            href={`/api/files/${v.fileId}`}
                            title={v.fileName ?? undefined}
                            aria-label={`下載原檔${v.fileName ? ` ${v.fileName}` : ''}`}
                            className="mt-auto truncate pt-1 font-semibold text-primary underline-offset-4 hover:underline"
                            download
                          >
                            下載原檔{v.fileName ? `・${v.fileName}` : ''}
                          </a>
                        ) : null}
                      </article>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* 第三波 §9 規則 1（驗收 P-06）：批次停用一次影響很多人，跟例行的匯出拉開，放在最後的危險操作區。 */}
            <section aria-label="危險操作" className="rounded-lg border border-destructive/30 p-4">
              <h3 className="mb-2 flex items-center gap-2 text-sm font-bold text-destructive-on-subtle">
                <IconAlertTriangle aria-hidden className="size-4" />
                危險操作
              </h3>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-muted-foreground">
                  上傳 TXT 或貼上學號（一行一個），先預覽再寫理由確認。停用不是刪除：資料與紀錄都保留、之後可以逐一恢復；停用的人在任何分頁做下一個動作就會被登出。
                </p>
                <BulkDisableDialog maxChars={BULK_MAX_CHARS} />
              </div>
            </section>
          </div>
        </details>
      </div>
    </DashboardShell>
  )
}
