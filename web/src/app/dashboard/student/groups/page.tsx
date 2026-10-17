import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import { IconCheck, IconCrown, IconHistory, IconLock, IconMail, IconUserPlus, IconUsers } from '@tabler/icons-react'
import { UserAvatar } from '@/app/_ui/avatar/user-avatar'
import { PageTitle, Panel, PanelEmpty, Pill } from '@/app/_ui/dashboard-primitives'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { EmptyState } from '@/app/_ui/primitives'
import { STUDENT_NAV } from '@/app/dashboard/_nav'
import { studentItems } from '@/app/dashboard/student/_todo/todos'
import {
  OpenToJoinToggle,
  ProposalActions,
  ProposeForm,
  type MyProposalRole,
} from '@/app/dashboard/student/groups/group-forms'
import { groupMilestones } from '@/app/dashboard/student/groups/milestones'
import type { AvatarUser } from '@/application/accounts'
import type { GroupMember, ProposalSummary } from '@/application/groups'
import {
  cohortLabel,
  describeGroupSize,
  getBusinessClock,
  getCohortStatusQuery,
  getTimelineQuery,
  groupingDeadline,
} from '@/composition/cohorts'
import {
  describeGroupHistory,
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

export const metadata = { title: '組別｜資管系專題平台' }

const BASE = '/dashboard/student/groups'

/** 三個分頁（學生規格 §3.6）：我的組｜找隊員｜紀錄。已成組預設「我的組」，還沒成組預設「找隊員」。 */
type Tab = 'mine' | 'team' | 'log'
const TABS: readonly (readonly [Tab, string])[] = [
  ['mine', '我的組'],
  ['team', '找隊員'],
  ['log', '紀錄'],
]
const isTab = (value: unknown): value is Tab => value === 'mine' || value === 'team' || value === 'log'

/** 座位格的欄數（Tailwind 要看得到完整的 class 名稱，所以列出來）。 */
const SEAT_COLS: Record<number, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-2',
  3: 'grid-cols-3',
  4: 'grid-cols-4',
  5: 'grid-cols-5',
}

/** 一個座位：姓名、學號（同名同學分得出來）、狀態一行。 */
type Seat = {
  key: string
  name: string
  studentNo: string
  state: string
  confirmed: boolean
  leader: boolean
  me: boolean
  /** 已成組的組員才有；提案邀請（還沒成組）沒有，維持姓名首字占位。 */
  avatar?: AvatarUser
}

/**
 * 學生「組別」（票 13；學生規格 §3.6 ST-5）。
 *
 * 頁首一張卡寫「G07・一般專題」與一句摘要，底下三個分頁（`?tab=`，連結、不用 client state）：
 * - 我的組：組員頭像格（組長戴冠冕）、指導老師卡（聯絡 Email 直接列）、里程碑線。
 * - 找隊員：還沒成組時是提案狀態卡或發起提案表單、公開找組員開關與名單；已成組只一行說名單在「我的組」。
 * - 紀錄：組別異動與提案紀錄，兩段分開（Q129）。
 *
 * 「我的組別狀態」這一張卡在「我的組」（已成組）與「找隊員」（還沒成組）擺在同一個位置、底下掛同一個動作列：
 * 最後一位按確認的那一刻預設分頁從找隊員翻成我的組，剛剛那句「組別成立了」的回饋還留著。
 */
