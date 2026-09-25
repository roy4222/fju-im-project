import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import { IconHourglass, IconHistory, IconUsers, IconUsersGroup } from '@tabler/icons-react'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { ClearFilters, DataTableToolbar, SearchForm } from '@/app/_ui/data-table'
import { FacetMenu } from '@/app/_ui/data-table-facet'
import { CohortPills, PageTitle, Panel, PANEL_TABLE_HEAD, PANEL_TABLE_ROW, PanelEmpty, Pill, QuietState } from '@/app/_ui/dashboard/primitives'
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

const BASE = '/dashboard/admin/groups'

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
 *
 * 外觀照原型（票 36）：標題下一行摘要、「未分組學生」、「全部組別」Data Table（搜尋、篩選鈕、排序、勾選），
 * 原型沒有的提案兩塊放在後面。點組別代碼開詳情（原型的側板）。
 */

function historyItem(h: GroupHistoryEntry, index: number): GroupDetailHistory {
  return { key: `${index}`, atLabel: formatTaipeiMinute(h.at), text: describeGroupHistory(h), reason: h.reason }
}

function rosterHref(cohortId: string, filter: RosterFilter, overrides: Partial<RosterFilter> = {}): string {
  const query = rosterQueryString(filter, overrides)
  return `${BASE}?cohort=${cohortId}${query ? `&${query}` : ''}`
}

