import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import { IconUsersGroup } from '@tabler/icons-react'
import type { ResolvedActor } from '@/application/accounts'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { TEACHER_NAV } from '@/app/dashboard/_nav'
import { PageTitle, Panel, PanelEmpty } from '@/app/dashboard/teacher/_ui/dash'
import { TabNav } from '@/app/dashboard/teacher/_ui/tab-nav'
import { TeacherGroupsBoard, type GroupRow } from '@/app/dashboard/teacher/groups/claim-button'
import { INDUSTRY_DESCRIPTION, INDUSTRY_HREF, IndustryTab, NewOpportunityButton } from '@/app/dashboard/teacher/groups/industry-tab'
import { MyGroups } from '@/app/dashboard/teacher/groups/my-groups'
import { teacherFilterOptions } from '@/app/dashboard/teacher/groups/teacher-options'
import { COHORT_STATUS_LABEL, cohortLabel, getCohortStatusQuery } from '@/composition/cohorts'
import { getGroupQuery, getOpportunityQuery, GROUP_TYPE_LABEL } from '@/composition/groups'
import { cn } from '@/shared/cn'

export const metadata = { title: '分組總覽｜資管系專題平台' }

const BASE = '/dashboard/teacher/groups'

/** 「全部組別」說明句的結尾：一般組怎麼來的，一句帶過。 */
const GENERAL_NOTE = '一般組由系辦指派。'

/** 「我指導的組」（預設分頁）說明句的結尾（`pages.spec` 的指紋，`fingerprints.d/C3-09.json`）。 */
const MINE_NOTE = '產學組的確認與婉拒在「產學組」分頁。'

type Tab = 'mine' | 'industry' | 'all'

type Params = { cohort?: string | string[]; tab?: string | string[] }

/**
 * 老師「分組總覽」（票 19、37；TE-05 分頁；C3-09 改成三分頁，規格③ §7.1）：
 * `?tab=mine`（預設）｜`?tab=industry`｜`?tab=all`。
 *
 * - 我指導的組：一組一張卡（組員頭像一列、合作案名稱），連到作業區「指導組別的繳交」。`?cohort=` 切換屆別。
 * - 產學組（模擬圖 09）：「我的合作案」每一案底下「待確認要帶的組」（學生選了這一案、還沒有指導老師：
 *   「確認指導」「婉拒」）與「已帶的組」。取代原本「任何老師先按先得」的認領表。
 * - 全部組別：可搜尋篩選的表，每列組員頭像；一般組由系辦指派，老師不能自己擔任。
 *
 * 舊網址：`?tab=cases` 當成 `industry`；`/dashboard/teacher/industry` 先過角色檢查再轉到 `?tab=industry`
 * （`?scope=all` 丟棄，別人的案看前台 `/industry`）。不認得的 `tab` 一律當「我指導的組」，不轉頁（`pages.spec` 要直接拿到 200）。
 * 每個分頁只讀自己要的資料（`loadGroupsPage`）。
 */
export default async function TeacherGroupsPage({ searchParams }: { searchParams: Promise<Params> }) {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  const actor = await requireRole(BASE, 'teacher')
  const params = await searchParams
  const tab = resolveTab(params.tab)
  const wanted = typeof params.cohort === 'string' ? params.cohort : null
  const cohortQuery = wanted ? `cohort=${encodeURIComponent(wanted)}` : ''
  const tabs = [
    { key: 'mine', label: '我指導的組', href: cohortQuery ? `${BASE}?${cohortQuery}` : BASE },
    { key: 'industry', label: '產學組', href: INDUSTRY_HREF },
    { key: 'all', label: '全部組別', href: `${BASE}?tab=all${cohortQuery ? `&${cohortQuery}` : ''}` },
  ]
  const data = await loadGroupsPage(actor, tab, wanted)

  return (
    <DashboardShell roleLabel="老師" items={TEACHER_NAV} current={BASE}>
      <div className="flex flex-col gap-5">
        <PageTitle title="分組總覽" description={data.description} actions={tab === 'industry' ? <NewOpportunityButton /> : undefined} />
        <TabNav label="分組總覽分頁" tabs={tabs} current={tab} />
        {data.body}
      </div>
    </DashboardShell>
  )
}

