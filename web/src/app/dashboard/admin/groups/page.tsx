import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { DataTable, EmptyState, PageHeader } from '@/app/_ui/primitives'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { GroupingSettingsEditor, VoidProposalButton } from '@/app/dashboard/admin/groups/admin-group-forms'
import {
  COHORT_STATUS_LABEL,
  describeGroupSize,
  getBusinessClock,
  getCohortStatusQuery,
  GROUP_SIZE_LIMIT,
  PROPOSAL_DAYS_LIMIT,
} from '@/composition/cohorts'
import {
  getGroupQuery,
  GROUP_TYPE_LABEL,
  INVITATION_STATE_LABEL,
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
 * 管理員直接加入／移出組員、換組長在票 14。
 */
export default async function AdminGroupsPage({
  searchParams,
}: {
  searchParams: Promise<{ cohort?: string | string[] }>
}) {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  await requireRole('/dashboard/admin/groups', 'admin')

  const cohorts = (await getCohortStatusQuery().list()).filter((c) => c.status !== 'archived')
  const wanted = (await searchParams).cohort
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

  const [overview, businessNow] = await Promise.all([getGroupQuery().overview(cohort.id), getBusinessClock().now()])
  const grouped = overview.groups.reduce((sum, g) => sum + g.members.length, 0)

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
        <h2 className="text-base font-semibold text-ink">全部組別</h2>
        <DataTable
          columns={['組別', '類型', '組員', '人數', '成立時間']}
          rows={overview.groups.map((g) => [
            <span key="code" className="font-semibold tabular-nums">
              {g.code}
            </span>,
            GROUP_TYPE_LABEL[g.groupType],
            g.members.map((m) => (m.isLeader ? `${m.name}（組長）` : m.name)).join('、'),
            <span
              key="count"
              className={cn(
                'tabular-nums',
                (g.members.length < cohort.groupSizeMin || g.members.length > cohort.groupSizeMax) && 'font-semibold text-danger',
              )}
            >
              {g.members.length} 人
            </span>,
            <span key="at" className="tabular-nums">
              {formatTaipeiMinute(g.establishedBusinessAt)}
            </span>,
          ])}
          empty="本屆還沒有成立的組別。全員確認後，組別會自動出現在這裡。"
        />
      </section>

      <section aria-label="未分組學生" className="mb-6 space-y-2">
        <h2 className="text-base font-semibold text-ink">未分組學生</h2>
        <DataTable
          columns={['姓名', '學號', '找組員', '提案']}
          rows={overview.ungrouped.map((u) => [
            u.name,
            <span key="no" className="tabular-nums">
              {u.studentNo}
            </span>,
            u.openToJoin ? '公開找組員' : '未公開',
            u.inProposal ? '提案等待確認中' : '—',
          ])}
          empty="本屆學生都分好組了。"
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