/** 表頭排序連結：點同一欄切換升降冪，換欄從升冪開始。篩選條件與屆別跟著帶。 */
function rosterColumns(cohortId: string, filter: RosterFilter): RosterColumn[] {
  const sortable = (label: string, sort: RosterSort): RosterColumn => {
    const active = filter.sort === sort ? filter.dir : null
    const dir = active === 'asc' ? 'desc' : 'asc'
    return { label, sortHref: rosterHref(cohortId, filter, { sort, dir }), active }
  }
  return [
    sortable('組別', 'code'),
    sortable('類型', 'type'),
    sortable('指導老師', 'advisor'),
    { label: '組員' },
    sortable('人數', 'members'),
    sortable('成立時間', 'established'),
  ]
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

  const shell = (children: React.ReactNode, title?: { description: React.ReactNode; actions?: React.ReactNode }) => (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current={BASE}>
      <div className="flex flex-col gap-5">
        <PageTitle
          title="分組總覽"
          description={title?.description ?? '學生自行提案、全員確認後成組；這裡看進度、設定每組人數、處理卡住的提案。'}
          actions={title?.actions}
        />
        {children}
      </div>
    </DashboardShell>
  )

  if (!cohort) {
    return shell(
      <QuietState
        title="還沒有屆別"
        hint="先到屆別頁新增一屆，學生才能在那一屆分組。"
        action={
          <Link href="/dashboard/admin/cohorts" className="text-sm font-semibold text-primary hover:underline">
            前往屆別
          </Link>
        }
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
  const industry = overview.groups.filter((g) => g.groupType === 'industry').length
  const grouped = overview.groups.reduce((sum, g) => sum + g.members.length, 0)
  const size = { min: cohort.groupSizeMin, max: cohort.groupSizeMax }
  const openToJoin = overview.ungrouped.filter((u) => u.openToJoin).length
  const filtered = filter.type !== 'all' || filter.status !== 'all' || filter.advisor !== 'all' || filter.q !== ''

  const description = (
    <>
      <span className="tabular">
        {cohort.code}・{COHORT_STATUS_LABEL[cohort.status]}・{overview.groups.length} 組、{grouped} 人已分組、{overview.ungrouped.length} 人未分組・產學{' '}
        {industry} 組
      </span>
      <br className="sm:hidden" />
      <span className="sm:before:content-['・']" data-testid="advisor-summary">
        指導老師：{overview.groups.length - unassigned} 組已指派・{unassigned} 組尚未指派
      </span>
      <span className="block" data-testid="grouping-settings">
        {describeGroupSize(cohort.groupSizeMin, cohort.groupSizeMax)}・提案 {cohort.proposalDefaultDays} 天內要全員確認・進行中提案{' '}
        {overview.openProposals.length} 份。學生自行提案、全員確認後成組；分類只影響流程與標示，不限制老師看見哪些組別。
      </span>
    </>
  )

  return shell(
    <>
      <CohortPills cohorts={cohorts} currentId={cohort.id} hrefFor={(id) => `${BASE}?cohort=${id}`} />

      <Panel
        title="未分組學生"
        icon={<IconUsers />}
        description={`${overview.ungrouped.length} 人・${openToJoin} 人公開找組員`}
        aria-label="未分組學生"
      >
        <UngroupedStudents
          students={overview.ungrouped.map((u) => ({ ...u }))}
          groups={overview.groups.map((g) => ({ id: g.id, code: g.code, revision: g.revision, memberCount: g.members.length }))}
          size={size}
          requestId={randomUUID()}
          reasonMaxLength={CHANGE_REASON_MAX_LENGTH}
        />
      </Panel>

      <Panel
        title="全部組別"
        icon={<IconUsersGroup />}
        description="點組別看成員、組長與異動；可搜尋、篩選、排序"
        aria-label="全部組別"
        bodyClassName="p-4"
        action={
          <BatchAssignDialog
            cohortId={cohort.id}
            cohortCode={cohort.code}
            kindLabels={ADVISOR_BATCH_KIND_LABEL}
            outcomeLabels={ADVISOR_BATCH_OUTCOME_LABEL}
            maxBytes={ADVISOR_CSV_MAX_BYTES}
            reasonMaxLength={CHANGE_REASON_MAX_LENGTH}
          />
        }
      >
        <div className="space-y-3">
          {/* 原型 Data Table 的工具列：搜尋框＋篩選鈕（伺服器照網址算，選了就換頁）。 */}
          <DataTableToolbar>
            <SearchForm
              action={BASE}
              label="篩選組別"
              placeholder="搜尋組別、姓名、學號、信箱…"
              defaultValue={filter.q}
              maxLength={ROSTER_SEARCH_MAX_LENGTH}
              hidden={{
                cohort: cohort.id,
                type: filter.type !== 'all' ? filter.type : null,
                status: filter.status !== 'all' ? filter.status : null,
                advisor: filter.advisor !== 'all' ? filter.advisor : null,
                sort: filter.sort !== 'code' ? filter.sort : null,
                dir: filter.dir !== 'asc' ? filter.dir : null,
              }}
            />
            <FacetMenu
              label="類型"
              value={filter.type}
              allValue="all"
              options={ROSTER_TYPE_FILTERS.map((t) => ({ value: t, label: ROSTER_TYPE_FILTER_LABEL[t], href: rosterHref(cohort.id, filter, { type: t }) }))}
            />
            <FacetMenu
              label="指導老師"
              value={filter.advisor}
              allValue="all"
              options={[
                { value: 'all', label: '全部老師', href: rosterHref(cohort.id, filter, { advisor: 'all' }) },
                { value: 'none', label: '尚未指派', href: rosterHref(cohort.id, filter, { advisor: 'none' }) },
                ...teachers.map((t) => ({ value: t.userId, label: t.name, href: rosterHref(cohort.id, filter, { advisor: t.userId }) })),
              ]}
            />
            <FacetMenu
              label="狀態"
              value={filter.status}
              allValue="all"
              options={ROSTER_STATUS_FILTERS.map((t) => ({ value: t, label: ROSTER_STATUS_FILTER_LABEL[t], href: rosterHref(cohort.id, filter, { status: t }) }))}
            />
            {filtered ? <ClearFilters href={`${BASE}?cohort=${cohort.id}`} /> : null}
          </DataTableToolbar>
          <GroupRosterTable
            cohortId={cohort.id}
            total={overview.groups.length}
            filter={{ type: filter.type, status: filter.status, advisor: filter.advisor, q: filter.q, sort: filter.sort, dir: filter.dir }}
            columns={rosterColumns(cohort.id, filter)}
            empty={
              overview.groups.length === 0
                ? '本屆還沒有成立的組別。全員確認後，組別會自動出現在這裡。'
                : '沒有符合條件的組別；試著放寬搜尋字詞或清除篩選條件。'
            }
            rows={roster.map((g) => {
              const mismatch = groupSizeWarning(g.members.length, size) !== null
              return {
                id: g.id,
                code: g.code,
                emails: g.members.map((m) => m.loginEmail).filter((e): e is string => typeof e === 'string' && e.length > 0),
                cells: [
                  <GroupDetailButton
                    key="code"
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
                  <span key="members" className="block max-w-[16rem] text-sm text-muted-foreground">
                    {g.members.map((m) => (m.isLeader ? `${m.name}（組長）` : m.name)).join('、')}
                    {g.opportunity ? (
                      <span className="mt-1 block text-xs">
                        合作案：
                        <Link href={`/industry/${g.opportunity.opportunityId}`} className="font-semibold text-primary hover:underline">
                          {g.opportunity.name}
                        </Link>
                        {g.opportunity.status === 'withdrawn' ? '（已下架）' : ''}
                      </span>
                    ) : null}
                  </span>,
                  <span key="count" className={cn('tabular text-sm whitespace-nowrap', mismatch && 'font-semibold text-warning-on-subtle')}>
                    {g.members.length} 人{mismatch ? '（與設定不符）' : ''}
                  </span>,
                  <span key="at" className="tabular text-sm whitespace-nowrap text-muted-foreground">
                    {formatTaipeiMinute(g.establishedBusinessAt)}
                  </span>,
                ],
              }
            })}
          />
        </div>
      </Panel>

      {/* 以下兩塊原型沒有（原型的分組是直接成立）；正式碼的分組是提案制，照同一套 Panel 樣子放在後面。 */}
      <Panel
        title="進行中的提案"
        icon={<IconHourglass />}
        description={`${overview.openProposals.length} 份等待全員確認`}
        aria-label="進行中的提案"
      >
        {overview.openProposals.length === 0 ? (
          <PanelEmpty title="沒有等待確認的提案。" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead>
                <tr className={PANEL_TABLE_HEAD}>
                  <th scope="col" className="px-5 py-2.5 font-semibold">提案人</th>
                  <th scope="col" className="px-4 py-2.5 font-semibold">類型</th>
                  <th scope="col" className="px-4 py-2.5 font-semibold">成員與確認</th>
                  <th scope="col" className="px-4 py-2.5 font-semibold">到期時間</th>
                  <th scope="col" className="px-5 py-2.5">
                    <span className="sr-only">動作</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {overview.openProposals.map((p) => {
                  const overdue = businessNow.getTime() >= p.expiresBusinessAt.getTime()
                  return (
                    <tr key={p.id} className={PANEL_TABLE_ROW}>
                      <td className="px-5 py-3 font-semibold">{p.proposerName}</td>
                      <td className="px-4 py-3">
                        <Pill tone={p.groupType === 'industry' ? 'brand' : 'default'}>{GROUP_TYPE_LABEL[p.groupType]}</Pill>
                      </td>
                      <td className="px-4 py-3 text-sm">{p.invitations.map((i) => `${i.name}（${INVITATION_STATE_LABEL[i.state]}）`).join('、')}</td>
                      <td className={cn('tabular px-4 py-3', overdue && 'font-semibold text-destructive')}>
                        {formatTaipeiMinute(p.expiresBusinessAt)}
                        {overdue ? '（已過期）' : ''}
                      </td>
                      <td className="px-5 py-3 text-right">
                        <VoidProposalButton
                          proposalId={p.id}
                          label={`${p.proposerName}的提案`}
                          requestId={randomUUID()}
                          reasonMaxLength={VOID_REASON_MAX_LENGTH}
                        />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="最近終止的提案" icon={<IconHistory />} aria-label="最近終止的提案">
        {overview.closedProposals.length === 0 ? (
          <PanelEmpty title="還沒有終止的提案。" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm">
              <thead>
                <tr className={PANEL_TABLE_HEAD}>
                  <th scope="col" className="px-5 py-2.5 font-semibold">時間</th>
                  <th scope="col" className="px-4 py-2.5 font-semibold">提案人</th>
                  <th scope="col" className="px-4 py-2.5 font-semibold">原因</th>
                  <th scope="col" className="px-5 py-2.5 font-semibold">作廢理由</th>
                </tr>
              </thead>
              <tbody>
                {overview.closedProposals.map((p) => (
                  <tr key={p.id} className={PANEL_TABLE_ROW}>
                    <td className="tabular px-5 py-3 text-muted-foreground">{p.closedBusinessAt ? formatTaipeiMinute(p.closedBusinessAt) : ''}</td>
                    <td className="px-4 py-3 font-semibold">{p.proposerName}</td>
                    <td className="px-4 py-3">{p.terminationKind ? TERMINATION_KIND_LABEL[p.terminationKind] : ''}</td>
                    <td className="px-5 py-3 text-muted-foreground">{p.reason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>,
    {
      description,
      actions: (
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
      ),
    },
  )
}
