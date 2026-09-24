import { randomUUID } from 'node:crypto'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { Card, DataTable, EmptyState, PageHeader } from '@/app/_ui/primitives'
import { STUDENT_NAV } from '@/app/dashboard/_nav'
import {
  OpenToJoinToggle,
  ProposalActions,
  ProposeForm,
  type MyProposalRole,
} from '@/app/dashboard/student/groups/group-forms'
import { describeGroupSize, getBusinessClock, getCohortStatusQuery } from '@/composition/cohorts'
import {
  getGroupQuery,
  GROUP_TYPE_LABEL,
  GROUP_TYPES,
  INVITATION_STATE_LABEL,
  STUDENT_NO_MAX_LENGTH,
  studentCohortOf,
  TERMINATION_KIND_LABEL,
} from '@/composition/groups'
import { cn } from '@/shared/cn'
import { formatTaipeiMinute } from '@/shared/time'

export const metadata = { title: '我的組別｜資管系專題平台' }

/**
 * 學生「我的組別」（票 13；原型 `/dashboard/student/groups`）。
 *
 * 上半：已有組別就顯示組別與組長；有進行中的提案就顯示每人確認狀態與確切到期時間；
 * 兩者都沒有就是發起提案的表單（人數照本屆設定）。下半：公開找組員開關與同屆名單、提案紀錄。
 */
