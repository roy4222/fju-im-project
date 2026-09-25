import Link from 'next/link'
import { IconFileSpreadsheet, IconUserCheck, IconUsers } from '@tabler/icons-react'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { Ring } from '@/app/_ui/dashboard/charts'
import { ClearFilters, Pager, SearchForm } from '@/app/_ui/data-table'
import { FacetMenu } from '@/app/_ui/data-table-facet'
import { FilterTag, PageTitle, Panel, PANEL_TABLE_HEAD, PANEL_TABLE_ROW, PanelEmpty } from '@/app/_ui/dashboard/primitives'
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

/** 原型的「環形磚」：左邊一個完成率圓環，右邊標籤、大數字／總數、一行說明；整塊是篩選連結。 */
function RingTile({
  label,
  value,
  total,
  hint,
  href,
  active,
  hot = false,
  barClassName,
}: {
  label: string
  value: number | null
  total: number
  hint: string
  href: string
  active: boolean
  hot?: boolean
  barClassName: string
}) {
  const pct = value !== null && total > 0 ? (value / total) * 100 : 0
  return (
    <Link
      href={href}
      aria-current={active ? 'true' : undefined}
      className={cn('dash-card dash-card-hover flex items-center gap-4 px-5 py-4', active && 'border-brand ring-1 ring-brand')}
    >
      <Ring value={pct} size={64} stroke={8} barClassName={barClassName} decorative>
        <span className="tabular text-xs font-extrabold">{Math.round(pct)}%</span>
      </Ring>
      <span className="min-w-0">
        <span className="block text-[12px] font-semibold text-muted-foreground">{label}</span>
        <span className={cn('tabular block text-[28px] leading-none font-extrabold', hot && 'text-brand')}>
          {value ?? '—'}
          <span className="ml-1 text-[12px] font-medium text-muted-foreground">／{total}</span>
        </span>
        <span className="mt-1 block truncate text-[12px] text-muted-foreground">{hint}</span>
      </span>
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
    ? `孤兒帳號${filter.status ? `（${ACCOUNT_STATUS_LABEL[filter.status]}）` : ''}`
    : filter.status
      ? `${ACCOUNT_STATUS_LABEL[filter.status]}帳號`
      : '全部帳號'
  const page = Math.min(filter.page, totalPages)

  return (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current={BASE}>
      {/* 外觀照原型 `/dashboard/admin/accounts`（票 36）：標題＋主要動作、環形磚、待審核、全部帳號 Data Table。 */}
      <div className="flex flex-col gap-5">
        <PageTitle
          title="帳號管理"
          description={`${everyone} 筆。名單匯入、註冊審核、停用、匯出與臨時密碼都在這一區；系統不存可查看的密碼，只能核發一次性臨時密碼。`}
          actions={
            <>
              {/* 票 8：新增老師與發臨時密碼（用 Email 找人）。每一列的「發臨時密碼」在下方帳號表格裡。 */}
              <TemporaryPasswordDialog labels={VERIFICATION_LABELS} />
              <NewTeacherDialog labels={VERIFICATION_LABELS} />
            </>
          }
        />

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <RingTile
            label="待審核"
            value={summary?.pending ?? null}
            total={everyone}
            hint={summary ? `其中 ${summary.pendingApplications} 筆申請等你審核` : ''}
            href={statusHref('pending')}
            active={filter.status === 'pending'}
            hot
            barClassName="stroke-brand"
          />
          <RingTile
            label="已核准"
            value={summary?.active ?? null}
            total={everyone}
            hint={summary ? `學生 ${summary.activeStudents} 人` : ''}
            href={statusHref('active')}
            active={filter.status === 'active'}
            barClassName="stroke-ink"
          />
          <RingTile
            label="已停用"
            value={summary?.disabled ?? null}
            total={everyone}
            hint="停用不是刪除，可以恢復"
            href={statusHref('disabled')}
            active={filter.status === 'disabled'}
            barClassName="stroke-border"
          />
          {/* 票 10b：只有登入身分、我方什麼都沒有的帳號（建帳號時系統出錯留下的，或註冊了還沒送申請的）。 */}
          <RingTile
            label="孤兒帳號"
            value={summary?.orphans ?? null}
            total={everyone}
            hint="沒有角色與申請，要補建角色或停用"
            href={`${BASE}${directoryQueryString({ ...filter, status: null, orphan: !filter.orphan, page: 1 })}`}
            active={filter.orphan}
            barClassName="stroke-destructive"
          />
        </div>

        <Panel
          title={`待審核${pending ? `（${pending.applications.length}）` : ''}`}
          icon={<IconUserCheck />}
          description="名單比對只協助判斷，不會自動核准；核准前請以校方既有方式核對本人"
          aria-label="待審核"
        >
          {pending && !pending.registrationOpenCohort ? (
            <p className="mx-5 mb-3 rounded-lg bg-brand-subtle px-3 py-2 text-sm text-brand-on-subtle" role="note">
              目前沒有設定開放註冊屆別：沒命中名單的人核准時要手動選屆別。可以到「屆別」頁設定。
            </p>
          ) : null}
          {(pending?.applications ?? []).length === 0 ? (
            <PanelEmpty title="目前沒有待審核的註冊。" hint="學生改過資料時，要重新打開核對才能核准。" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[44rem] text-sm">
                <thead>
                  <tr className={PANEL_TABLE_HEAD}>
                    {['姓名', '學號', '系級', '比對結果', '最後更新'].map((h) => (
                      <th key={h} scope="col" className="px-4 py-2.5 font-semibold first:pl-5">
                        {h}
                      </th>
                    ))}
                    <th scope="col" className="px-5 py-2.5 font-semibold">
                      操作
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {pending!.applications.map((a) => (
                    <tr key={a.applicationId} className={PANEL_TABLE_ROW}>
                      <td className="px-4 py-2.5 pl-5 font-semibold whitespace-nowrap text-foreground">{a.appliedName}</td>
                      <td className="tabular px-4 py-2.5">{a.studentNo}</td>
                      <td className="px-4 py-2.5 whitespace-nowrap">{a.departmentClass || '—'}</td>
                      <td className="px-4 py-2.5">
                        <EvidencePills flags={a.flags} labels={REVIEW_LABELS} />
                      </td>
                      <td className="tabular px-4 py-2.5 whitespace-nowrap text-muted-foreground">
                        {formatTaipeiMinute(new Date(a.updatedAt))}
                        {a.revision > 1 ? <span className="ml-1 text-xs">（第 {a.revision} 版）</span> : null}
                      </td>
                      <td className="px-5 py-2.5">
                        <ReviewDialog
                          key={`r-${a.applicationId}-${a.revision}`}
                          application={a}
                          cohorts={pending!.cohorts}
                          registrationOpenCohort={pending!.registrationOpenCohort}
                          labels={REVIEW_LABELS}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel
          title={listTitle}
          icon={<IconUsers />}
          description={filtered ? undefined : '搜尋、篩選、排序；勾選或全選篩選結果後匯出 CSV'}
          action={<ImportRosterDialog />}
          bodyClassName="p-4"
          aria-label="帳號"
        >
          {directory ? (
            <div className="space-y-3">
              {filter.status || filter.orphan ? (
                <FilterTag
                  label={filter.orphan ? '孤兒帳號' : ACCOUNT_STATUS_LABEL[filter.status!]}
                  count={`${directory.total}／${everyone} 筆`}
                  clearHref={hrefWith({ status: null, orphan: false })}
                />
              ) : null}
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

        <Panel
          title="名單版本"
          icon={<IconFileSpreadsheet />}
          description="每次匯入都是一個新版本；名單只協助審核比對，不會自動核准任何人"
          aria-label="名單"
        >
          {versions.length === 0 ? (
            <PanelEmpty title="還沒有匯入過名單。" hint="按「全部帳號」右上的「匯入名單 CSV」上傳本屆名單。" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] text-sm">
                <thead>
                  <tr className={PANEL_TABLE_HEAD}>
                    {['屆別', '匯入者', '匯入時間', '有效', '重複／缺欄／衝突', '原檔'].map((h) => (
                      <th key={h} scope="col" className="px-4 py-2.5 font-semibold first:pl-5 last:pr-5">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {versions.map((v) => (
                    <tr key={v.id} className={PANEL_TABLE_ROW}>
                      <td className="px-4 py-2.5 pl-5">
                        {v.cohortName}（{v.cohortCode}）
                      </td>
                      <td className="px-4 py-2.5">{v.importedBy}</td>
                      <td className="tabular px-4 py-2.5 text-muted-foreground">{formatTaipeiMinute(new Date(v.importedAt))}</td>
                      <td className="tabular px-4 py-2.5 font-semibold">{v.counts.valid}</td>
                      <td className="tabular px-4 py-2.5 whitespace-nowrap">
                        {v.counts.duplicate}／{v.counts.missing}／{v.counts.conflict}
                      </td>
                      <td className="px-4 py-2.5 pr-5">
                        {v.fileId ? (
                          // 下載每次都經 /api/files/[id] 重新授權；別人拿到這個網址也打不開。
                          <a
                            href={`/api/files/${v.fileId}`}
                            title={v.fileName ?? undefined}
                            aria-label={`下載原檔${v.fileName ? ` ${v.fileName}` : ''}`}
                            className="font-semibold whitespace-nowrap text-primary underline-offset-4 hover:underline"
                            download
                          >
                            下載
                          </a>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <p className="text-xs text-muted-foreground">
          停用不是刪除：資料與紀錄都保留、可以恢復；停用的人在任何分頁做下一個動作就會被登出。
        </p>
      </div>
    </DashboardShell>
  )
}
