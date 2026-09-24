import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { DataTable, EmptyState, PageHeader } from '@/app/_ui/primitives'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { GroupingSettingsEditor, VoidProposalButton } from '@/app/dashboard/admin/groups/admin-group-forms'
import { AdvisorCell, BatchAssignDialog } from '@/app/dashboard/admin/groups/advisor-forms'
import { GroupDetailButton, UngroupedStudents, type GroupDetailHistory } from '@/app/dashboard/admin/groups/member-forms'
import { GroupRosterTable, type RosterColumn } from '@/app/dashboard/admin/groups/roster-table'
import { GroupTypeCell } from '@/app/dashboard/admin/groups/type-forms'
import {
  COHORT_STATUS_LABEL,
  describeGroupSize,
  getBusinessClock,
  getCohortStatusQuery,
  GROUP_SIZE_LIMIT,
  PROPOSAL_DAYS_LIMIT,
} from '@/composition/cohorts'
import type { GroupHistoryEntry, RosterFilter, RosterSort } from '@/application/groups'
import {
  ADVISOR_BATCH_KIND_LABEL,
  applyRosterFilter,
  ADVISOR_BATCH_OUTCOME_LABEL,
  ADVISOR_CSV_MAX_BYTES,
  CHANGE_REASON_MAX_LENGTH,
  describeGroupHistory,
  getAdvisorGradingLookup,
  getGroupQuery,
  GROUP_TYPE_LABEL,
  groupSizeWarning,
  INVITATION_STATE_LABEL,
  normalizeRosterFilter,
  ROSTER_SEARCH_MAX_LENGTH,
  ROSTER_STATUS_FILTER_LABEL,
  ROSTER_STATUS_FILTERS,
  ROSTER_TYPE_FILTER_LABEL,
  ROSTER_TYPE_FILTERS,
  rosterQueryString,
  TERMINATION_KIND_LABEL,
  VOID_REASON_MAX_LENGTH,
} from '@/composition/groups'
import { cn } from '@/shared/cn'
import { formatTaipeiMinute } from '@/shared/time'

export const metadata = { title: '分組總覽｜資管系專題平台' }

/**
 * 管理員「分組總覽」（票 13；原型 `/dashboard/admin/groups`）。
 *
 * 一頁看完一屆的分組：分組設定（每組人數、提案預設天數）、進行中的提案（可作廢，理由必填）、
 * 已成立的組別與組長、還沒分組的學生（誰公開找組員、誰正被提案占住）、最近終止的提案。
 * 票 14：未分組學生「加入某組」；組別「詳情」裡移出組員（組長要指定接任）、換組長、看異動歷程。
 * 人數和設定不符時標示「與設定不符」但允許（2026-09-24 定案：管理員調整就是特殊情況的處理方式）。
 * 票 19：每組的指導老師（指派、重派、解除，理由必填），以及批次指派 CSV（六類預覽後逐列執行）。
 * 票 20：組別名單依類型、狀態、老師篩選與搜尋，表頭排序（都在網址上、伺服器算）；每組的組員登入信箱與
 * 「複製本組信箱」；勾選或整份篩選結果匯出 CSV／XLSX（帶信箱）；系辦改組別類型（保留既有關聯）。
 */

function historyItem(h: GroupHistoryEntry, index: number): GroupDetailHistory {
  return { key: `${index}`, atLabel: formatTaipeiMinute(h.at), text: describeGroupHistory(h), reason: h.reason }
}
/** 表頭排序連結：點同一欄切換升降冪，換欄從升冪開始。篩選條件與屆別跟著帶。 */
function rosterColumns(cohortId: string, filter: RosterFilter): RosterColumn[] {
  const sortable = (label: string, sort: RosterSort): RosterColumn => {
    const active = filter.sort === sort ? filter.dir : null
    const dir = active === 'asc' ? 'desc' : 'asc'
    const query = rosterQueryString(filter, { sort, dir })
    return { label, sortHref: `/dashboard/admin/groups?cohort=${cohortId}${query ? `&${query}` : ''}`, active }
  }
  return [
    sortable('組別', 'code'),
    sortable('類型', 'type'),
    { label: '組員' },
    sortable('人數', 'members'),
    sortable('指導老師', 'advisor'),
    sortable('成立時間', 'established'),
    { label: '' },
  ]
}

