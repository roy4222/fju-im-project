import { randomUUID } from 'node:crypto'
import { IconCheck, IconHistory, IconMail, IconUserPlus, IconUsers } from '@tabler/icons-react'
import { PageTitle, Panel, PanelEmpty, Pill } from '@/app/_ui/dashboard-primitives'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { EmptyState } from '@/app/_ui/primitives'
import { STUDENT_NAV } from '@/app/dashboard/_nav'
import {
  OpenToJoinToggle,
  ProposalActions,
  ProposeForm,
  type MyProposalRole,
} from '@/app/dashboard/student/groups/group-forms'
import { IndustryPanel } from '@/app/dashboard/student/groups/industry-panel'
import { describeGroupSize, getBusinessClock, getCohortStatusQuery } from '@/composition/cohorts'
import {
  CHANGE_REASON_MAX_LENGTH,
  describeGroupHistory,
  getGroupQuery,
  getOpportunityQuery,
  opportunityName,
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

/** 座位格的欄數（Tailwind 要看得到完整的 class 名稱，所以列出來）。 */
const SEAT_COLS: Record<number, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-2',
  3: 'grid-cols-3',
  4: 'grid-cols-4',
  5: 'grid-cols-5',
  6: 'grid-cols-6',
}

type Seat = { key: string; name: string; sub: string; confirmed: boolean; leader: boolean; me: boolean; note?: string }

/**
 * 學生「我的組別」（票 13；原型 `/dashboard/student/groups`，票 38 換成原型版型：「不要像儀表板，像一張組員名單」）。
 *
 * 上半一張白卡：組別（或進行中的提案）＋一排組員頭像（實心＋勾＝已確認、灰框＝待確認）＋底下一行確認進度。
 * 沒有組別也沒有提案時，同一張卡是發起提案的表單（人數照本屆設定，原型沒有這個畫面）。
 * 下半：組別類型與合作案（票 20）、找組員（公開開關＋同屆名單）、提案紀錄。
 */
