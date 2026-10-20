import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import { IconCrown } from '@tabler/icons-react'
import { AvatarImg } from '@/app/_ui/avatar/avatar-img'
import { Pill } from '@/app/_ui/dashboard/primitives'
import type { GradingAssignmentSummary, GroupSummary, LinkOption, TeacherOption, UngroupedStudent } from '@/application/groups'
import { CHANGE_REASON_MAX_LENGTH, GROUP_TYPE_LABEL, groupSizeWarning } from '@/composition/groups'
import { AdvisorCell } from './advisor-forms'
import { DissolveGroupButton } from './dissolve-dialog'
import { LinkOpportunityButton, UnlinkOpportunityButton } from './link-opportunity-dialog'
import { AddMemberButton, RemoveMemberButton } from './member-forms'
import { CopyEmailsButton, SelectGroup } from './roster-table'
import { GroupTypeCell } from './type-forms'

export type GroupControlsProps = {
  group: GroupSummary
  teachers: TeacherOption[]
  grading: readonly GradingAssignmentSummary[]
  linkOptions: readonly LinkOption[]
}

export function AdvisorControls({ group: g, teachers, grading }: Omit<GroupControlsProps, 'linkOptions'>) {
  return <AdvisorCell group={{
    id: g.id, code: g.code, revision: g.revision, typeLabel: GROUP_TYPE_LABEL[g.groupType],
    advisor: g.advisor ? { userId: g.advisor.teacherUserId, name: g.advisor.teacherName } : null,
  }} teachers={teachers} grading={grading} requestIds={{ assign: randomUUID(), unassign: randomUUID() }} reasonMaxLength={CHANGE_REASON_MAX_LENGTH} />
}

export function OpportunityControls({ group: g, linkOptions }: Pick<GroupControlsProps, 'group' | 'linkOptions'>) {
  return <div className="space-y-2">
    <LinkOpportunityButton group={{ id: g.id, code: g.code, revision: g.revision }} current={g.opportunity?.name ?? null}
      initialOptions={linkOptions} requestId={randomUUID()} reasonMaxLength={CHANGE_REASON_MAX_LENGTH} />
    <UnlinkOpportunityButton linkId={g.opportunity?.linkId ?? null} code={g.code} requestId={randomUUID()} reasonMaxLength={CHANGE_REASON_MAX_LENGTH} />
  </div>
}

export function DeleteGroup({ group: g }: { group: GroupSummary }) {
  return <DissolveGroupButton group={{ id: g.id, code: g.code, revision: g.revision, memberNames: g.members.map((m) => m.name) }}
    cohortId={g.cohortId} requestId={randomUUID()} reasonMaxLength={CHANGE_REASON_MAX_LENGTH} disabled={g.hasFormalSubmission} />
}

/** 卡片內容由伺服器組成；原生 details 控制「更多」，歷程只在詳情頁讀取。 */
export function GroupCard({ group: g, teachers, grading, linkOptions, students, size }: GroupControlsProps & {
  students: readonly UngroupedStudent[]
  size: { min: number; max: number }
}) {
  const mismatch = groupSizeWarning(g.members.length, size)
  return <article aria-label={g.code} data-testid="group-card" data-code={g.code} className="flex min-w-0 flex-col gap-4 rounded-xl border border-border bg-card p-4 pointer-coarse:[&_button]:min-h-11 pointer-coarse:[&_button]:min-w-11">
    <div className="flex items-start justify-between gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-xl font-bold tabular-nums">{g.code}</h3>
        <Pill tone={g.groupType === 'industry' ? 'brand' : 'default'}>{GROUP_TYPE_LABEL[g.groupType]}</Pill>
        <span className={mismatch ? 'text-sm font-semibold text-warning-on-subtle' : 'text-sm text-muted-foreground'}>{g.members.length} 人{mismatch ? '（與設定不符）' : ''}</span>
      </div>
      <div className="flex items-start">
        <SelectGroup id={g.id} code={g.code} />
        <details className="relative">
          <summary className="cursor-pointer rounded-lg px-2 py-2 text-sm hover:bg-muted pointer-coarse:min-h-11 pointer-coarse:min-w-11" aria-label={`更多：${g.code}`}>更多</summary>
          <div className="absolute right-0 z-10 mt-1 w-64 space-y-3 rounded-lg border border-border bg-popover p-3 shadow-lg">
            <GroupTypeCell group={{ id: g.id, code: g.code, revision: g.revision, groupType: g.groupType, advisorName: g.advisor?.teacherName ?? null, opportunityName: g.opportunity?.name ?? null }}
              typeLabels={GROUP_TYPE_LABEL} requestId={randomUUID()} reasonMaxLength={CHANGE_REASON_MAX_LENGTH} />
            <AdvisorControls group={g} teachers={teachers} grading={grading} />
            {g.groupType === 'industry' ? <OpportunityControls group={g} linkOptions={linkOptions} /> : null}
            <CopyEmailsButton code={g.code} emails={g.members.flatMap((m) => m.loginEmail ? [m.loginEmail] : [])} />
            <DeleteGroup group={g} />
          </div>
        </details>
      </div>
    </div>
    {g.groupType === 'industry' ? <div className="text-sm">
      {g.opportunity ? <Link href={`/industry/${g.opportunity.opportunityId}`} className="text-primary hover:underline">{g.opportunity.name}</Link> : '尚未連結合作案'}
      {g.opportunity?.state === 'pending' ? <p className="text-warning-on-subtle">合作案待確認</p> : null}
      {g.opportunity?.status === 'withdrawn' ? <p className="text-muted-foreground">合作案已下架</p> : null}
    </div> : null}
    <div className="flex items-center gap-2 text-sm">
      {g.advisor ? <>
        <AvatarImg user={{ id: g.advisor.teacherUserId, name: g.advisor.teacherName, avatarPreset: g.advisor.avatarPreset, avatarFileId: g.advisor.avatarFileId }} size={24} decorative />
        <span>{g.advisor.teacherName}</span>
      </> : <span className="font-semibold text-destructive">尚未指派</span>}
    </div>
    <ul aria-label="組員" className="flex flex-wrap gap-4">
      {g.members.map((m) => <li key={m.userId}>
        <Link href={`/dashboard/admin/accounts?q=${encodeURIComponent(m.studentNo ?? m.name)}`} className="flex min-w-11 flex-col items-center gap-1 rounded-lg p-1 text-sm hover:bg-muted">
          <AvatarImg user={{ ...m, id: m.userId }} size={40} decorative />
          <span>{m.name}</span>
          {m.isLeader ? <span className="flex items-center gap-1 text-xs text-primary"><IconCrown className="size-3.5" aria-hidden />組長</span> : null}
        </Link>
      </li>)}
    </ul>
    <div className="mt-auto flex flex-wrap items-start gap-2 border-t border-border pt-3">
      <AddMemberButton group={g} students={students} size={size} requestId={randomUUID()} reasonMaxLength={CHANGE_REASON_MAX_LENGTH} />
      <RemoveMemberButton group={g} size={size} requestId={randomUUID()} reasonMaxLength={CHANGE_REASON_MAX_LENGTH} />
      <Link href={`/dashboard/admin/groups/${g.id}`} className="ml-auto rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground pointer-coarse:min-h-11">進入小組</Link>
    </div>
  </article>
}