function resolveTab(raw: string | string[] | undefined): Tab {
  if (raw === 'industry' || raw === 'cases') return 'industry'
  if (raw === 'all') return 'all'
  return 'mine'
}

/** 這一頁唯一的讀取入口：依分頁只讀那一頁要的資料。 */
async function loadGroupsPage(actor: ResolvedActor, tab: Tab, wanted: string | null) {
  const me = actor.kind === 'authenticated' ? actor.userId : ''
  if (tab === 'industry') {
    const query = getOpportunityQuery()
    const board = await query.teacherIndustryBoard(actor)
    // 「連結組別」（TE-B3）的選項：有已發布的案才查。
    const targets = board.cases.some((c) => c.opportunity.status === 'published') ? await query.teacherLinkTargets(actor) : []
    return {
      description: INDUSTRY_DESCRIPTION,
      body: <IndustryTab board={board} targets={targets} requestId={randomUUID()} />,
    }
  }

  const cohorts = (await getCohortStatusQuery().list()).filter((c) => c.status !== 'archived')
  const cohort = cohorts.find((c) => c.id === wanted) ?? cohorts.find((c) => c.isDefaultWorking) ?? cohorts[0] ?? null
  if (!cohort) {
    return {
      description: tab === 'all' ? GENERAL_NOTE : MINE_NOTE,
      body: (
        <Panel title={tab === 'all' ? '全部組別' : '我指導的組'} icon={<IconUsersGroup />}>
          <PanelEmpty icon={<IconUsersGroup />} title="還沒有進行中的屆別" hint="系辦建立屆別、學生成組之後，組別會出現在這裡。" />
        </Panel>
      ),
    }
  }

  // 列表不帶 `#history`（SH-P4）：這一頁沒有地方看組別的歷史。
  const groups = await getGroupQuery().cohortGroups(cohort.id, { history: false })
  const switcher =
    cohorts.length > 1 ? (
      <nav aria-label="選擇屆別" className="inline-flex w-fit max-w-full flex-wrap gap-1 rounded-xl border border-border bg-card p-1">
        {cohorts.map((c) => (
          <Link
            key={c.id}
            href={`${BASE}?${tab === 'all' ? 'tab=all&' : ''}cohort=${c.id}`}
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
    ) : null

  if (tab === 'mine') {
    const mine = groups.filter((g) => g.advisor?.teacherUserId === me)
    return {
      description: (
        <>
          {cohortLabel(cohort)}・{COHORT_STATUS_LABEL[cohort.status]}・
          <span data-testid="teacher-groups-summary">你指導 {mine.length} 組</span>。{MINE_NOTE}
        </>
      ),
      body: (
        <>
          {switcher}
          <MyGroups groups={mine} />
        </>
      ),
    }
  }

  const industry = groups.filter((g) => g.groupType === 'industry')
  const people = groups.reduce((sum, g) => sum + g.members.length, 0)
  const rows: GroupRow[] = groups.map((g) => ({
    groupId: g.id,
    code: g.code,
    industry: g.groupType === 'industry',
    typeLabel: GROUP_TYPE_LABEL[g.groupType],
    members: g.members.map((m) => ({ userId: m.userId, name: m.name, isLeader: m.isLeader, avatarPreset: m.avatarPreset, avatarFileId: m.avatarFileId })),
    memberText: g.members.map((m) => (m.isLeader ? `${m.name}（組長）` : m.name)).join('、'),
    advisorName: g.advisor?.teacherName ?? null,
    advisorUserId: g.advisor?.teacherUserId ?? null,
    mine: g.advisor?.teacherUserId === me,
    opportunityName: g.opportunity?.name ?? null,
  }))
  // 篩選用老師的帳號 ID 當值、姓名當標籤；同名的老師標籤後面加指導的組別好分辨。
  const teacherOptions = teacherFilterOptions(groups)

  return {
    description: (
      <>
        {cohortLabel(cohort)}・{COHORT_STATUS_LABEL[cohort.status]}・{groups.length} 組、{people} 人已分組・產學 {industry.length} 組（
        {industry.filter((g) => !g.advisor).length} 組未指派老師）。{GENERAL_NOTE}
      </>
    ),
    body: (
      <>
        {switcher}
        <TeacherGroupsBoard groups={rows} teacherOptions={teacherOptions} />
      </>
    ),
  }
}
