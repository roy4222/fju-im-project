import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import { IconHourglass, IconHistory, IconUsers, IconUsersGroup } from '@tabler/icons-react'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { ClearFilters, DataTableToolbar, SearchForm } from '@/app/_ui/data-table'
import { FacetMenu } from '@/app/_ui/data-table-facet'
import { CohortPills, PageTitle, Panel, PanelEmpty, Pill, QuietState } from '@/app/_ui/dashboard/primitives'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { AdminTabs } from '@/app/dashboard/admin/_tabs'
import { GroupingSettingsEditor, VoidProposalButton } from '@/app/dashboard/admin/groups/admin-group-forms'
import { AdvisorCell, BatchAssignDialog } from '@/app/dashboard/admin/groups/advisor-forms'
import { DissolveGroupButton } from '@/app/dashboard/admin/groups/dissolve-dialog'
import { DissolvedGroups } from '@/app/dashboard/admin/groups/dissolved-groups'
import { groupsGradingPorts, loadAdvisorGrading } from '@/app/dashboard/admin/groups/groups-data'
import { GroupDetailButton, UngroupedStudents } from '@/app/dashboard/admin/groups/member-forms'
import { LinkOpportunityButton } from '@/app/dashboard/admin/groups/link-opportunity-dialog'
import { GroupRosterTable, type RosterColumn } from '@/app/dashboard/admin/groups/roster-table'
import { GroupTypeCell } from '@/app/dashboard/admin/groups/type-forms'
import {
  cohortLabel,
  describeGroupSize,
  getBusinessClock,
  getCohortStatusQuery,
  GROUP_SIZE_LIMIT,
  PROPOSAL_DAYS_LIMIT,
} from '@/composition/cohorts'
import type { RosterFilter, RosterSort } from '@/application/groups'
import {
  ADVISOR_BATCH_KIND_LABEL,
  applyRosterFilter,
  ADVISOR_BATCH_OUTCOME_LABEL,
  ADVISOR_CSV_MAX_BYTES,
  CHANGE_REASON_MAX_LENGTH,
  getGroupQuery,
  getOpportunityQuery,
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

export const metadata = { title: '分組｜資管系專題平台' }

const BASE = '/dashboard/admin/groups'

/** 側欄「分組」底下的兩個分頁（設計方案 §2.1）；合作案頁掛同一組。 */
const GROUP_TABS = [
  { href: BASE, label: '分組總覽' },
  { href: '/dashboard/admin/industry', label: '合作案' },
] as const

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
 * 外觀照原型（票 36）：「未分組學生」、「全部組別」Data Table（搜尋、篩選鈕、排序、勾選），
 * 原型沒有的提案兩塊放在後面。點組別代碼開詳情（原型的側板）。
 *
 * 系辦改版（AD-05，設計方案 §3.3）：`h1`「分組」＋分頁列（分組總覽｜合作案）；「分組設定」放分頁列右側
 * （不放標題列，網站問題 #8；屆別膠囊名稱長，放分頁列下方）；頁首說明拿掉，指派數字搬到「全部組別」、分組設定摘要搬到「組隊中」；
 * 「組隊中」「最近終止」改卡片；組別表多一欄「合作案」。
 * AD-06（§3.3.1）：產學組的「合作案」格有「連結合作案／改連結」對話框（`link-opportunity-dialog.tsx`）。
 * A-19（PR #333）：名單每列的操作欄有「解散」（`dissolve-dialog.tsx`）；解散的組離開名單，改列在下方「已解散的組別」
 * （`dissolved-groups.tsx`）。
 */

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
    // 「合作案」欄：產學組這一格有「連結合作案／改連結」（AD-06）；一般組不會有（Q47）。
    { label: '合作案' },
    { label: '組員' },
    sortable('人數', 'members'),
    // 次要欄：1280 寬放不下時先收起來（網站問題 #7）。
    { ...sortable('成立時間', 'established'), secondary: true },
  ]
}