export default async function StudentGroupsPage({
  searchParams,
}: {
  searchParams: Promise<{ opportunity?: string | string[] }>
}) {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  const actor = await requireRole('/dashboard/student/groups', 'student')
  const userId = actor.kind === 'authenticated' ? actor.userId : ''
  const cohortId = studentCohortOf(actor)

  const shell = (children: React.ReactNode) => (
    <DashboardShell roleLabel="學生" items={STUDENT_NAV} current="/dashboard/student/groups">
      <div className="flex flex-col gap-5">
        <PageTitle title="我的組別" description="每位成員各自按確認，全員確認的那一刻組別才成立。" />
        {children}
      </div>
    </DashboardShell>
  )

  const cohort = cohortId ? await getCohortStatusQuery().get(cohortId) : null
  if (!cohortId || !cohort) {
    return shell(<EmptyState title="你還沒有歸屬的屆別" description="帳號核准並歸到某一屆之後，才能找組員與發起提案。" />)
  }

  const groupQuery = getGroupQuery()
  const [view, teammates, businessNow, panel] = await Promise.all([
    groupQuery.studentView(userId, cohortId),
    groupQuery.teammates(actor, cohortId),
    getBusinessClock().now(),
    // 組別類型與合作案（票 20）：組長能不能改類型、可以連哪些合作案，由查詢依本人身分算。
    getOpportunityQuery().leaderPanel(actor, cohortId),
  ])
  const preselect = (await searchParams).opportunity
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
  const confirmedCount = proposal ? proposal.invitations.filter((i) => i.state === 'confirmed').length : 0

  const seats: Seat[] = view.group
    ? view.group.members.map((m) => ({
        key: m.userId,
        name: m.name,
        sub: m.studentNo ?? '',
        confirmed: true,
        leader: m.isLeader,
        me: m.userId === userId,
      }))
    : proposal
      ? proposal.invitations.map((i) => ({
          key: i.userId,
          name: i.name,
          sub: INVITATION_STATE_LABEL[i.state],
          confirmed: i.state === 'confirmed',
          leader: false,
          me: i.userId === userId,
          note: i.userId === proposal.proposerUserId ? '提案人' : undefined,
        }))
      : []

  return shell(
    <>
      <section aria-label="我的組別狀態" className="dash-card overflow-hidden">
        {view.group ? (
          <>
            <div className="flex flex-wrap items-start justify-between gap-4 px-6 pt-6">
              <div className="min-w-0">
                <p className="tabular text-xs font-bold tracking-[0.06em] text-muted-foreground">
                  {cohort.code}・{GROUP_TYPE_LABEL[view.group.groupType]}
                </p>
                <h2 className="mt-1 text-[24px] font-extrabold tracking-tight">組別 {view.group.code}</h2>
                <p data-testid="my-advisor" className="mt-1 text-sm text-muted-foreground">
                  指導老師{' '}
                  {view.group.advisor ? (
                    <span className="font-semibold text-foreground">{view.group.advisor.teacherName}</span>
                  ) : (
                    <span>
                      尚未指派（{view.group.groupType === 'industry' ? '產學組由老師認領或系辦指派' : '一般組由系辦依抽籤結果指派'}）
                    </span>
                  )}
                </p>
              </div>
              <Pill tone="success" className="text-xs">
                已成立
              </Pill>
            </div>
            <Seats seats={seats} label="組員" />
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/70 px-6 py-3 text-xs text-muted-foreground">
              <span className="tabular font-semibold text-foreground">
                {view.group.members.length} 人・{formatTaipeiMinute(view.group.establishedBusinessAt)} 成立
              </span>
              <span>・成立後的成員異動、換組長、指導老師指派由系辦處理；組別類型與合作案見下方。</span>
            </div>
            {view.group.history.length > 0 ? (
              <ol aria-label="組別異動" className="flex flex-col gap-1 border-t border-border/70 px-6 py-3 text-sm">
                {view.group.history.map((h, index) => (
                  <li key={index}>
                    <span className="tabular mr-2 text-xs text-muted-foreground">{formatTaipeiMinute(h.at)}</span>
                    {describeGroupHistory(h)}
                  </li>
                ))}
              </ol>
            ) : null}
          </>
        ) : proposal ? (
          <>
            <div className="flex flex-wrap items-start justify-between gap-4 px-6 pt-6">
              <div className="min-w-0">
                <p className="tabular text-xs font-bold tracking-[0.06em] text-muted-foreground">
                  {cohort.code}・{GROUP_TYPE_LABEL[proposal.groupType]}・提案人 {proposal.proposerName}
                </p>
                <h2 className="mt-1 text-[24px] font-extrabold tracking-tight">進行中的提案</h2>
                <p className="tabular mt-1 text-sm text-muted-foreground">
                  到期時間 {formatTaipeiMinute(proposal.expiresBusinessAt)}
                  {overdue ? '（已過期，系統會終止這份提案並釋放所有人）' : '；到期前沒全員確認，提案會自動終止。'}
                </p>
              </div>
              <Pill tone="brand" className="text-xs">
                成立中・還差 {proposal.invitations.length - confirmedCount} 人確認
              </Pill>
            </div>
            <Seats seats={seats} label="提案成員" />
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/70 px-6 py-3 text-xs text-muted-foreground">
              <span className="tabular font-semibold text-foreground">
                {confirmedCount}／{proposal.invitations.length} 已確認
              </span>
              <span>・每個人用自己的帳號按確認；全員確認後組別成立。等待確認時不能改名單或類型，要改請撤回後重新發起。</span>
            </div>
          </>
        ) : (
          <div className="px-6 pt-6 pb-2">
            <h2 className="text-[15px] font-bold">發起提案</h2>
            <p className="mt-1 mb-4 text-[13px] text-muted-foreground">
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
        {/* 動作列一直掛在同一個位置：組別成立或提案終止後按鈕消失，但剛剛那句回饋還在（沒有東西時是空的）。 */}
        <div key="proposal-actions" className="px-6 empty:hidden has-[*:not(:empty)]:pb-5">

          <ProposalActions proposal={role} requestIds={{ confirm: randomUUID(), terminate: randomUUID() }} />
        </div>
      </section>

      {view.group && panel ? (
        <IndustryPanel
          groupId={panel.groupId}
          groupCode={panel.groupCode}
          revision={panel.revision}
          isLeader={panel.isLeader}
          groupType={panel.groupType}
          typeLabels={GROUP_TYPE_LABEL}
          typeChangeBlockers={panel.typeChangeBlockers}
          link={
            panel.link ? { opportunityId: panel.link.opportunityId, name: panel.link.name, withdrawn: panel.link.status === 'withdrawn' } : null
          }
          linkable={panel.linkable.map((o) => ({ id: o.id, name: opportunityName(o), ownerName: o.ownerName }))}
          preselect={typeof preselect === 'string' ? preselect : null}
          requestIds={{ link: randomUUID(), type: randomUUID() }}
          reasonMaxLength={CHANGE_REASON_MAX_LENGTH}
        />
      ) : null}

      <Panel title="找組員" icon={<IconUsers />} description="只顯示本人開啟公開的同屆未分組學生">
        {view.group ? null : (
          <div className="border-b border-border/70 px-5 pb-3">
            <OpenToJoinToggle open={view.openToJoin} requestId={randomUUID()} />
          </div>
        )}
        <section aria-label="找組員名單">
          {teammates.length === 0 ? (
            <PanelEmpty icon={<IconUserPlus />} title="目前沒有公開找組員的同學。" />
          ) : (
            <ul className="divide-y divide-border">
              {teammates.map((t) => (
                <li key={t.studentNo} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 text-sm">
                  <span className="inline-flex size-9 items-center justify-center rounded-full bg-muted text-xs font-bold text-foreground" aria-hidden>
                    {t.name.slice(-2)}
                  </span>
                  <span className="font-semibold">{t.name}</span>
                  <span className="tabular text-xs text-muted-foreground">{t.studentNo}</span>
                  <a
                    href={`mailto:${t.contactEmail}`}
                    className="ml-auto inline-flex min-w-0 items-center gap-1 text-xs font-semibold text-ink hover:underline"
                  >
                    <IconMail className="size-3.5 shrink-0" aria-hidden />
                    <span className="truncate">{t.contactEmail}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
        <p className="border-t border-border/70 px-5 py-3 text-xs text-muted-foreground">
          只列出同屆、還沒分組、本人開啟公開的同學；只顯示姓名、學號與聯絡 Email，電話不公開。完成分組後會自動從名單消失。
        </p>
      </Panel>

      <Panel title="提案紀錄" icon={<IconHistory />}>
        <section aria-label="提案紀錄">
          {view.history.length === 0 ? (
            <p className="px-5 pb-4 text-sm text-muted-foreground">還沒有結束的提案。</p>
          ) : (
            <ul className="divide-y divide-border/70 border-t border-border/70">
              {view.history.map((p) => (
                <li key={p.id} className="px-5 py-3 text-sm">
                  <span className="tabular text-xs text-muted-foreground">{p.closedBusinessAt ? formatTaipeiMinute(p.closedBusinessAt) : ''}</span>
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
      </Panel>
    </>,
  )
}

/**
 * 一排組員頭像（原型 StudentGroup 的座位）：已確認＝深藍實心＋右下綠勾；待確認＝灰框；組長頭上橘色小標。
 * 每一位是 list 的一項（e2e 用「組員」清單找組長）。
 */
function Seats({ seats, label }: { seats: Seat[]; label: string }) {
  return (
    <ol aria-label={label} className={cn('grid gap-2 px-6 pt-7 pb-6 sm:gap-4', SEAT_COLS[seats.length] ?? 'grid-cols-5')}>
      {seats.map((m) => (
        <li key={m.key} className="flex min-w-0 flex-col items-center text-center">
          <span
            className={cn(
              'relative inline-flex size-14 items-center justify-center rounded-full text-[17px] font-bold sm:size-16',
              m.confirmed ? 'bg-ink text-ink-foreground' : 'border-2 border-border bg-muted text-muted-foreground',
            )}
          >
            <span aria-hidden>{m.name.slice(-2)}</span>
            {m.confirmed ? (
              <span
                className="absolute -right-0.5 -bottom-0.5 inline-flex size-5 items-center justify-center rounded-full bg-success text-success-foreground ring-2 ring-card"
                aria-hidden
              >
                <IconCheck className="size-3" strokeWidth={3} />
              </span>
            ) : null}
            {m.leader ? (
              <span className="absolute -top-1.5 left-1/2 -translate-x-1/2 rounded-full bg-brand px-1.5 text-[10px] font-bold whitespace-nowrap text-brand-foreground ring-2 ring-card">
                組長
              </span>
            ) : null}
          </span>
          <span className={cn('mt-2 max-w-full truncate text-sm', m.me ? 'font-bold' : 'font-medium')}>
            {m.name}
            {m.me ? <span className="sr-only">（你）</span> : null}
          </span>
          <span className="tabular max-w-full truncate text-[11px] text-muted-foreground">
            {m.sub}
            {m.note ? `・${m.note}` : ''}
          </span>
        </li>
      ))}
    </ol>
  )
}
