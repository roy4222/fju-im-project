import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import { AvatarImg } from '@/app/_ui/avatar/avatar-img'
import { Panel } from '@/app/_ui/dashboard/primitives'
import type { DissolvedGroupSummary, GroupHistoryEntry, GroupSummary } from '@/application/groups'
import { CHANGE_REASON_MAX_LENGTH, describeGroupHistory } from '@/composition/groups'
import { formatTaipeiMinute } from '@/shared/time'
import { AdvisorControls, DeleteGroup, OpportunityControls, type GroupControlsProps } from '../group-card'
import { MemberFeedback, RemoveMemberButton, SetLeaderButton } from '../member-forms'
import { CopyEmailsButton } from '../roster-table'

export function GroupDetail({ group: g, history, teachers, grading, linkOptions, size, dissolved }: GroupControlsProps & {
  group: GroupSummary & { status: 'active' | 'dissolved' }
  history: readonly GroupHistoryEntry[]
  size: { min: number; max: number }
  dissolved: DissolvedGroupSummary | null
}) {
  const active = g.status === 'active'
  return <div className="space-y-5 pointer-coarse:[&_button]:min-h-11 pointer-coarse:[&_button]:min-w-11 pointer-coarse:[&_a]:inline-flex pointer-coarse:[&_a]:min-h-11 pointer-coarse:[&_a]:min-w-11 pointer-coarse:[&_a]:items-center"><MemberFeedback>
    <div className="flex flex-wrap justify-end gap-3">
      {active ? <><DeleteGroup group={g} /><CopyEmailsButton code={g.code} emails={g.members.flatMap((m) => m.loginEmail ? [m.loginEmail] : [])} /></> : null}
      <Link href={`/dashboard/admin/grading/${g.id}`} className="inline-flex min-h-11 items-center rounded-lg border border-border px-3 text-sm font-semibold hover:bg-muted">成績</Link>
    </div>
    <Panel title="組員" aria-label="組員" bodyClassName="p-4">
      {active ? <>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead><tr className="border-b border-border">{['姓名', '學號', '系級', '登入信箱', '操作'].map((label) => <th key={label} className="p-2">{label}</th>)}</tr></thead>
            <tbody>{g.members.map((m) => <tr key={m.userId} className="border-b border-border last:border-0">
              <td className="p-2"><div className="flex items-center gap-2">
                <AvatarImg user={{ ...m, id: m.userId }} size={40} className="size-12" decorative />
                <div><Link href={`/dashboard/admin/accounts?q=${encodeURIComponent(m.studentNo ?? m.name)}`} className="text-primary hover:underline">{m.name}</Link>{m.isLeader ? <p className="text-xs text-primary">組長</p> : null}</div>
              </div></td>
              <td className="p-2">{m.studentNo ?? '—'}</td><td className="p-2">{m.departmentClass ?? '—'}</td><td className="p-2">{m.loginEmail ?? '—'}</td>
              <td className="p-2"><div className="flex flex-wrap gap-2">
                {g.members.length > 1 ? <RemoveMemberButton group={g} member={m} size={size} requestId={randomUUID()} reasonMaxLength={CHANGE_REASON_MAX_LENGTH} /> : null}
                {!m.isLeader ? <SetLeaderButton group={g} member={m} requestId={randomUUID()} reasonMaxLength={CHANGE_REASON_MAX_LENGTH} /> : null}
              </div></td>
            </tr>)}</tbody>
          </table>
        </div>
        {g.members.length <= 1 ? <p className="mt-3 text-sm text-muted-foreground">只剩一人時不能再移出。</p> : null}
      </> : <div className="space-y-2">
        <p>已刪除，原組資料只能查看。</p>
        <ul>{dissolved?.members.map((m, i) => <li key={i}>{m.name}・{m.studentNo ?? '—'}{m.isLeader ? '・組長' : ''}</li>)}</ul>
        {dissolved ? <p>刪除時間：{formatTaipeiMinute(dissolved.dissolvedAt)}</p> : null}
        {dissolved?.reason ? <p>理由：{dissolved.reason}</p> : null}
      </div>}
    </Panel>
    {active ? <Panel title="指導老師" aria-label="指導老師" bodyClassName="p-4">
      <div className="flex items-start gap-3">
        {g.advisor ? <AvatarImg user={{
          id: g.advisor.teacherUserId, name: g.advisor.teacherName,
          avatarPreset: g.advisor.avatarPreset, avatarFileId: g.advisor.avatarFileId,
        }} size={40} decorative /> : null}
        <AdvisorControls group={g} teachers={teachers} grading={grading} />
      </div>
    </Panel> : null}
    {active && g.groupType === 'industry' ? <Panel title="合作案" aria-label="合作案" bodyClassName="space-y-3 p-4">
      {g.opportunity ? <Link href={`/industry/${g.opportunity.opportunityId}`} className="text-primary hover:underline">{g.opportunity.name}</Link> : <p>尚未連結合作案</p>}
      {g.opportunity?.state === 'pending' ? <p className="text-warning-on-subtle">合作案待確認</p> : null}
      <OpportunityControls group={g} linkOptions={linkOptions} />
    </Panel> : null}
    <Panel title="異動紀錄" aria-label="異動紀錄" bodyClassName="p-4">
      {history.length ? <ul className="space-y-3">{history.map((h, i) => <li key={`${h.kind}-${i}`} className="border-b border-border pb-3 last:border-0">
        <time className="text-xs text-muted-foreground">{formatTaipeiMinute(h.at)}</time>
        <p>{describeGroupHistory(h)}</p>{h.reason ? <p className="mt-1 text-sm text-muted-foreground">理由：{h.reason}</p> : null}
      </li>)}</ul> : <p className="text-sm text-muted-foreground">成立後還沒有異動紀錄。</p>}
    </Panel>
  </MemberFeedback></div>
}