export default async function AdminGroupsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  const actor = await requireRole('/dashboard/admin/groups', 'admin')

  const cohorts = (await getCohortStatusQuery().list()).filter((c) => c.status !== 'archived')
  const params = await searchParams
  const wanted = params.cohort
  const filter: RosterFilter = normalizeRosterFilter(params)
  const cohort =
    cohorts.find((c) => c.id === wanted) ?? cohorts.find((c) => c.isDefaultWorking) ?? cohorts[0] ?? null

  const shell = (children: React.ReactNode, actions?: React.ReactNode) => (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current={BASE}>
      <div className="flex flex-col gap-5">
        <div>
          <PageTitle title="分組" />
          <div className="mt-4">
            <AdminTabs label="分組分頁" current={BASE} items={GROUP_TABS} actions={actions} />
          </div>
        </div>
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

  const [overview, businessNow, teachers, linkOptions, dissolvedGroups] = await Promise.all([
    getGroupQuery().overview(cohort.id, { history: false }),
    getBusinessClock().now(),
    getGroupQuery().teacherOptions(),
    // 連結合作案對話框的初始選項（AD-06）：一句 SQL、只有已發布、前 50 筆；搜尋與換頁在對話框裡走 action。
    getOpportunityQuery().linkOptions(actor, { limit: 50 }),
    getGroupQuery().dissolvedGroups(cohort.id),
  ])
  // 重派對話框要列的原老師評分指派：整屆讀一次 `adminBoard`，不逐組查（AD-14）。
  const gradingOf = await loadAdvisorGrading(groupsGradingPorts(), actor, cohort.id, overview.groups)
  const roster = applyRosterFilter(overview.groups, filter)
  const unassigned = overview.groups.filter((g) => !g.advisor).length
  const grouped = overview.groups.reduce((sum, g) => sum + g.members.length, 0)
  const size = { min: cohort.groupSizeMin, max: cohort.groupSizeMax }
  const openToJoin = overview.ungrouped.filter((u) => u.openToJoin).length
  const filtered = filter.type !== 'all' || filter.status !== 'all' || filter.advisor !== 'all' || filter.q !== ''
  const industryUnlinked = overview.groups.filter((g) => g.groupType === 'industry' && !g.opportunity).length

  return shell(
    <>
      {/* 屆別名稱長、測試站屆別多：放分頁列下方自己一列（擠在分頁列右側會把「分組設定」推到下一行）。 */}
      <CohortPills cohorts={cohorts.map((c) => ({ id: c.id, code: cohortLabel(c) }))} currentId={cohort.id} hrefFor={(id) => `${BASE}?cohort=${id}`} />

      <Panel
        title="未分組學生"
        icon={<IconUsers />}
        description={`${overview.ungrouped.length} 人・${openToJoin} 人公開找組員`}
        aria-label="未分組學生"
      >
        <UngroupedStudents
          students={overview.ungrouped.map((u) => ({ ...u }))}
          totalStudents={grouped + overview.ungrouped.length}
          groups={overview.groups.map((g) => ({ id: g.id, code: g.code, revision: g.revision, memberCount: g.members.length }))}
          size={size}
          requestId={randomUUID()}
          reasonMaxLength={CHANGE_REASON_MAX_LENGTH}
        />
      </Panel>

      <Panel
        title="全部組別"
        icon={<IconUsersGroup />}
        description={`${overview.groups.length} 組、${grouped} 人`}
        aria-label="全部組別"
        bodyClassName="p-4"
        action={
          <BatchAssignDialog
            cohortId={cohort.id}
            cohortLabel={cohortLabel(cohort)}
            kindLabels={ADVISOR_BATCH_KIND_LABEL}
            outcomeLabels={ADVISOR_BATCH_OUTCOME_LABEL}
            maxBytes={ADVISOR_CSV_MAX_BYTES}
            reasonMaxLength={CHANGE_REASON_MAX_LENGTH}
          />
        }
      >
        <div className="space-y-3">
          {/* 頁首說明拿掉後，指派進度放在組別表上方一行（Panel 的灰字說明會被截斷，這裡要看得完整）。 */}
          <p className="tabular text-sm text-muted-foreground" data-testid="advisor-summary">
            指導老師已指派 {overview.groups.length - unassigned}／{overview.groups.length}・{unassigned} 組尚未指派
            {industryUnlinked > 0 ? `・產學組未連結合作案 ${industryUnlinked}` : ''}
          </p>
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
                ? '本屆還沒有成立的組別。全員確認後，組別會自動出現在這裡；每一列會有「複製本組信箱」與匯出。'
                : '沒有符合條件的組別；試著放寬搜尋字詞或清除篩選條件。'
            }
            rows={roster.map((g) => {
              const mismatch = groupSizeWarning(g.members.length, size) !== null
              return {
                id: g.id,
                code: g.code,
                emails: g.members.map((m) => m.loginEmail).filter((e): e is string => typeof e === 'string' && e.length > 0),
                actions: (
                  <DissolveGroupButton
                    group={{ id: g.id, code: g.code, revision: g.revision, memberNames: g.members.map((m) => m.name) }}
                    cohortId={cohort.id}
                    requestId={randomUUID()}
                    reasonMaxLength={CHANGE_REASON_MAX_LENGTH}
                  />
                ),
                cells: [
                  <GroupDetailButton
                    key="code"
                    group={{
                      id: g.id,
                      code: g.code,
                      revision: g.revision,
                      typeLabel: GROUP_TYPE_LABEL[g.groupType],
                      members: g.members.map((m) => ({ ...m })),
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
                  <div key="opportunity" className="max-w-[10rem] text-sm">
                    {g.opportunity ? (
                      <span className="block truncate" title={g.opportunity.name}>
                        <Link href={`/industry/${g.opportunity.opportunityId}`} className="font-semibold text-primary hover:underline">
                          {g.opportunity.name}
                        </Link>
                        {g.opportunity.status === 'withdrawn' ? <span className="text-xs text-muted-foreground">（已下架）</span> : null}
                      </span>
                    ) : g.groupType === 'industry' ? (
                      <span className="block text-xs whitespace-nowrap text-muted-foreground">尚未連結</span>
                    ) : null}
                    {g.groupType === 'industry' ? (
                      <LinkOpportunityButton
                        group={{ id: g.id, code: g.code, revision: g.revision }}
                        current={g.opportunity?.name ?? null}
                        initialOptions={linkOptions}
                        requestId={randomUUID()}
                        reasonMaxLength={CHANGE_REASON_MAX_LENGTH}
                      />
                    ) : g.opportunity ? null : (
                      <span className="text-muted-foreground" aria-label="一般專題不連合作案">
                        —
                      </span>
                    )}
                  </div>,
                  <span key="members" className="block max-w-[10rem] text-sm text-muted-foreground">
                    <span className="block truncate" title={g.members.map((m) => (m.isLeader ? `${m.name}（組長）` : m.name)).join('、')}>
                      {g.members.map((m) => (m.isLeader ? `${m.name}（組長）` : m.name)).join('、')}
                    </span>
                  </span>,
                  <span key="count" className={cn('tabular block text-sm whitespace-nowrap', mismatch && 'font-semibold text-warning-on-subtle')}>
                    {g.members.length} 人{mismatch ? <span className="block text-xs">（與設定不符）</span> : null}
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

      {/* 剛解散完：動作把那組的 id 帶回網址（`?dissolved=`），回執顯示在這一塊。 */}
      <DissolvedGroups groups={dissolvedGroups} justDissolvedId={typeof params.dissolved === 'string' ? params.dissolved : null} />

      {/* 以下兩塊原型沒有（原型的分組是直接成立）；正式碼的分組是提案制，照同一套 Panel 樣子放在後面。 */}
      <Panel
        title="組隊中（等全員確認）"
        icon={<IconHourglass />}
        description={`${overview.openProposals.length} 份`}
        aria-label="組隊中（等全員確認）"
      >
        <div className="space-y-3 px-5 pb-5">
          {/* 分組設定的摘要（原本在頁首說明）：學生發起提案時照這個擋。 */}
          <p className="text-sm text-muted-foreground" data-testid="grouping-settings">
            {describeGroupSize(cohort.groupSizeMin, cohort.groupSizeMax)}・提案 {cohort.proposalDefaultDays} 天內要全員確認、不超過分組期（組隊、選指導老師、交提案的期間）
          </p>
          {overview.openProposals.length === 0 ? (
            <PanelEmpty title="沒有組隊中的提案。" />
          ) : (
            <ul className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3" aria-label="組隊中的提案">
              {overview.openProposals.map((p) => {
                const overdue = businessNow.getTime() >= p.expiresBusinessAt.getTime()
                return (
                  <li key={p.id} className="flex flex-col gap-2 rounded-lg border border-border p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-foreground">{p.proposerName}</span>
                      <Pill tone={p.groupType === 'industry' ? 'brand' : 'default'}>{GROUP_TYPE_LABEL[p.groupType]}</Pill>
                      <span className="tabular text-xs text-muted-foreground">{p.invitations.length} 人</span>
                    </div>
                    <p className="text-sm text-muted-foreground">{p.invitations.map((i) => `${i.name}（${INVITATION_STATE_LABEL[i.state]}）`).join('、')}</p>
                    <div className="mt-auto flex flex-wrap items-end justify-between gap-2">
                      <p className={cn('tabular text-xs', overdue ? 'font-semibold text-destructive' : 'text-muted-foreground')}>
                        到期 {formatTaipeiMinute(p.expiresBusinessAt)}
                        {overdue ? '（已過期）' : ''}
                      </p>
                      <VoidProposalButton
                        proposalId={p.id}
                        label={`${p.proposerName}的提案`}
                        requestId={randomUUID()}
                        reasonMaxLength={VOID_REASON_MAX_LENGTH}
                      />
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </Panel>

      <Panel title="最近終止的提案" icon={<IconHistory />} aria-label="最近終止的提案">
        {overview.closedProposals.length === 0 ? (
          <PanelEmpty title="還沒有終止的提案。" />
        ) : (
          <ul className="grid gap-3 px-5 pb-5 md:grid-cols-2 2xl:grid-cols-3" aria-label="最近終止的提案清單">
            {overview.closedProposals.map((p) => (
              <li key={p.id} className="flex flex-col gap-1.5 rounded-lg border border-border p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-foreground">{p.proposerName}</span>
                  {p.terminationKind ? <Pill>{TERMINATION_KIND_LABEL[p.terminationKind]}</Pill> : null}
                </div>
                <p className="tabular text-xs text-muted-foreground">{p.closedBusinessAt ? formatTaipeiMinute(p.closedBusinessAt) : ''}</p>
                {p.reason ? <p className="text-sm text-muted-foreground">作廢理由：{p.reason}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>,
    <GroupingSettingsEditor
      cohortId={cohort.id}
      cohortLabel={cohortLabel(cohort)}
      revision={cohort.revision}
      requestId={randomUUID()}
      values={{
        groupSizeMin: cohort.groupSizeMin,
        groupSizeMax: cohort.groupSizeMax,
        proposalDefaultDays: cohort.proposalDefaultDays,
      }}
      sizeLimit={GROUP_SIZE_LIMIT}
      daysLimit={PROPOSAL_DAYS_LIMIT}
    />,
  )
}
