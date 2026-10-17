import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import { IconUsersGroup } from '@tabler/icons-react'
import type { ResolvedActor } from '@/application/accounts'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { TEACHER_NAV } from '@/app/dashboard/_nav'
import { PageTitle, Panel, PanelEmpty } from '@/app/dashboard/teacher/_ui/dash'
import { TabNav } from '@/app/dashboard/teacher/_ui/tab-nav'
import { CASES_DESCRIPTION, CASES_HREF, CasesTab, NewOpportunityButton } from '@/app/dashboard/teacher/groups/cases-tab'
import { TeacherGroupsBoard, type ClaimRow, type GroupRow } from '@/app/dashboard/teacher/groups/claim-button'
import { MyGroups } from '@/app/dashboard/teacher/groups/my-groups'
import { teacherFilterOptions } from '@/app/dashboard/teacher/groups/teacher-options'
import { COHORT_STATUS_LABEL, cohortLabel, getCohortStatusQuery } from '@/composition/cohorts'
import { getGroupQuery, getOpportunityQuery, GROUP_TYPE_LABEL } from '@/composition/groups'
import { cn } from '@/shared/cn'

export const metadata = { title: '分組總覽｜資管系專題平台' }

const BASE = '/dashboard/teacher/groups'

/** 摘要句的結尾（`pages.spec` 的指紋）：一般組怎麼來的，一句帶過。 */
const GENERAL_NOTE = '一般組由系辦指派。'

type Params = { cohort?: string | string[]; tab?: string | string[]; scope?: string | string[] }

/**
 * 老師「分組總覽」（票 19、37；TE-05 加分頁，Q77、Q52）：`?tab=mine`（預設）｜`?tab=cases`。
 *
 * - 我的組別：上「我指導的組」卡片；中「擔任產學組指導老師」（本屆產學組，尚未指派的按「擔任指導老師」→
 *   「指定為我的組別」，先按先得，同時操作只有一位成功）；下「全部組別」可搜尋篩選的表（產品 5.4）。
 *   `?cohort=` 切換屆別。一般組由系辦指派，老師不能自己擔任；重派也只由系辦處理。
 * - 合作案：原 `/dashboard/teacher/industry` 整頁（那個網址先過角色檢查再轉到這裡），`?scope=all` 照舊。
 *
 * 每個分頁只讀自己要的資料（`loadGroupsPage`）。不認得的 `tab` 一律當「我的組別」，不轉頁（`pages.spec` 要直接拿到 200）。
 */
export default async function TeacherGroupsPage({ searchParams }: { searchParams: Promise<Params> }) {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  const actor = await requireRole(BASE, 'teacher')
  const params = await searchParams
  const data = await loadGroupsPage(actor, params)
  const wanted = typeof params.cohort === 'string' ? params.cohort : null
  const tabs = [
    { key: 'mine', label: '我的組別', href: wanted ? `${BASE}?cohort=${encodeURIComponent(wanted)}` : BASE },
    { key: 'cases', label: '合作案', href: CASES_HREF },
  ]

  return (
    <DashboardShell roleLabel="老師" items={TEACHER_NAV} current={BASE}>
      <div className="flex flex-col gap-5">
        <PageTitle
          title="分組總覽"
          description={data.tab === 'cases' ? CASES_DESCRIPTION : data.description}
          actions={data.tab === 'cases' ? <NewOpportunityButton /> : undefined}
        />
        <TabNav label="分組總覽分頁" tabs={tabs} current={data.tab} />
        {data.tab === 'cases' ? <CasesTab scope={data.scope} items={data.items} cards={data.cards} me={data.me} /> : data.body}
      </div>
    </DashboardShell>
  )
}

