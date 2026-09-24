import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { DataTable, EmptyState, PageHeader } from '@/app/_ui/primitives'
import { TEACHER_NAV } from '@/app/dashboard/_nav'
import { ClaimPanel, type ClaimRow } from '@/app/dashboard/teacher/groups/claim-button'
import { COHORT_STATUS_LABEL, getCohortStatusQuery } from '@/composition/cohorts'
import { getGroupQuery, GROUP_TYPE_LABEL } from '@/composition/groups'
import { cn } from '@/shared/cn'

export const metadata = { title: '分組｜資管系專題平台' }

/**
 * 老師「分組」（票 19；原型 `/dashboard/teacher/groups`）。
 *
 * 上半「產學組認領」：本屆產學組，尚未指派的可以按「認領」→「指定為我的組別」（先按先得，同時操作只有一位成功）。
 * 下半「全部組別」：所有老師都可查看一般與產學組別（產品 5.4），含組員與目前的指導老師。
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

  const shell = (children: React.ReactNode) => (
    <DashboardShell roleLabel="老師" items={TEACHER_NAV} current="/dashboard/teacher/groups">
      <PageHeader title="分組" description="產學組先按先得認領；一般組由系辦依抽籤結果指派。所有組別都看得到。" />
      {children}
    </DashboardShell>
  )

  if (!cohort) return shell(<EmptyState title="還沒有進行中的屆別" description="系辦建立屆別、學生成組之後，組別會出現在這裡。" />)

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
    }))
    .sort((a, b) => order[a.state] - order[b.state] || a.code.localeCompare(b.code))
  const openCount = claimRows.filter((r) => r.state === 'open').length
  const mine = groups.filter((g) => g.advisor?.teacherUserId === me).length

  return shell(
    <>
      {cohorts.length > 1 ? (
        <nav aria-label="選擇屆別" className="mb-4 flex flex-wrap gap-2">
          {cohorts.map((c) => (
            <Link
              key={c.id}
              href={`/dashboard/teacher/groups?cohort=${c.id}`}
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

      <section aria-label="分組摘要" className="mb-6 rounded-card border border-border bg-background px-5 py-4">
        <p className="text-xs font-semibold text-primary">
          {cohort.code}・{COHORT_STATUS_LABEL[cohort.status]}
        </p>
        <p data-testid="teacher-groups-summary" className="mt-0.5 text-xl font-semibold text-ink tabular-nums">
          你指導 {mine} 組・產學組可認領 {openCount} 組
        </p>
      </section>

      <section aria-label="產學組認領" className="mb-6 space-y-2">
        <h2 className="text-base font-semibold text-ink">產學組認領</h2>
        <p className="text-sm text-muted-foreground">先按先得；兩位老師同時按只有一位會成功。認領不會自動建立或連結合作案。</p>
        <ClaimPanel rows={claimRows} requestId={randomUUID()} />
      </section>

      <section aria-label="全部組別" className="space-y-2">
        <h2 className="text-base font-semibold text-ink">全部組別</h2>
        <DataTable
          columns={['組別', '類型', '組員', '指導老師']}
          rows={groups.map((g) => [
            <span key="code" className="font-semibold tabular-nums">
              {g.code}
            </span>,
            GROUP_TYPE_LABEL[g.groupType],
            g.members.map((m) => (m.isLeader ? `${m.name}（組長）` : m.name)).join('、'),
            g.advisor ? (
              <span key="advisor" className={cn(g.advisor.teacherUserId === me && 'font-semibold text-primary')}>
                {g.advisor.teacherName}
                {g.advisor.teacherUserId === me ? '（你）' : ''}
              </span>
            ) : (
              <span key="advisor" className="text-muted-foreground">
                尚未指派
              </span>
            ),
          ])}
          empty="本屆還沒有成立的組別。"
        />
      </section>
    </>,
  )
}