/** 篩選列：GET 表單（網址可以分享、重新整理不會丟），伺服器照網址算。 */
function RosterFilterForm({
  cohortId,
  filter,
  teachers,
}: {
  cohortId: string
  filter: RosterFilter
  teachers: readonly { userId: string; name: string }[]
}) {
  const select = 'h-9 rounded-md border border-border bg-background px-2 text-sm'
  return (
    <form action="/dashboard/admin/groups" role="search" aria-label="篩選組別" className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="cohort" value={cohortId} />
      {filter.sort !== 'code' ? <input type="hidden" name="sort" value={filter.sort} /> : null}
      {filter.dir !== 'asc' ? <input type="hidden" name="dir" value={filter.dir} /> : null}
      <label className="text-xs text-muted-foreground">
        類型
        <select name="type" defaultValue={filter.type} className={cn(select, 'block')}>
          {ROSTER_TYPE_FILTERS.map((t) => (
            <option key={t} value={t}>
              {ROSTER_TYPE_FILTER_LABEL[t]}
            </option>
          ))}
        </select>
      </label>
      <label className="text-xs text-muted-foreground">
        狀態
        <select name="status" defaultValue={filter.status} className={cn(select, 'block')}>
          {ROSTER_STATUS_FILTERS.map((t) => (
            <option key={t} value={t}>
              {ROSTER_STATUS_FILTER_LABEL[t]}
            </option>
          ))}
        </select>
      </label>
      <label className="text-xs text-muted-foreground">
        指導老師
        <select name="advisor" defaultValue={filter.advisor} className={cn(select, 'block')}>
          <option value="all">全部老師</option>
          <option value="none">尚未指派</option>
          {teachers.map((t) => (
            <option key={t.userId} value={t.userId}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      <label className="text-xs text-muted-foreground">
        搜尋
        <input
          name="q"
          defaultValue={filter.q}
          maxLength={ROSTER_SEARCH_MAX_LENGTH}
          placeholder="組別、姓名、學號、信箱"
          className="block h-9 w-52 rounded-md border border-border bg-background px-3 text-sm"
        />
      </label>
      <button type="submit" className="h-9 rounded-md bg-muted px-3 text-sm font-medium text-ink hover:bg-border">
        套用
      </button>
      <Link href={`/dashboard/admin/groups?cohort=${cohortId}`} className="h-9 px-2 text-sm leading-9 text-primary hover:underline">
        清除
      </Link>
    </form>
  )
}

export default async function AdminGroupsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  await requireRole('/dashboard/admin/groups', 'admin')

  const cohorts = (await getCohortStatusQuery().list()).filter((c) => c.status !== 'archived')
  const params = await searchParams
  const wanted = params.cohort
  const filter: RosterFilter = normalizeRosterFilter(params)
  const cohort =
    cohorts.find((c) => c.id === wanted) ?? cohorts.find((c) => c.isDefaultWorking) ?? cohorts[0] ?? null

  const shell = (children: React.ReactNode) => (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current="/dashboard/admin/groups">
      <PageHeader title="分組總覽" description="學生自行提案、全員確認後成組；這裡看進度、設定每組人數、處理卡住的提案。" />
      {children}
    </DashboardShell>
  )

  if (!cohort) {
    return shell(
      <EmptyState
        title="還沒有屆別"
        description="先到屆別頁新增一屆，學生才能在那一屆分組。"
        action={{ href: '/dashboard/admin/cohorts', label: '前往屆別' }}
      />,
    )
  }

  const [overview, businessNow, teachers] = await Promise.all([
    getGroupQuery().overview(cohort.id),
    getBusinessClock().now(),
    getGroupQuery().teacherOptions(),
  ])
  const grading = getAdvisorGradingLookup()
  const gradingOf = new Map(
    await Promise.all(
      overview.groups
        .filter((g) => g.advisor)
        .map(async (g) => [g.id, [...(await grading.assignmentsFor(g.id, g.advisor!.teacherUserId))]] as const),
    ),
  )
  const roster = applyRosterFilter(overview.groups, filter)
  const unassigned = overview.groups.filter((g) => !g.advisor).length
  const grouped = overview.groups.reduce((sum, g) => sum + g.members.length, 0)
  const size = { min: cohort.groupSizeMin, max: cohort.groupSizeMax }

  return shell(
    <>
      {cohorts.length > 1 ? (
        <nav aria-label="選擇屆別" className="mb-4 flex flex-wrap gap-2">
          {cohorts.map((c) => (
            <Link
              key={c.id}
              href={`/dashboard/admin/groups?cohort=${c.id}`}
              aria-current={c.id === cohort.id ? 'page' : undefined}
              className={cn(
                'rounded-full border px-3 py-1 text-sm',
                c.id === cohort.id ? 'border-primary bg-primary-subtle text-primary-on-subtle' : 'border-border text-ink hover:bg-muted',
              )}
            >
              {c.code}
            </Link>
          ))}
        </nav>
      ) : null}

      <section
        aria-label="分組摘要"
        className="mb-6 flex flex-wrap items-center justify-between gap-4 rounded-card border border-border bg-background px-5 py-4"
      >
        <div>
          <p className="text-xs font-semibold text-primary">
            {cohort.code}・{COHORT_STATUS_LABEL[cohort.status]}
          </p>
          <p className="mt-0.5 text-xl font-semibold text-ink tabular-nums">
            {overview.groups.length} 組・{grouped} 人已分組・{overview.ungrouped.length} 人未分組
          </p>
          <p data-testid="grouping-settings" className="mt-0.5 text-sm text-muted-foreground tabular-nums">
            {describeGroupSize(cohort.groupSizeMin, cohort.groupSizeMax)}・提案 {cohort.proposalDefaultDays} 天內要全員確認・
            進行中提案 {overview.openProposals.length} 份
          </p>
          <p data-testid="advisor-summary" className="mt-0.5 text-sm text-muted-foreground tabular-nums">
            指導老師：{overview.groups.length - unassigned} 組已指派・{unassigned} 組尚未指派
          </p>
        </div>
        <GroupingSettingsEditor
          cohortId={cohort.id}
          cohortCode={cohort.code}
          revision={cohort.revision}
          requestId={randomUUID()}
          values={{
            groupSizeMin: cohort.groupSizeMin,
            groupSizeMax: cohort.groupSizeMax,
            proposalDefaultDays: cohort.proposalDefaultDays,
          }}
          sizeLimit={GROUP_SIZE_LIMIT}
          daysLimit={PROPOSAL_DAYS_LIMIT}
        />
      </section>

      <section aria-label="進行中的提案" className="mb-6 space-y-2">
        <h2 className="text-base font-semibold text-ink">進行中的提案</h2>
        <DataTable
          columns={['提案人', '類型', '成員與確認', '到期時間', '']}
          rows={overview.openProposals.map((p) => {
            const overdue = businessNow.getTime() >= p.expiresBusinessAt.getTime()
            return [
              p.proposerName,
              GROUP_TYPE_LABEL[p.groupType],
              <span key="members" className="text-sm">
                {p.invitations.map((i) => `${i.name}（${INVITATION_STATE_LABEL[i.state]}）`).join('、')}
              </span>,
              <span key="expires" className={cn('tabular-nums', overdue && 'font-semibold text-danger')}>
                {formatTaipeiMinute(p.expiresBusinessAt)}
                {overdue ? '（已過期）' : ''}
              </span>,
              <VoidProposalButton
                key="void"
                proposalId={p.id}
                label={`${p.proposerName}的提案`}
                requestId={randomUUID()}
                reasonMaxLength={VOID_REASON_MAX_LENGTH}
              />,
            ]
          })}
          empty="沒有等待確認的提案。"
        />
      </section>

      <section aria-label="全部組別" className="mb-6 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-ink">全部組別</h2>
          <BatchAssignDialog
            cohortId={cohort.id}
            cohortCode={cohort.code}
            kindLabels={ADVISOR_BATCH_KIND_LABEL}
            outcomeLabels={ADVISOR_BATCH_OUTCOME_LABEL}
            maxBytes={ADVISOR_CSV_MAX_BYTES}
            reasonMaxLength={CHANGE_REASON_MAX_LENGTH}
          />
        </div>
        <RosterFilterForm cohortId={cohort.id} filter={filter} teachers={teachers} />
        <GroupRosterTable
          cohortId={cohort.id}
          total={overview.groups.length}
          filter={{ type: filter.type, status: filter.status, advisor: filter.advisor, q: filter.q, sort: filter.sort, dir: filter.dir }}
          columns={rosterColumns(cohort.id, filter)}
          empty={
            overview.groups.length === 0
              ? '本屆還沒有成立的組別。全員確認後，組別會自動出現在這裡。'
              : '沒有符合篩選條件的組別；換個條件或清除篩選。'
          }
          rows={roster.map((g) => {
            const mismatch = groupSizeWarning(g.members.length, size) !== null
            return {
              id: g.id,
              code: g.code,
              emails: g.members.map((m) => m.loginEmail).filter((e): e is string => typeof e === 'string' && e.length > 0),
              cells: [
                <span key="code" className="font-semibold tabular-nums">
                  {g.code}
                </span>,
                <GroupTypeCell
                  key="type"
                  group={{
                    id: g.id,
                    code: g.code,
                    revision: g.revision,
                    groupType: g.groupType,
                    advisorName: g.advisor?.teacherName ?? null,
                    opportunityName: g.opportunity?.name ?? null,
                  }}
                  typeLabels={GROUP_TYPE_LABEL}
                  requestId={randomUUID()}
                  reasonMaxLength={CHANGE_REASON_MAX_LENGTH}
                />,
                <span key="members">
                  {g.members.map((m) => (m.isLeader ? `${m.name}（組長）` : m.name)).join('、')}
                  {g.opportunity ? (
                    <span className="mt-1 block text-xs text-muted-foreground">
                      合作案：
                      <Link href={`/industry/${g.opportunity.opportunityId}`} className="text-primary hover:underline">
                        {g.opportunity.name}
                      </Link>
                      {g.opportunity.status === 'withdrawn' ? '（已下架）' : ''}
                    </span>
                  ) : null}
                </span>,
                <span key="count" className={cn('tabular-nums', mismatch && 'font-semibold text-danger')}>
                  {g.members.length} 人{mismatch ? '（與設定不符）' : ''}
                </span>,
                <AdvisorCell
                  key="advisor"
                  group={{
                    id: g.id,
                    code: g.code,
                    revision: g.revision,
                    typeLabel: GROUP_TYPE_LABEL[g.groupType],
                    advisor: g.advisor ? { userId: g.advisor.teacherUserId, name: g.advisor.teacherName } : null,
                  }}
                  teachers={teachers}
                  grading={gradingOf.get(g.id) ?? []}
                  requestIds={{ assign: randomUUID(), unassign: randomUUID() }}
                  reasonMaxLength={CHANGE_REASON_MAX_LENGTH}
                />,
                <span key="at" className="tabular-nums">
                  {formatTaipeiMinute(g.establishedBusinessAt)}
                </span>,
                <GroupDetailButton
                  key="detail"
                  group={{
                    id: g.id,
                    code: g.code,
                    revision: g.revision,
                    typeLabel: GROUP_TYPE_LABEL[g.groupType],
                    members: g.members.map((m) => ({ ...m })),
                    history: g.history.map(historyItem),
                  }}
                  size={size}
                  requestIds={{ remove: randomUUID(), leader: randomUUID() }}
                  reasonMaxLength={CHANGE_REASON_MAX_LENGTH}
                />,
              ],
            }
          })}
        />
      </section>

      <section aria-label="未分組學生" className="mb-6 space-y-2">
        <h2 className="text-base font-semibold text-ink">未分組學生</h2>
        <UngroupedStudents
          students={overview.ungrouped.map((u) => ({ ...u }))}
          groups={overview.groups.map((g) => ({ id: g.id, code: g.code, revision: g.revision, memberCount: g.members.length }))}
          size={size}
          requestId={randomUUID()}
          reasonMaxLength={CHANGE_REASON_MAX_LENGTH}
        />
      </section>

      <section aria-label="最近終止的提案" className="space-y-2">
        <h2 className="text-base font-semibold text-ink">最近終止的提案</h2>
        <DataTable
          columns={['時間', '提案人', '原因', '作廢理由']}
          rows={overview.closedProposals.map((p) => [
            <span key="at" className="tabular-nums">
              {p.closedBusinessAt ? formatTaipeiMinute(p.closedBusinessAt) : ''}
            </span>,
            p.proposerName,
            p.terminationKind ? TERMINATION_KIND_LABEL[p.terminationKind] : '',
            p.reason ?? '—',
          ])}
          empty="還沒有終止的提案。"
        />
      </section>
    </>,
  )
}
