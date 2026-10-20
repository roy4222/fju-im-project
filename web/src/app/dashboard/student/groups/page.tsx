import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import { IconBriefcase, IconCheck, IconCrown, IconHistory, IconLock, IconMail, IconSearch, IconUserPlus, IconUsers } from '@tabler/icons-react'
import { ProfileCardEditor } from '@/app/account/profile-card/profile-card-section'
import { AvatarImg } from '@/app/_ui/avatar/avatar-img'
import { ProfileCard } from '@/app/_ui/profile-card/profile-card'
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
  RequestOpportunityForm,
  type MyProposalRole,
  type OpportunityOption,
} from '@/app/dashboard/student/groups/group-forms'
import { groupMilestones } from '@/app/dashboard/student/groups/milestones'
import type { AvatarUser } from '@/application/accounts'
import type { GroupMember, OpportunityCard, ProposalSummary, StudentGroupView } from '@/application/groups'
import { getProfileCardQuery } from '@/composition/accounts'
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
  getOpportunityQuery,
  GROUP_TYPE_LABEL,
  GROUP_TYPES,
  INVITATION_STATE_LABEL,
  opportunityName,
  STUDENT_NO_MAX_LENGTH,
  studentCohortOf,
  TERMINATION_KIND_LABEL,
} from '@/composition/groups'
import { cn } from '@/shared/cn'
import { formatTaipeiMinute } from '@/shared/time'

export const metadata = { title: '組別｜資管系專題平台' }

const BASE = '/dashboard/student/groups'

/**
 * 兩個分頁（規格③ §5.1）：我的組｜找隊員。預設一律「我的組」（沒分組時那裡就是建立組別）。
 * 舊的 `?tab=log` 當成「我的組」（紀錄搬到它最下方；不轉址，`pages.spec` 要直接 200）。
 */
type Tab = 'mine' | 'team'
const TABS: readonly (readonly [Tab, string])[] = [
  ['mine', '我的組'],
  ['team', '找隊員'],
]
function tabOf(value: unknown): Tab | null {
  if (value === 'mine' || value === 'log') return 'mine'
  if (value === 'team') return 'team'
  return null
}

/** 類型卡底下的一句說明（模擬圖「我的組-建立組別」）。 */
const GROUP_TYPE_HINT: Record<string, string> = {
  general: '題目自訂，指導老師由系辦指派',
  industry: '選一個合作案，由負責老師確認是否指導',
}

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
  /** 組員與邀請都有（C3-02）：有上傳是照片、沒上傳是預設圖，不再有姓名首字占位。 */
  avatar: AvatarUser
}

/**
 * 學生「組別」（票 13；學生規格 §3.6 ST-5；C3-11 規格③ §5）。
 *
 * 頁首一張卡寫「G07・一般專題」與一句摘要，底下兩個分頁（`?tab=`，連結、不用 client state）：
 * - 我的組：沒分組時是「建立組別」表單（右欄「邀請進度」三步）或建立中的狀態卡；已成組是組員頭像格（組長戴冠冕）、
 *   指導老師卡、產學組的合作案一行（組長可以選案）、里程碑線。最下方「紀錄」區塊：組別異動（已成組才有）＋建立組別紀錄。
 * - 找隊員：公開找隊員開關、「編輯我的名片」與名片卡格（搜尋、技能篩選、「邀請加入」＝把學號預填進建立組別表單）；
 *   已成組只一行說名單在「我的組」。
 *
 * 「我的組別狀態」這一張卡一直在「我的組」同一個位置、底下掛同一個動作列：最後一位按確認的那一刻卡片從建立中翻成已成組，
 * 剛剛那句「組別成立了」的回饋還留著。
 */