/** 這一頁唯一的讀取入口：依分頁只讀那一頁要的資料。 */
async function loadGroupsPage(actor: ResolvedActor, params: Params) {
  const me = actor.kind === 'authenticated' ? actor.userId : ''
  if (params.tab === 'cases') {
    const query = getOpportunityQuery()
    const [items, cards] = await Promise.all([query.manageList(actor), query.list(actor)])
    return { tab: 'cases', scope: params.scope === 'all' ? 'all' : 'mine', items, cards, me } as const
  }

  const cohorts = (await getCohortStatusQuery().list()).filter((c) => c.status !== 'archived')
  const cohort = cohorts.find((c) => c.id === params.cohort) ?? cohorts.find((c) => c.isDefaultWorking) ?? cohorts[0] ?? null
  if (!cohort) {
    return {
      tab: 'mine',
      description: `產學組由老師自己擔任指導老師，第一位確認的老師就是指導老師；${GENERAL_NOTE}`,
      body: (
        <Panel title="全部組別" icon={<IconUsersGroup />}>
          <PanelEmpty icon={<IconUsersGroup />} title="還沒有進行中的屆別" hint="系辦建立屆別、學生成組之後，組別會出現在這裡。" />
        </Panel>
      ),
    } as const
  }

  // 列表不帶 `#history`（SH-P4）：這一頁沒有地方看組別的歷史。
  const groups = await getGroupQuery().cohortGroups(cohort.id, { history: false })
  const industry = groups.filter((g) => g.groupType === 'industry')
  const order = { open: 0, mine: 1, taken: 2 } as const
  const claimRows: ClaimRow[] = industry
    .map((g): ClaimRow => ({
      groupId: g.id,
      code: g.code,
      memberCount: g.members.length,
      leaderName: g.members.find((m) => m.isLeader)?.name ?? null,
      state: !g.advisor ? 'open' : g.advisor.teacherUserId === me ? 'mine' : 'taken',
      advisorName: g.advisor?.teacherName ?? null,
      opportunityName: g.opportunity?.name ?? null,
    }))
    .sort((a, b) => order[a.state] - order[b.state] || a.code.localeCompare(b.code))
  const openCount = claimRows.filter((r) => r.state === 'open').length
  const mine = groups.filter((g) => g.advisor?.teacherUserId === me)
  const people = groups.reduce((sum, g) => sum + g.members.length, 0)
  const rows: GroupRow[] = groups.map((g) => ({
    groupId: g.id,
    code: g.code,
    industry: g.groupType === 'industry',
    typeLabel: GROUP_TYPE_LABEL[g.groupType],
    members: g.members.map((m) => (m.isLeader ? `${m.name}（組長）` : m.name)).join('、'),
    memberCount: g.members.length,
    advisorName: g.advisor?.teacherName ?? null,
    advisorUserId: g.advisor?.teacherUserId ?? null,
    mine: g.advisor?.teacherUserId === me,
    claimable: g.groupType === 'industry' && !g.advisor,
  }))
  // 篩選用老師的帳號 ID 當值、姓名當標籤；同名的老師標籤後面加指導的組別好分辨。
  const teacherOptions = teacherFilterOptions(groups)

  return {
    tab: 'mine',
    description: (
      <>
        {cohortLabel(cohort)}・{COHORT_STATUS_LABEL[cohort.status]}・{groups.length} 組、{people} 人已分組・產學 {industry.length} 組（
        {industry.filter((g) => !g.advisor).length} 組未指派老師）・
        <span data-testid="teacher-groups-summary">
          你指導 {mine.length} 組・產學組可擔任 {openCount} 組
        </span>
        。{GENERAL_NOTE}
      </>
    ),
    body: (
      <>
        {cohorts.length > 1 ? (
          <nav aria-label="選擇屆別" className="inline-flex w-fit max-w-full flex-wrap gap-1 rounded-xl border border-border bg-card p-1">
            {cohorts.map((c) => (
              <Link
                key={c.id}
                href={`${BASE}?cohort=${c.id}`}
                aria-current={c.id === cohort.id ? 'page' : undefined}
                className={cn(
                  'tabular inline-flex h-9 items-center rounded-lg px-3 text-sm font-semibold transition-colors',
                  c.id === cohort.id ? 'bg-ink text-ink-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                {cohortLabel(c)}
              </Link>
            ))}
          </nav>
        ) : null}
        <MyGroups groups={mine} />
        <TeacherGroupsBoard claimRows={claimRows} groups={rows} teacherOptions={teacherOptions} requestId={randomUUID()} />
      </>
    ),
  } as const
}