export default async function StudentGroupsPage() {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  const actor = await requireRole('/dashboard/student/groups', 'student')
  const userId = actor.kind === 'authenticated' ? actor.userId : ''
  const cohortId = studentCohortOf(actor)

  const shell = (children: React.ReactNode) => (
    <DashboardShell roleLabel="學生" items={STUDENT_NAV} current="/dashboard/student/groups">
      <PageHeader title="我的組別" description="每位成員各自按確認，全員確認的那一刻組別才成立。" />
      {children}
    </DashboardShell>
  )

  const cohort = cohortId ? await getCohortStatusQuery().get(cohortId) : null
  if (!cohortId || !cohort) {
    return shell(
      <EmptyState title="你還沒有歸屬的屆別" description="帳號核准並歸到某一屆之後，才能找組員與發起提案。" />,
    )
  }

  const groupQuery = getGroupQuery()
  const [view, teammates, businessNow] = await Promise.all([
    groupQuery.studentView(userId, cohortId),
    groupQuery.teammates(actor, cohortId),
    getBusinessClock().now(),
  ])
  const proposal = view.openProposal
  const mine = proposal?.invitations.find((i) => i.userId === userId)
  const overdue = proposal ? businessNow.getTime() >= proposal.expiresBusinessAt.getTime() : false
  const role: MyProposalRole | null =
    proposal && mine
      ? {
          proposalId: proposal.id,
          isProposer: proposal.proposerUserId === userId,
          myState: mine.state === 'pending' || mine.state === 'confirmed' ? mine.state : 'other',
          overdue,
        }
      : null
  const size = describeGroupSize(cohort.groupSizeMin, cohort.groupSizeMax)

  return shell(
    <>
      <section aria-label="我的組別狀態" className="mb-6 rounded-card border border-border bg-background p-5">
        {view.group ? (
          <div>
            <p className="text-xs font-semibold text-primary">
              {cohort.code}・{GROUP_TYPE_LABEL[view.group.groupType]}
            </p>
            <h2 className="mt-1 text-xl font-semibold text-ink">組別 {view.group.code}</h2>
            <p className="mt-1 text-sm text-muted-foreground tabular-nums">
              {formatTaipeiMinute(view.group.establishedBusinessAt)} 成立・{view.group.members.length} 人
            </p>
            <ul aria-label="組員" className="mt-4 flex flex-wrap gap-2">
              {view.group.members.map((m) => (
                <li
                  key={m.userId}
                  className={cn(
                    'rounded-full border px-3 py-1 text-sm',
                    m.userId === userId ? 'border-primary text-ink' : 'border-border text-ink',
                  )}
                >
                  {m.name}
                  <span className="ml-1 text-xs text-muted-foreground tabular-nums">{m.studentNo}</span>
                  {m.isLeader ? (
                    <span className="ml-2 rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground">組長</span>
                  ) : null}
                </li>
              ))}
            </ul>
            {view.group.history.length > 0 ? (
              <ol aria-label="組別異動" className="mt-4 space-y-1 text-sm text-ink">
                {view.group.history.map((h, index) => (
                  <li key={index}>
                    <span className="mr-2 text-xs text-muted-foreground tabular-nums">{formatTaipeiMinute(h.at)}</span>
                    {h.kind === 'member_added'
                      ? `${h.userName} 加入`
                      : h.kind === 'member_removed'
                        ? `${h.userName} 移出`
                        : `組長 ${h.previousLeaderName ?? '—'} → ${h.userName}`}
                  </li>
                ))}
              </ol>
            ) : null}
            <p className="mt-3 text-xs text-muted-foreground">成立後的成員異動、換組長由系辦處理。</p>
          </div>
        ) : proposal ? (
          <div>
            <p className="text-xs font-semibold text-primary">
              進行中的提案・{GROUP_TYPE_LABEL[proposal.groupType]}・提案人 {proposal.proposerName}
            </p>
            <h2 className="mt-1 text-xl font-semibold text-ink tabular-nums">
              {proposal.invitations.filter((i) => i.state === 'confirmed').length}／{proposal.invitations.length} 已確認
            </h2>
            <p className="mt-1 text-sm text-muted-foreground tabular-nums">
              到期時間 {formatTaipeiMinute(proposal.expiresBusinessAt)}
              {overdue ? '（已過期，系統會終止這份提案並釋放所有人）' : '；到期前沒全員確認，提案會自動終止。'}
            </p>
            <ul aria-label="提案成員" className="mt-4 divide-y divide-border rounded-card border border-border">
              {proposal.invitations.map((i) => (
                <li key={i.userId} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                  <span className={i.userId === userId ? 'font-semibold text-ink' : 'text-ink'}>
                    {i.name}
                    <span className="ml-2 text-xs text-muted-foreground tabular-nums">{i.studentNo}</span>
                    {i.userId === proposal.proposerUserId ? <span className="ml-2 text-xs text-muted-foreground">提案人</span> : null}
                  </span>
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-xs font-medium',
                      i.state === 'confirmed' ? 'bg-primary-subtle text-primary-on-subtle' : 'bg-muted text-muted-foreground',
                    )}
                  >
                    {INVITATION_STATE_LABEL[i.state]}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-muted-foreground">
              等待確認時不能改名單或類型；要改請撤回後重新發起，所有人重新確認。
            </p>
          </div>
        ) : (
          <div>
            <h2 className="text-base font-semibold text-ink">發起提案</h2>
            <p className="mt-1 mb-4 text-sm text-muted-foreground">
              本屆{size}（含你自己）。送出後所有人都會被占住並收到邀請，要在 {cohort.proposalDefaultDays} 天內（不超過成組期）全員確認。
            </p>
            <ProposeForm
              requestId={randomUUID()}
              otherSlots={cohort.groupSizeMax - 1}
              requiredOthers={cohort.groupSizeMin - 1}
              groupTypes={GROUP_TYPES.map((value) => ({ value, label: GROUP_TYPE_LABEL[value] }))}
              studentNoMaxLength={STUDENT_NO_MAX_LENGTH}
            />
          </div>
        )}
        <div key="proposal-actions" className="mt-4">
          <ProposalActions proposal={role} requestIds={{ confirm: randomUUID(), terminate: randomUUID() }} />
        </div>
      </section>

      <Card
        title="找組員"
        description="只列出同屆、還沒分組、本人開啟公開的同學；只顯示姓名、學號與聯絡 Email，電話不公開。完成分組後會自動從名單消失。"
        className="mb-6"
      >
        {view.group ? null : (
          <div className="mb-4">
            <OpenToJoinToggle open={view.openToJoin} requestId={randomUUID()} />
          </div>
        )}
        <section aria-label="找組員名單">
          <DataTable
            columns={['姓名', '學號', '聯絡 Email']}
            rows={teammates.map((t) => [t.name, <span key="no" className="tabular-nums">{t.studentNo}</span>, t.contactEmail])}
            empty="目前沒有公開找組員的同學。"
          />
        </section>
      </Card>

      <section aria-label="提案紀錄" className="space-y-2">
        <h2 className="text-base font-semibold text-ink">提案紀錄</h2>
        {view.history.length === 0 ? (
          <p className="text-sm text-muted-foreground">還沒有結束的提案。</p>
        ) : (
          <ul className="space-y-2">
            {view.history.map((p) => (
              <li key={p.id} className="rounded-card border border-border px-4 py-2 text-sm text-ink">
                <span className="tabular-nums text-muted-foreground">
                  {p.closedBusinessAt ? formatTaipeiMinute(p.closedBusinessAt) : ''}
                </span>
                <span className="ml-2">
                  {p.proposerName} 發起的{GROUP_TYPE_LABEL[p.groupType]}提案・
                  {p.state === 'established'
                    ? `已成立（${p.establishedGroupCode}）`
                    : `已終止：${p.terminationKind ? TERMINATION_KIND_LABEL[p.terminationKind] : ''}`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>,
  )
}
