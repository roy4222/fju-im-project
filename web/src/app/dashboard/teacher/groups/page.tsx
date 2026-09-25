import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import { IconUsersGroup } from '@tabler/icons-react'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { TEACHER_NAV } from '@/app/dashboard/_nav'
import { PageTitle, Panel, PanelEmpty } from '@/app/dashboard/teacher/_ui/dash'
import { TeacherGroupsBoard, type ClaimRow, type GroupRow } from '@/app/dashboard/teacher/groups/claim-button'
import { COHORT_STATUS_LABEL, getCohortStatusQuery } from '@/composition/cohorts'
import { getGroupQuery, GROUP_TYPE_LABEL } from '@/composition/groups'
import { cn } from '@/shared/cn'

export const metadata = { title: '分組總覽｜資管系專題平台' }

/**
 * 老師「分組總覽」（票 19；票 37 照原型 `/dashboard/teacher/groups`）。
 *
 * 標題下一行摘要；上面「產學組認領」：本屆產學組，尚未指派的可以按「認領」→「指定為我的組別」（先按先得，同時操作只有一位成功）。
 * 下面「全部組別」：所有老師都可查看一般與產學組別（產品 5.4），含組員與目前的指導老師。
 * 一般組由系辦依抽籤結果指派，老師不能自己認領；重派也只由系辦處理。
 */
export default async function TeacherGroupsPage({
  searchParams,
}: {
  searchParams: Promise<{ cohort?: string | string[] }>
}) {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  const actor = await requireRole('/dashboard/teacher/groups', 'teacher')
  const me = actor.kind === 'authenticated' ? actor.userId : ''

  const cohorts = (await getCohortStatusQuery().list()).filter((c) => c.status !== 'archived')
  const wanted = (await searchParams).cohort
  const cohort = cohorts.find((c) => c.id === wanted) ?? cohorts.find((c) => c.isDefaultWorking) ?? cohorts[0] ?? null

  const shell = (description: React.ReactNode, children: React.ReactNode) => (
    <DashboardShell roleLabel="老師" items={TEACHER_NAV} current="/dashboard/teacher/groups">
      <div className="flex flex-col gap-5">
        <PageTitle title="分組總覽" description={description} />
        {children}
      </div>
    </DashboardShell>
  )

  if (!cohort) {
    return shell(
      '產學組先按先得認領；一般組由系辦依抽籤結果指派。所有組別都看得到。',
      <Panel title="全部組別" icon={<IconUsersGroup />}>
        <PanelEmpty icon={<IconUsersGroup />} title="還沒有進行中的屆別" hint="系辦建立屆別、學生成組之後，組別會出現在這裡。" />
      </Panel>,
    )
  }

  const groups = await getGroupQuery().cohortGroups(cohort.id)
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
  const mine = groups.filter((g) => g.advisor?.teacherUserId === me).length
  const people = groups.reduce((sum, g) => sum + g.members.length, 0)
  const rows: GroupRow[] = groups.map((g) => ({
    groupId: g.id,
    code: g.code,
    industry: g.groupType === 'industry',
    typeLabel: GROUP_TYPE_LABEL[g.groupType],
    members: g.members.map((m) => (m.isLeader ? `${m.name}（組長）` : m.name)).join('、'),
    memberCount: g.members.length,
    advisorName: g.advisor?.teacherName ?? null,
    mine: g.advisor?.teacherUserId === me,
    claimable: g.groupType === 'industry' && !g.advisor,
  }))
  const teacherNames = [...new Set(groups.flatMap((g) => (g.advisor ? [g.advisor.teacherName] : [])))].sort((a, b) => a.localeCompare(b, 'zh-Hant'))

  return shell(
    <>
      {cohort.code}・{COHORT_STATUS_LABEL[cohort.status]}・{groups.length} 組、{people} 人已分組・產學 {industry.length} 組（
      {industry.filter((g) => !g.advisor).length} 組未指派老師）・
      <span data-testid="teacher-groups-summary">
        你指導 {mine} 組・產學組可認領 {openCount} 組
      </span>
      。一般組由系辦依抽籤結果指派；所有組別都看得到。
    </>,
    <>
      {cohorts.length > 1 ? (
        <nav aria-label="選擇屆別" className="inline-flex w-fit max-w-full flex-wrap gap-1 rounded-xl border border-border bg-card p-1">
          {cohorts.map((c) => (
            <Link
              key={c.id}
              href={`/dashboard/teacher/groups?cohort=${c.id}`}
              aria-current={c.id === cohort.id ? 'page' : undefined}
              className={cn(
                'tabular inline-flex h-9 items-center rounded-lg px-3 text-sm font-semibold transition-colors',
                c.id === cohort.id ? 'bg-ink text-ink-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              {c.code}
            </Link>
          ))}
        </nav>
      ) : null}
      <TeacherGroupsBoard claimRows={claimRows} groups={rows} teacherNames={teacherNames} requestId={randomUUID()} />
    </>,
  )
}