export default async function StudentGroupsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string | string[]; q?: string | string[]; skill?: string | string[]; invite?: string | string[] }>
}) {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  const actor = await requireRole('/dashboard/student/groups', 'student')
  const userId = actor.kind === 'authenticated' ? actor.userId : ''
  const cohortId = studentCohortOf(actor)
  const params = await searchParams
  const tab: Tab = tabOf(params.tab) ?? 'mine'

  const shell = (header: React.ReactNode, children: React.ReactNode) => (
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
    return shell(null, <EmptyState title="你還沒有歸屬的屆別" description="帳號核准並歸到某一屆之後，才能找隊員與建立組別。" />)
  }

  const groupQuery = getGroupQuery()
  // 組別異動在「我的組」最下方的「紀錄」區塊（共用 SH-P4 的 `history`）；找隊員分頁不讀。沒有組別時 `history` 不會多查。
  const [view, businessNow] = await Promise.all([
    groupQuery.studentView(userId, cohortId, { history: tab === 'mine' }),
    getBusinessClock().now(),
  ])
  const group = view.group
  const proposal = view.openProposal

  // 找隊員的搜尋與技能篩選在伺服器（`?q=`、`?skill=`，C3 §4.4）；`?invite=` 是按過「邀請加入」的學號清單（建立組別表單的初值）。
  const q = typeof params.q === 'string' ? params.q.trim() : ''
  const skill = typeof params.skill === 'string' ? params.skill.trim() : ''
  const invited = typeof params.invite === 'string' ? params.invite.split(',').map((no) => no.trim()).filter(Boolean) : []

  // 哪些情況要列已發布的合作案：沒分組、沒有建立中的組別（建立組別表單要）；或已成組的產學組目前沒有合作案（組長要重選）。
  const isLeader = group?.members.some((m) => m.userId === userId && m.isLeader) ?? false
  const formShown = tab === 'mine' && !group && !proposal
  const canPickOpportunity = tab === 'mine' && !!group && group.groupType === 'industry' && !view.link && isLeader

  // 每個分頁只查自己要的：名單只在找隊員（還沒成組）、自己的名片在找隊員與建立組別表單、里程碑只在我的組（已成組）。
  const [teammates, items, schedule, myCard, opportunities] = await Promise.all([
    tab === 'team' && !group ? groupQuery.teammates(actor, cohortId, { q, skill }) : null,
    tab === 'mine' && group ? studentItems(userId) : null,
    formShown ? getTimelineQuery().schedule(cohortId) : null,
    tab === 'team' || formShown ? getProfileCardQuery().mine(actor) : null,
    formShown || canPickOpportunity ? getOpportunityQuery().list(actor) : null,
  ])
  // 還沒分組也沒有建立中的組別：分組期已過就不給表單，只說「分組期已經結束」（Q69：不寫「請聯絡系辦」）。
  const deadline = schedule ? groupingDeadline(schedule) : null
  const groupingClosed = deadline !== null && businessNow.getTime() >= deadline.getTime()
  const opportunityOptions: OpportunityOption[] = (opportunities ?? []).map((o: OpportunityCard) => ({
    value: o.id,
    label: `${opportunityName(o)}・${o.ownerName} 老師`,
  }))

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
        {group ? `${group.code}・${GROUP_TYPE_LABEL[group.groupType]}` : proposal ? `建立中・${GROUP_TYPE_LABEL[proposal.groupType]}` : '還沒分組'}
      </p>
      {group || proposal || groupingClosed ? (
        <p className="tabular mt-0.5 text-sm text-muted-foreground">
          {group
            ? `已成組・${group.members.length} 人`
            : proposal
              ? `等全員確認・${confirmedCount}／${proposal.invitations.length} 已確認`
              : '分組期已經結束'}
        </p>
      ) : null}
    </div>
  )

  // 成組的那份建立紀錄（後來才被系辦加進組的人沒有）：里程碑的「建立組別」。
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
    tab === 'mine' ? (
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
                  <span className="inline-flex items-center gap-2">
                    <AvatarImg
                      user={{
                        id: group.advisor.teacherUserId,
                        name: group.advisor.teacherName,
                        avatarPreset: group.advisor.avatarPreset,
                        avatarFileId: group.advisor.avatarFileId,
                      }}
                      size={24}
                      decorative
                    />
                    <span className="font-semibold">{group.advisor.teacherName} 老師</span>
                  </span>
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
            {group.groupType === 'industry' ? (
              <OpportunityRow
                link={view.link}
                picker={
                  canPickOpportunity ? (
                    <RequestOpportunityForm groupId={group.id} revision={group.revision} requestId={randomUUID()} opportunities={opportunityOptions} />
                  ) : null
                }
              />
            ) : null}
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
                  {cohortLabel(cohort)}・{GROUP_TYPE_LABEL[proposal.groupType]}・發起人 {proposal.proposerName}
                </p>
                <h2 className="mt-1 text-[24px] font-extrabold tracking-tight">建立中（等全員確認）</h2>
                <p className="tabular mt-1 text-sm text-muted-foreground">
                  到期時間 {formatTaipeiMinute(proposal.expiresBusinessAt)}
                  {overdue ? '（已過期，這次建立組別不會成立，大家都可以重新組隊）' : '；到期前沒全員確認，這次建立組別就不會成立。'}
                </p>
                {proposal.opportunity ? (
                  <p className="mt-1 text-sm">
                    合作案：{proposal.opportunity.name}（{proposal.opportunity.ownerTeacherName} 老師）・成立後等老師確認
                  </p>
                ) : null}
              </div>
              <Pill tone="brand" className="text-xs">
                成立中・還差 {proposal.invitations.length - confirmedCount} 人確認
              </Pill>
            </div>
            <Seats seats={proposalSeats(proposal, userId)} label="成員" />
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/70 px-6 py-3 text-xs text-muted-foreground">
              <span className="tabular font-semibold text-foreground">
                {confirmedCount}／{proposal.invitations.length} 已確認
              </span>
              <span>・每個人用自己的帳號按確認；全員確認後組別成立。建立中不能改名單或類型，要改請撤回後重新建立。</span>
            </div>
          </>
        ) : groupingClosed ? (
          <div className="px-6 pt-6 pb-2">
            <h2 className="text-[15px] font-bold">分組期已經結束</h2>
            <p className="tabular mt-1 mb-4 text-[13px] text-muted-foreground">{formatTaipeiMinute(deadline!)} 截止，不能再建立組別。</p>
          </div>
        ) : (
          <div className="px-6 pt-6 pb-2">
            <h2 className="text-[15px] font-bold">建立組別</h2>
            <p className="mt-1 mb-4 text-[13px] text-muted-foreground">
              本屆{size}（含你自己）。送出後每位同學會收到通知，全員按確認後組別成立；要在 {cohort.proposalDefaultDays} 天內全員確認，而且不能超過分組期（組隊、選指導老師、交提案的期間）。
            </p>
            {/* `key`：從找隊員再按一次「邀請加入」回來時清單變了，整張表單重掛、預填跟著更新（defaultValue 規則）。 */}
            <ProposeForm
              key={invited.join(',')}
              requestId={randomUUID()}
              otherSlots={cohort.groupSizeMax - 1}
              requiredOthers={cohort.groupSizeMin - 1}
              groupTypes={GROUP_TYPES.map((value) => ({ value, label: GROUP_TYPE_LABEL[value], hint: GROUP_TYPE_HINT[value] ?? '' }))}
              opportunities={opportunityOptions}
              studentNoMaxLength={STUDENT_NO_MAX_LENGTH}
              me={{
                name: myCard?.name ?? '',
                studentNo: myCard?.studentNo ?? '',
                avatar: { id: userId, name: myCard?.name ?? '', avatarPreset: myCard?.avatarPreset ?? null, avatarFileId: myCard?.avatarFileId ?? null },
              }}
              invite={invited.slice(0, cohort.groupSizeMax - 1)}
            />
          </div>
        )}
        {/* 動作列一直掛在同一個位置：組別成立或終止後按鈕消失，但剛剛那句回饋還在（沒有東西時是空的）。 */}
        <div key="proposal-actions" className="px-6 empty:hidden has-[*:not(:empty)]:pb-5">
          <ProposalActions proposal={role} requestIds={{ confirm: randomUUID(), terminate: randomUUID() }} />
        </div>
      </section>
    ) : null

  return shell(
    header,
    <>
      {formShown && !groupingClosed ? (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_17rem]">
          {statusCard}
          <InviteProgress />
        </div>
      ) : (
        statusCard
      )}

      {tab === 'team' && group ? (
        <div className="dash-card">
          <PanelEmpty
            icon={<IconUsers />}
            title="組別已成立，名單在「我的組」"
            action={
              <div className="flex flex-wrap items-center justify-center gap-3">
                <Link href={`${BASE}?tab=mine`} className="text-sm font-semibold text-ink hover:underline">
                  看我的組
                </Link>
                {/* 已成組也能改名片（之後的年度或換組用得到）；視窗裡的「公開找隊員」是 disabled（C3 §4.3）。 */}
                {myCard ? <ProfileCardEditor card={myCard} /> : null}
              </div>
            }
          />
        </div>
      ) : null}

      {tab === 'team' && !group && teammates ? (
        <Panel title="找隊員" icon={<IconUsers />} description="只顯示本人開啟公開的同屆未分組學生">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border/70 px-5 pb-3">
            <OpenToJoinToggle open={view.openToJoin} requestId={randomUUID()} />
            {myCard ? <ProfileCardEditor card={myCard} /> : null}
          </div>
          <TeammateFilters q={q} skill={skill} skills={teammateSkills(teammates, skill)} invited={invited} />
          <section aria-label="找隊員名單" className="px-5 py-4">
            {teammates.length === 0 ? (
              <PanelEmpty icon={<IconUserPlus />} title={q || skill ? '沒有符合條件的同學' : '目前沒有公開找隊員的同學'} />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {teammates.map((t) => {
                  const reason =
                    t.inviteDisabledReason ??
                    (!invited.includes(t.studentNo) && invited.length >= cohort.groupSizeMax - 1 ? '已經到每組人數上限' : null)
                  return (
                    <ProfileCard
                      key={t.studentNo}
                      card={t}
                      footer={
                        reason ? (
                          <div className="flex flex-wrap items-center gap-2">
                            <button type="button" disabled className={INVITE_BUTTON}>
                              邀請加入
                            </button>
                            <span className="text-xs text-muted-foreground">{reason}</span>
                          </div>
                        ) : (
                          <Link href={inviteHref(invited, t.studentNo)} className={INVITE_BUTTON}>
                            邀請加入
                          </Link>
                        )
                      }
                    />
                  )
                })}
              </div>
            )}
          </section>
          <p className="border-t border-border/70 px-5 py-3 text-xs text-muted-foreground">
            只列出同屆、還沒分組、本人開啟公開的同學；名片顯示姓名、學號、系級、自介、技能與聯絡 Email，電話不公開。完成分組後會自動從名單消失。
          </p>
        </Panel>
      ) : null}

      {tab === 'mine' ? <LogSection view={view} /> : null}
    </>,
  )
}

