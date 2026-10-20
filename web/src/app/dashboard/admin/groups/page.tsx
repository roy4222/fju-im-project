import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import { IconUsersGroup } from '@tabler/icons-react'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { ClearFilters, DataTableToolbar, SearchForm } from '@/app/_ui/data-table'
import { FacetMenu } from '@/app/_ui/data-table-facet'
import { CohortPills, PageTitle, Panel, QuietState } from '@/app/_ui/dashboard/primitives'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { AdminTabs } from '@/app/dashboard/admin/_tabs'
import { GROUP_TABS } from '@/app/dashboard/admin/_tabs.consts'
import { GroupingSettingsEditor } from './admin-group-forms'
import { BatchAssignDialog } from './advisor-forms'
import { GroupCard } from './group-card'
import { groupsGradingPorts, loadAdvisorGrading } from './groups-data'
import { RosterCount, RosterExportMenu, RosterSelection } from './roster-table'
import { ToolbarActions } from './toolbar-actions'
import { cohortLabel, describeGroupSize, getCohortStatusQuery, GROUP_SIZE_LIMIT, PROPOSAL_DAYS_LIMIT } from '@/composition/cohorts'
import type { RosterFilter } from '@/application/groups'
import {
  ADVISOR_BATCH_KIND_LABEL, ADVISOR_BATCH_OUTCOME_LABEL, ADVISOR_CSV_MAX_BYTES, CHANGE_REASON_MAX_LENGTH,
  applyRosterFilter, getGroupQuery, getOpportunityQuery, GROUP_TYPE_LABEL, normalizeRosterFilter, ROSTER_SEARCH_MAX_LENGTH,
  ROSTER_STATUS_FILTER_LABEL, ROSTER_STATUS_FILTERS, ROSTER_TYPE_FILTER_LABEL, ROSTER_TYPE_FILTERS, rosterQueryString,
} from '@/composition/groups'
import { formatTaipeiMinute } from '@/shared/time'

