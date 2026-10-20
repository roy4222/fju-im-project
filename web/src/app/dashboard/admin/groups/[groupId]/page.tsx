import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { PageTitle } from '@/app/_ui/dashboard/primitives'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { cohortLabel, getCohortStatusQuery } from '@/composition/cohorts'
import { getGroupQuery, getOpportunityQuery, GROUP_TYPE_LABEL } from '@/composition/groups'
import { formatTaipeiMinute } from '@/shared/time'
import { groupsGradingPorts, loadAdvisorGrading } from '../groups-data'
import { GroupDetail } from './group-detail'

export const metadata = { title: '小組詳情｜資管系專題平台' }

export default async function AdminGroupPage({ params }: { params: Promise<{ groupId: string }> }) {
  const { groupId } = await params
  const actor = await requireRole(`/dashboard/admin/groups/${encodeURIComponent(groupId)}`, 'admin')
  const query = getGroupQuery()
  const group = await query.findGroup(groupId)
  if (!group) notFound()
  const cohort = await getCohortStatusQuery().get(group.cohortId)
  if (!cohort) notFound()
  const active = group.status === 'active'
  const [history, teachers, linkOptions, grading, dissolved] = await Promise.all([
    query.groupHistory(group.id),
    active ? query.teacherOptions() : Promise.resolve([]),
    active && group.groupType === 'industry' ? getOpportunityQuery().linkOptions(actor, { limit: 50 }) : Promise.resolve([]),
    active ? loadAdvisorGrading(groupsGradingPorts(), actor, cohort.id, [group]) : Promise.resolve(new Map()),
    active ? Promise.resolve([]) : query.dissolvedGroups(cohort.id),
  ])
  return <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current="/dashboard/admin/groups">
    <div className="space-y-5">
      <Link href={`/dashboard/admin/groups?cohort=${cohort.id}${active ? '' : '&status=deleted'}`} className="inline-flex min-h-11 items-center text-sm text-primary hover:underline">← 全部組別</Link>
      <header className="space-y-2">
        <PageTitle title={`${group.code}・${GROUP_TYPE_LABEL[group.groupType]}`} />
        <p className="text-sm text-muted-foreground">{cohortLabel(cohort)}・成立於 {formatTaipeiMinute(group.establishedBusinessAt)}{active ? '' : '・已刪除'}</p>
      </header>
      <GroupDetail group={group} history={history} teachers={teachers} linkOptions={linkOptions}
        grading={grading.get(group.id) ?? []} size={{ min: cohort.groupSizeMin, max: cohort.groupSizeMax }}
        dissolved={dissolved.find((g) => g.id === group.id) ?? null} />
    </div>
  </DashboardShell>
}