const INVITE_BUTTON =
  'btn-fju inline-flex h-9 items-center justify-center rounded-lg px-4 text-sm disabled:pointer-events-none disabled:opacity-60'
/** 技能膠囊最多幾個（C3 §4.4）。 */
const SKILL_CHIPS_MAX = 12

/** 「邀請加入」：跳到「我的組」並把學號累加在 `invite=` 逗號清單（建立組別表單的初值；送出後名單凍結，所以不是即時邀請）。 */
function inviteHref(invited: readonly string[], studentNo: string): string {
  const list = invited.includes(studentNo) ? invited : [...invited, studentNo]
  return `${BASE}?tab=mine&invite=${list.map(encodeURIComponent).join(',')}`
}

/** 技能膠囊：名單裡實際出現過的技能（出現順序），最多 12 個；目前選的那個一定在。 */
function teammateSkills(teammates: readonly { skills: readonly string[] }[], selected: string): string[] {
  const seen = new Set<string>(selected ? [selected] : [])
  for (const t of teammates) for (const s of t.skills) seen.add(s)
  return [...seen].slice(0, SKILL_CHIPS_MAX)
}

/** 右欄「邀請進度」三步（規格③ §5.2；純說明）。 */
function InviteProgress() {
  const steps: [string, string][] = [
    ['送出邀請', '填好同學的學號按「送出邀請」，每位同學都會收到通知。'],
    ['同學確認', '每位同學用自己的帳號按「確認加入」；有人拒絕或撤回，這次就不成立。'],
    ['組別成立', '全員確認的那一刻組別成立、拿到組別代碼，名單之後由系辦調整。'],
  ]
  return (
    <aside aria-label="邀請進度" className="dash-card px-6 py-5">
      <h2 className="text-[15px] font-bold">邀請進度</h2>
      <ol className="mt-3 flex flex-col gap-4">
        {steps.map(([title, body], index) => (
          <li key={title} className="flex gap-3">
            <span className="tabular inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-brand text-sm font-bold text-brand-foreground" aria-hidden>
              {index + 1}
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold">{title}</span>
              <span className="block text-xs text-muted-foreground">{body}</span>
            </span>
          </li>
        ))}
      </ol>
    </aside>
  )
}