export const metadata = { title: '分組｜資管系專題平台' }
const BASE = '/dashboard/admin/groups'
function rosterHref(cohortId: string, filter: RosterFilter, overrides: Partial<RosterFilter> = {}): string {
  const query = rosterQueryString(filter, overrides)
  return `${BASE}?cohort=${cohortId}${query ? `&${query}` : ''}`
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
          <p data-testid="tab-intro" className="-mt-2 mb-4 text-sm text-muted-foreground">
            這一屆的所有組別、組員與指導老師。
          </p>
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

  const deleted = params.status === 'deleted'
  const [overview, teachers, linkOptions, dissolvedGroups] = await Promise.all([
    getGroupQuery().overview(cohort.id, { history: false }),
    getGroupQuery().teacherOptions(),
    getOpportunityQuery().linkOptions(actor, { limit: 50 }),
    deleted ? getGroupQuery().dissolvedGroups(cohort.id) : Promise.resolve([]),
  ])
  const gradingOf = deleted ? new Map() : await loadAdvisorGrading(groupsGradingPorts(), actor, cohort.id, overview.groups)
  const roster = applyRosterFilter(overview.groups, filter)
  const unassigned = overview.groups.filter((g) => !g.advisor).length
  const grouped = overview.groups.reduce((sum, g) => sum + g.members.length, 0)
  const size = { min: cohort.groupSizeMin, max: cohort.groupSizeMax }
  const filtered = deleted || filter.type !== 'all' || filter.status !== 'all' || filter.advisor !== 'all' || filter.q !== ''
  const industryUnlinked = overview.groups.filter((g) => g.groupType === 'industry' && !g.opportunity).length
  const deletedRows = dissolvedGroups.filter((g) =>
    (filter.type === 'all' || g.groupType === filter.type) &&
    (!filter.q || [g.code, ...g.members.flatMap((m) => [m.name, m.studentNo ?? ''])].some((v) => v.toLocaleLowerCase().includes(filter.q.toLocaleLowerCase()))),
  )
  const receipt = dissolvedGroups.find((g) => g.id === params.dissolved)
  const settings = <div className="flex flex-wrap items-center gap-2">
    <GroupingSettingsEditor cohortId={cohort.id} cohortLabel={cohortLabel(cohort)} revision={cohort.revision} requestId={randomUUID()}
      values={{ groupSizeMin: cohort.groupSizeMin, groupSizeMax: cohort.groupSizeMax, proposalDefaultDays: cohort.proposalDefaultDays }} sizeLimit={GROUP_SIZE_LIMIT} daysLimit={PROPOSAL_DAYS_LIMIT} />
    <span className="max-w-48 text-xs text-muted-foreground" data-testid="grouping-settings">{describeGroupSize(cohort.groupSizeMin, cohort.groupSizeMax)}・提案 {cohort.proposalDefaultDays} 天內要全員確認、不超過分組期（組隊、選指導老師、交提案的期間）</span>
  </div>
  return <RosterSelection key={`${cohort.id}-${deleted}-${JSON.stringify(filter)}`} ids={deleted ? [] : roster.map((g) => g.id)}>{shell(
    <>
      <CohortPills cohorts={cohorts.map((c) => ({ id: c.id, code: cohortLabel(c) }))} currentId={cohort.id} hrefFor={(id) => `${BASE}?cohort=${id}`} />
      {receipt ? <p role="status" className="rounded-lg bg-muted p-3 text-sm">已刪除 {receipt.code}：{receipt.members.length} 人回到未分組</p> : null}
      <Panel title="全部組別" icon={<IconUsersGroup />} description={`${overview.groups.length} 組、${grouped} 人`} aria-label="全部組別" bodyClassName="p-4"
        action={<BatchAssignDialog teachers={teachers} cohortId={cohort.id} cohortLabel={cohortLabel(cohort)} kindLabels={ADVISOR_BATCH_KIND_LABEL} outcomeLabels={ADVISOR_BATCH_OUTCOME_LABEL} maxBytes={ADVISOR_CSV_MAX_BYTES} reasonMaxLength={CHANGE_REASON_MAX_LENGTH} />}>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground" data-testid="advisor-summary">指導老師已指派 {overview.groups.length - unassigned}／{overview.groups.length}・{unassigned} 組尚未指派{industryUnlinked ? `・產學組未連結合作案 ${industryUnlinked}` : ''}</p>
          <DataTableToolbar>
            <SearchForm action={BASE} label="篩選組別" placeholder="搜尋組別、姓名、學號、信箱…" defaultValue={filter.q} maxLength={ROSTER_SEARCH_MAX_LENGTH}
              hidden={{ cohort: cohort.id, type: filter.type, status: deleted ? 'deleted' : filter.status, advisor: filter.advisor, sort: filter.sort, dir: filter.dir }} />
            <FacetMenu label="類型" value={filter.type} allValue="all" options={ROSTER_TYPE_FILTERS.map((t) => ({ value: t, label: ROSTER_TYPE_FILTER_LABEL[t], href: `${rosterHref(cohort.id, filter, { type: t })}${deleted ? '&status=deleted' : ''}` }))} />
            {!deleted ? <FacetMenu label="指導老師" value={filter.advisor} allValue="all" options={[
              { value: 'all', label: '全部老師', href: rosterHref(cohort.id, filter, { advisor: 'all' }) },
              { value: 'none', label: '尚未指派', href: rosterHref(cohort.id, filter, { advisor: 'none' }) },
              ...teachers.map((t) => ({ value: t.userId, label: t.name, href: rosterHref(cohort.id, filter, { advisor: t.userId }) })),
            ]} /> : null}
            <FacetMenu label="狀態" value={deleted ? 'deleted' : filter.status} allValue="all" options={[
              ...ROSTER_STATUS_FILTERS.map((t) => ({ value: t, label: ROSTER_STATUS_FILTER_LABEL[t], href: rosterHref(cohort.id, filter, { status: t }) })),
              { value: 'deleted', label: '已刪除', href: `${rosterHref(cohort.id, filter, { status: 'all' })}&status=deleted` },
            ]} />
            {!deleted ? <FacetMenu label="排序" value={filter.sort} allValue="code" options={([
              ['code', '組別'], ['type', '類型'], ['advisor', '指導老師'], ['members', '人數'], ['established', '成立時間'],
            ] as const).map(([value, label]) => ({ value, label, href: rosterHref(cohort.id, filter, { sort: value, dir: filter.sort === value && filter.dir === 'asc' ? 'desc' : 'asc' }) }))} /> : null}
            {!deleted ? <Link aria-label="反向排序" href={rosterHref(cohort.id, filter, { dir: filter.dir === 'asc' ? 'desc' : 'asc' })}
              className="inline-flex min-h-11 items-center rounded-lg border border-border px-3 text-sm hover:bg-muted">{filter.dir === 'asc' ? '升冪 ↑' : '降冪 ↓'}</Link> : null}
            {filtered ? <ClearFilters href={`${BASE}?cohort=${cohort.id}`} /> : null}
          </DataTableToolbar>
          {!deleted ? <RosterCount total={overview.groups.length} /> : null}
          <ul aria-label="組別卡片" className="grid gap-4 md:grid-cols-2">
            {deleted ? deletedRows.map((g) => <li key={g.id}><article aria-label={g.code} data-testid="group-card" className="space-y-3 rounded-xl border border-border p-4">
              <h3 className="text-xl font-bold">{g.code}</h3><p>{GROUP_TYPE_LABEL[g.groupType]}・已刪除</p>
              <p className="text-sm">{g.members.map((m) => m.name).join('、')}</p><p className="text-xs text-muted-foreground">{formatTaipeiMinute(g.dissolvedAt)}</p>
              {g.reason ? <p className="text-sm">理由：{g.reason}</p> : null}
              <Link href={`/dashboard/admin/groups/${g.id}`} className="text-primary hover:underline">紀錄</Link>
            </article></li>) : roster.map((g) => <li key={g.id}><GroupCard group={g} teachers={teachers} grading={gradingOf.get(g.id) ?? []} linkOptions={linkOptions} students={overview.ungrouped} size={size} /></li>)}
          </ul>
          {(deleted ? deletedRows : roster).length === 0 ? <p className="py-6 text-center text-muted-foreground">{deleted ? '沒有已刪除的組別。' : '沒有符合條件的組別；試著放寬搜尋字詞或清除篩選條件。'}</p> : null}
        </div>
      </Panel>
    </>,
    <ToolbarActions cohortId={cohort.id} cohortLabel={cohortLabel(cohort)} exportMenu={deleted ? null : <RosterExportMenu cohortId={cohort.id} filter={{ ...filter }} />} settings={settings} />,
  )}</RosterSelection>
}