export default async function StudentGroupsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string | string[] }>
}) {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  const actor = await requireRole('/dashboard/student/groups', 'student')
  const userId = actor.kind === 'authenticated' ? actor.userId : ''
  const cohortId = studentCohortOf(actor)
  const params = await searchParams
  const requested = isTab(params.tab) ? params.tab : null

  const shell = (tab: Tab, header: React.ReactNode, children: React.ReactNode) => (
    <DashboardShell roleLabel="學生" items={STUDENT_NAV} current="/dashboard/student/groups">
      <div className="flex flex-col gap-5">
        <PageTitle title="組別" />
        {header}
        <nav aria-label="組別分頁" className="-mt-1 flex gap-1 border-b border-border">
          {TABS.map(([key, label]) => (
            <Link
              key={key}
              href={`${BASE}?tab=${key}`}
              aria-current={tab === key ? 'page' : undefined}
              className={cn(
                '-mb-px inline-flex h-11 items-center border-b-2 px-4 text-sm font-semibold transition-colors',
                tab === key ? 'border-brand text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {label}
            </Link>
          ))}
        </nav>
        {children}
      </div>
    </DashboardShell>
  )

  const cohort = cohortId ? await getCohortStatusQuery().get(cohortId) : null
  if (!cohortId || !cohort) {
    return shell(
      requested ?? 'team',
      null,
      <EmptyState title="你還沒有歸屬的屆別" description="帳號核准並歸到某一屆之後，才能找組員與發起提案。" />,
    )
  }

  const groupQuery = getGroupQuery()
  // 組別異動只有「紀錄」分頁讀（共用 SH-P4 的 `history`）；沒指定分頁時預設是我的組或找隊員，也不讀。
  const [view, businessNow] = await Promise.all([
    groupQuery.studentView(userId, cohortId, { history: requested === 'log' }),
    getBusinessClock().now(),
  ])
  const group = view.group
  const tab: Tab = requested ?? (group ? 'mine' : 'team')
  const proposal = view.openProposal

  // 每個分頁只查自己要的：名單只在找隊員（還沒成組）、里程碑只在我的組（已成組）。
  const [teammates, items, schedule] = await Promise.all([
    tab === 'team' && !group ? groupQuery.teammates(actor, cohortId) : null,
    tab === 'mine' && group ? studentItems(userId) : null,
    tab === 'team' && !group && !proposal ? getTimelineQuery().schedule(cohortId) : null,
  ])
  // 還沒分組也沒有提案：分組期已過就不給表單，只說「分組期已經結束」（Q69：不寫「請聯絡系辦」）。
  const deadline = schedule ? groupingDeadline(schedule) : null
  const groupingClosed = deadline !== null && businessNow.getTime() >= deadline.getTime()

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

  const header = (
    <div className="dash-card px-6 py-4">
      <p className="tabular text-xs font-bold tracking-[0.06em] text-muted-foreground">{cohortLabel(cohort)}</p>
      <p className="mt-1 text-[20px] font-extrabold tracking-tight">
        {group ? `${group.code}・${GROUP_TYPE_LABEL[group.groupType]}` : proposal ? `組隊中・${GROUP_TYPE_LABEL[proposal.groupType]}` : '還沒分組'}
      </p>
      {group || proposal || groupingClosed ? (
        <p className="tabular mt-0.5 text-sm text-muted-foreground">
          {group
            ? `已成組・${group.members.length} 人`
            : proposal
              ? `提案中・${confirmedCount}／${proposal.invitations.length} 已確認`
              : '分組期已經結束'}
        </p>
      ) : null}
    </div>
  )

  // 成組的那份提案（後來才被系辦加進組的人沒有）：里程碑的「發起提案」。
  const established = group ? view.history.find((p) => p.state === 'established' && p.establishedGroupCode === group.code) : undefined
  const milestones =
    group && items
      ? groupMilestones({
          proposedAt: established?.createdBusinessAt ?? null,
          establishedAt: group.establishedBusinessAt,
          rows: items[0],
          now: items[1],
        })
      : []

  const statusCard =
    (tab === 'mine' && group) || (tab === 'team' && !group) ? (
      <section aria-label="我的組別狀態" className="dash-card overflow-hidden">
        {group ? (
          <>
            <div className="flex flex-wrap items-start justify-between gap-4 px-6 pt-6">
              <div className="min-w-0">
                <h2 className="tabular text-[17px] font-extrabold tracking-tight">組員（{group.members.length} 人）</h2>
                <p className="tabular mt-1 text-sm text-muted-foreground">
                  組別 {group.code} 已成組・{formatTaipeiMinute(group.establishedBusinessAt)}
                </p>
              </div>
              <Pill tone="success" className="text-xs">
                已成組
              </Pill>
            </div>
            <Seats seats={memberSeats(group.members, userId)} label="組員" />
            <div data-testid="my-advisor" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/70 px-6 py-4 text-sm">
              <span className="text-xs font-bold tracking-[0.06em] text-muted-foreground">指導老師</span>
              {group.advisor ? (
                <>
                  <span className="font-semibold">{group.advisor.teacherName} 老師</span>
                  {group.advisor.contactEmail ? (
                    <a
                      href={`mailto:${group.advisor.contactEmail}`}
                      className="inline-flex min-w-0 items-center gap-1 font-semibold text-ink hover:underline"
                    >
                      <IconMail className="size-4 shrink-0" aria-hidden />
                      <span className="truncate">{group.advisor.contactEmail}</span>
                    </a>
                  ) : null}
                </>
              ) : (
                <span className="text-muted-foreground">還沒有指導老師</span>
              )}
            </div>
            <ol aria-label="里程碑" className="flex flex-wrap gap-x-6 gap-y-3 border-t border-border/70 px-6 py-4 text-sm">
              {milestones.map((m) => (
                <li key={m.key} className="flex min-w-0 items-center gap-2">
                  <span
                    className={cn(
                      'inline-flex size-6 shrink-0 items-center justify-center rounded-full',
                      m.done ? 'bg-success text-success-foreground' : 'bg-muted text-muted-foreground',
                    )}
                    aria-hidden
                  >
                    {m.done ? <IconCheck className="size-3.5" strokeWidth={3} /> : <IconLock className="size-3.5" />}
                  </span>
                  <span className="sr-only">{m.done ? '已完成' : '還沒到'}</span>
                  <span className={cn('truncate', m.done ? 'font-semibold' : 'text-muted-foreground')}>{m.label}</span>
                  <span className="tabular text-xs text-muted-foreground">{m.when}</span>
                </li>
              ))}
            </ol>
          </>
        ) : proposal ? (
          <>
            <div className="flex flex-wrap items-start justify-between gap-4 px-6 pt-6">
              <div className="min-w-0">
                <p className="tabular text-xs font-bold tracking-[0.06em] text-muted-foreground">
                  {cohortLabel(cohort)}・{GROUP_TYPE_LABEL[proposal.groupType]}・提案人 {proposal.proposerName}
                </p>
                <h2 className="mt-1 text-[24px] font-extrabold tracking-tight">組隊中（等全員確認）</h2>
                <p className="tabular mt-1 text-sm text-muted-foreground">
                  到期時間 {formatTaipeiMinute(proposal.expiresBusinessAt)}
                  {overdue ? '（已過期，這次組隊不會成立，大家都可以重新組隊）' : '；到期前沒全員確認，這次組隊就不會成立。'}
                </p>
              </div>
              <Pill tone="brand" className="text-xs">
                成立中・還差 {proposal.invitations.length - confirmedCount} 人確認
              </Pill>
            </div>
            <Seats seats={proposalSeats(proposal, userId)} label="提案成員" />
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/70 px-6 py-3 text-xs text-muted-foreground">
              <span className="tabular font-semibold text-foreground">
                {confirmedCount}／{proposal.invitations.length} 已確認
              </span>
              <span>・每個人用自己的帳號按確認；全員確認後組別成立。組隊中不能改名單或類型，要改請撤回後重新發起。</span>
            </div>
          </>
        ) : groupingClosed ? (
          <div className="px-6 pt-6 pb-2">
            <h2 className="text-[15px] font-bold">分組期已經結束</h2>
            <p className="tabular mt-1 mb-4 text-[13px] text-muted-foreground">{formatTaipeiMinute(deadline!)} 截止，不能再發起提案。</p>
          </div>
        ) : (
          <div className="px-6 pt-6 pb-2">
            <h2 className="text-[15px] font-bold">發起提案</h2>
            <p className="mt-1 mb-4 text-[13px] text-muted-foreground">
              本屆{size}（含你自己）。送出後所有人都會收到邀請，並暫時不能接受其他邀請，要在 {cohort.proposalDefaultDays} 天內全員確認，而且不能超過分組期（組隊、選指導老師、交提案的期間）。
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
    ) : null

  return shell(
    tab,
    header,
    <>
      {statusCard}

      {tab === 'mine' && !group ? (
        <div className="dash-card">
          <PanelEmpty
            icon={<IconUsers />}
            title="還沒有組別"
            action={
              <Link href={`${BASE}?tab=team`} className="text-sm font-semibold text-ink hover:underline">
                到「找隊員」
              </Link>
            }
          />
        </div>
      ) : null}

      {tab === 'team' && group ? (
        <div className="dash-card">
          <PanelEmpty
            icon={<IconUsers />}
            title="組別已成立，名單在「我的組」"
            action={
              <Link href={`${BASE}?tab=mine`} className="text-sm font-semibold text-ink hover:underline">
                看我的組
              </Link>
            }
          />
        </div>
      ) : null}

      {tab === 'team' && !group && teammates ? (
        <Panel title="找組員" icon={<IconUsers />} description="只顯示本人開啟公開的同屆未分組學生">
          <div className="border-b border-border/70 px-5 pb-3">
            <OpenToJoinToggle open={view.openToJoin} requestId={randomUUID()} />
          </div>
          <section aria-label="找組員名單">
            {teammates.length === 0 ? (
              <PanelEmpty icon={<IconUserPlus />} title="目前沒有公開找組員的同學" />
            ) : (
              <ul className="divide-y divide-border">
                {teammates.map((t) => (
                  <li key={t.studentNo} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 text-sm">
                    <span className="inline-flex size-9 items-center justify-center rounded-full bg-muted text-xs font-bold text-foreground" aria-hidden>
                      {t.name.slice(0, 1)}
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
      ) : null}

      {tab === 'log' && group ? (
        <Panel title="組別異動" icon={<IconHistory />}>
          {group.history.length === 0 ? (
            <p className="px-5 pb-4 text-sm text-muted-foreground">成組之後還沒有異動。</p>
          ) : (
            <ol aria-label="組別異動" className="flex flex-col gap-1 border-t border-border/70 px-5 py-3 text-sm">
              {group.history.map((h, index) => (
                <li key={index}>
                  <span className="tabular mr-2 text-xs text-muted-foreground">{formatTaipeiMinute(h.at)}</span>
                  {describeGroupHistory(h)}
                </li>
              ))}
            </ol>
          )}
        </Panel>
      ) : null}

      {tab === 'log' ? (
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
                        : `沒有成立：${p.terminationKind ? TERMINATION_KIND_LABEL[p.terminationKind] : ''}`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </Panel>
      ) : null}
    </>,
  )
}

function memberSeats(members: readonly GroupMember[], userId: string): Seat[] {
  return members.map((m) => ({
    key: m.userId,
    name: m.name,
    studentNo: m.studentNo ?? '',
    state: m.isLeader ? '組長' : '組員',
    confirmed: true,
    leader: m.isLeader,
    me: m.userId === userId,
    avatar: { id: m.userId, name: m.name, avatarPreset: m.avatarPreset ?? null, avatarFileId: m.avatarFileId ?? null },
  }))
}

function proposalSeats(proposal: ProposalSummary, userId: string): Seat[] {
  return proposal.invitations.map((i) => ({
    key: i.userId,
    name: i.name,
    studentNo: i.studentNo ?? '',
    state: `${INVITATION_STATE_LABEL[i.state]}${i.userId === proposal.proposerUserId ? '・提案人' : ''}`,
    confirmed: i.state === 'confirmed',
    leader: false,
    me: i.userId === userId,
  }))
}

/**
 * 一排組員頭像（原型 StudentGroup 的座位）：已確認＝深藍實心＋右下綠勾；待確認＝灰框；組長頭上戴冠冕。
 * 已成組的組員顯示頭像（ST-12），提案邀請還沒成組，先用姓名首字的圓形占位。每一位是 list 的一項（e2e 用「組員」清單找組長）。
 */
function Seats({ seats, label }: { seats: Seat[]; label: string }) {
  return (
    // 五人以內照原型一排；本屆設定超過五人（最多 10）時換行，390 寬才不會被頭像撐出去。
    <ol
      aria-label={label}
      className={cn('grid gap-2 px-6 pt-7 pb-6 sm:gap-4', seats.length <= 5 ? SEAT_COLS[seats.length] : 'grid-cols-4 sm:grid-cols-5')}
    >
      {seats.map((m) => (
        <li key={m.key} className="flex min-w-0 flex-col items-center text-center">
          <span
            className={cn(
              'relative inline-flex size-14 items-center justify-center rounded-full text-[19px] font-bold sm:size-16',
              m.confirmed ? 'bg-ink text-ink-foreground' : 'border-2 border-border bg-muted text-muted-foreground',
            )}
          >
            {m.avatar ? (
              <UserAvatar user={m.avatar} size={32} decorative />
            ) : (
              <span aria-hidden>{m.name.slice(0, 1)}</span>
            )}
            {m.confirmed ? (
              <span
                className="absolute -right-0.5 -bottom-0.5 inline-flex size-5 items-center justify-center rounded-full bg-success text-success-foreground ring-2 ring-card"
                aria-hidden
              >
                <IconCheck className="size-3" strokeWidth={3} />
              </span>
            ) : null}
            {m.leader ? (
              <span
                className="absolute -top-2.5 left-1/2 inline-flex size-6 -translate-x-1/2 items-center justify-center rounded-full bg-brand text-brand-foreground ring-2 ring-card"
                aria-hidden
              >
                <IconCrown className="size-3.5" strokeWidth={2.5} />
              </span>
            ) : null}
          </span>
          <span className={cn('mt-2 max-w-full truncate text-sm', m.me ? 'font-bold' : 'font-medium')}>
            {m.name}
            {m.me ? <span className="sr-only">（你）</span> : null}
          </span>
          {m.studentNo ? <span className="tabular max-w-full truncate text-[11px] text-muted-foreground">{m.studentNo}</span> : null}
          <span className={cn('max-w-full truncate text-[11px]', m.leader ? 'font-bold text-foreground' : 'text-muted-foreground')}>{m.state}</span>
        </li>
      ))}
    </ol>
  )
}