/** 已成組的產學組「合作案」一行（規格③ §5.3、§7.3）：案名（負責老師）・待老師確認／已確認；沒有就「還沒有合作案」＋組長的選案表單。 */
function OpportunityRow({ link, picker }: { link: StudentGroupView['link']; picker: React.ReactNode }) {
  return (
    <div data-testid="my-opportunity" className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border/70 px-6 py-4 text-sm">
      <span className="inline-flex items-center gap-1 text-xs font-bold tracking-[0.06em] text-muted-foreground">
        <IconBriefcase className="size-4" aria-hidden />
        合作案
      </span>
      {link ? (
        <span>
          <span className="font-semibold">
            {link.name}（{link.ownerTeacherName} 老師）
          </span>
          ・{link.state === 'pending' ? '待老師確認' : '已確認'}
        </span>
      ) : (
        <>
          <span className="text-muted-foreground">還沒有合作案</span>
          {picker}
        </>
      )}
    </div>
  )
}

/** 「我的組」最下方的「紀錄」區塊（規格③ §5.1；AC-C3-13）：組別異動（已成組才有）＋建立組別紀錄，兩段分開（Q129）。 */
function LogSection({ view }: { view: StudentGroupView }) {
  const group = view.group
  return (
    <section aria-label="紀錄" className="flex flex-col gap-5">
      {group ? (
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
      <Panel title="建立組別紀錄" icon={<IconHistory />}>
        <section aria-label="建立組別紀錄">
          {view.history.length === 0 ? (
            <p className="px-5 pb-4 text-sm text-muted-foreground">還沒有結束的建立紀錄。</p>
          ) : (
            <ul className="divide-y divide-border/70 border-t border-border/70">
              {view.history.map((p) => (
                <li key={p.id} className="px-5 py-3 text-sm">
                  <span className="tabular text-xs text-muted-foreground">{p.closedBusinessAt ? formatTaipeiMinute(p.closedBusinessAt) : ''}</span>
                  <span className="ml-2">
                    {p.proposerName} 發起的{GROUP_TYPE_LABEL[p.groupType]}組別
                    {p.opportunity ? `（合作案：${p.opportunity.name}）` : ''}・
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
    </section>
  )
}

/** 找隊員的搜尋框（GET 表單，網址帶 `?q=`，保留目前的技能）與技能膠囊（連結，網址帶 `?skill=`；點膠囊換一個篩選、清掉搜尋字）。 */
function TeammateFilters({ q, skill, skills, invited }: { q: string; skill: string; skills: string[]; invited: string[] }) {
  const href = (next: { q?: string; skill?: string }) => {
    const params = new URLSearchParams({ tab: 'team' })
    if (next.q) params.set('q', next.q)
    if (next.skill) params.set('skill', next.skill)
    if (invited.length > 0) params.set('invite', invited.join(','))
    return `${BASE}?${params.toString()}`
  }
  const chip = (active: boolean) =>
    cn(
      'inline-flex h-8 items-center rounded-full border px-3 text-xs font-semibold transition-colors',
      active ? 'border-brand bg-brand text-brand-foreground' : 'border-border bg-background text-foreground hover:bg-muted',
    )
  return (
    <div className="flex flex-col gap-3 border-b border-border/70 px-5 py-3">
      <form action={BASE} method="get" role="search" className="flex gap-2">
        <input type="hidden" name="tab" value="team" />
        {skill ? <input type="hidden" name="skill" value={skill} /> : null}
        {invited.length > 0 ? <input type="hidden" name="invite" value={invited.join(',')} /> : null}
        <input
          type="search"
          name="q"
          defaultValue={q}
          aria-label="搜尋姓名、學號或技能"
          placeholder="搜尋姓名、學號或技能"
          className="h-10 w-full max-w-sm rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25"
        />
        <button type="submit" className="press inline-flex h-10 items-center gap-1 rounded-lg border border-border bg-background px-3 text-sm font-semibold hover:bg-muted">
          <IconSearch className="size-4" aria-hidden />
          搜尋
        </button>
      </form>
      <nav aria-label="技能篩選" className="flex flex-wrap gap-1.5">
        <Link href={href({})} aria-current={!skill ? 'page' : undefined} className={chip(!skill)}>
          全部
        </Link>
        {skills.map((s) => (
          <Link key={s} href={href({ skill: s })} aria-current={skill === s ? 'page' : undefined} className={chip(skill === s)}>
            {s}
          </Link>
        ))}
      </nav>
    </div>
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
    state: `${INVITATION_STATE_LABEL[i.state]}${i.userId === proposal.proposerUserId ? '・發起人' : ''}`,
    confirmed: i.state === 'confirmed',
    leader: false,
    me: i.userId === userId,
    avatar: { id: i.userId, name: i.name, avatarPreset: i.avatarPreset, avatarFileId: i.avatarFileId },
  }))
}

/**
 * 一排組員頭像（原型 StudentGroup 的座位）：已確認＝深藍實心＋右下綠勾；待確認＝灰框；組長頭上戴冠冕。
 * 組員與邀請都顯示頭像（ST-12、C3-02）。每一位是 list 的一項（e2e 用「組員」清單找組長）。
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
            <AvatarImg user={m.avatar} size={32} decorative />
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
