import type { ResolvedActor } from '@/application/accounts'
import type {
  AddMemberInput,
  ChangeLeaderInput,
  LeaderChangeReceipt,
  MemberChangeReceipt,
  RemoveMemberInput,
} from '@/application/groups/members'
import type {
  ConfirmReceipt,
  ExpireOutcome,
  GroupType,
  InvitationState,
  ProposalState,
  ProposeInput,
  ProposeReceipt,
  SetOpenToJoinReceipt,
  TeammateListing,
  TerminateReceipt,
  TerminationKind,
} from '@/application/groups/proposals'
import type { Result } from '@/shared/result'

/**
 * 模組 03 對外提供的 port（模組實作設計 03 §5 的 `GroupCommand`／`GroupMembershipQuery`，票 13 的部分）。
 *
 * 寫入的 port 自己做授權；查詢的 port 不做授權——呼叫它的頁面自己守門
 * （找組員名單例外：它回的是別人的聯絡資料，所以查詢本身也看 actor）。
 */

export interface GroupCommand {
  /** 本人開關「公開找組員」。已經在組裡的人不能打開（`ALREADY_MEMBER`）；關掉永遠可以。 */
  setOpenToJoin(actor: ResolvedActor, open: boolean, requestId: string): Promise<Result<SetOpenToJoinReceipt>>
  /**
   * 發起提案：自己＋其他組員的學號，人數要符合屆別設定。全員（含自己）被占住、各收一則邀請，
   * 排一件到期工作。有人已在組裡 `ALREADY_MEMBER`、被別的提案占住 `INVITED_ELSEWHERE`、
   * 成組期已過 `DEADLINE_PASSED`。
   */
  propose(actor: ResolvedActor, input: ProposeInput, requestId: string): Promise<Result<ProposeReceipt>>
  /** 本人確認。最後一位確認的那一筆交易裡組別成立、占用釋放、到期工作取消、全員收到成立通知。 */
  confirm(actor: ResolvedActor, proposalId: string, requestId: string): Promise<Result<ConfirmReceipt>>
  /** 被邀請者拒絕（提案人請用撤回提案）：整份終止、釋放全員。 */
  decline(actor: ResolvedActor, proposalId: string, requestId: string): Promise<Result<TerminateReceipt>>
  /** 已確認的普通成員在成立前撤回同意：整份終止、釋放全員。 */
  withdrawConfirmation(actor: ResolvedActor, proposalId: string, requestId: string): Promise<Result<TerminateReceipt>>
  /** 提案人撤回：整份終止、釋放全員。 */
  withdrawProposal(actor: ResolvedActor, proposalId: string, requestId: string): Promise<Result<TerminateReceipt>>
  /** 管理員作廢（理由必填；學生看到的通知不含理由）。 */
  voidProposal(
    actor: ResolvedActor,
    proposalId: string,
    reason: string,
    requestId: string,
  ): Promise<Result<TerminateReceipt>>

  // ── 管理員調整組員與換組長（票 14） ──
  // 共同規則：只有管理員；理由必填；帶組別版本（別人先改過 `CONFLICT`）；屆別封存 `COHORT_ARCHIVED`；
  // 已解散 `GROUP_DISSOLVED`。人數和設定不符只在回執裡提醒，不擋。

  /**
   * 把學生加入某組：同屆、已核准、未停用、沒有其他有效組別（`ALREADY_MEMBER`）。
   * 學生正在某份進行中提案裡 → `INVITED_ELSEWHERE`（**不**替他終止那份提案：請管理員先作廢，理由另填）。
   * 成員集合改變：發 `group.members_changed`（簽核模組的重簽掛點）。
   */
  addMember(actor: ResolvedActor, input: AddMemberInput, requestId: string): Promise<Result<MemberChangeReceipt>>
  /**
   * 從某組移出：移出最後一人要走解散（解散之後才開放，先拒絕）；移出組長要同時指定接任。
   * 被移出的人只收到本人的異動說明（`group.member_removed`），其他人收 `group.members_changed`。
   */
  removeMember(actor: ResolvedActor, input: RemoveMemberInput, requestId: string): Promise<Result<MemberChangeReceipt>>
  /** 換組長：新組長要是有效成員；全組收 `group.leader_changed`。成員集合沒變，不觸發重簽。 */
  changeLeader(actor: ResolvedActor, input: ChangeLeaderInput, requestId: string): Promise<Result<LeaderChangeReceipt>>
}

/**
 * `due_work(kind='proposal_expiry')` 的處理器（模組 08 §6 到期迴圈 → 03）。
 *
 * 由背景工作（票 12）在工作到期時呼叫；以 worker 身分終止，不經帳本（沒有使用者）。
 * 重跑安全：已經不是進行中的提案、或期限版本不符，都什麼都不做。
 */
export interface ProposalExpiryHandler {
  expire(proposalId: string, deadlineVersion: number): Promise<ExpireOutcome>
}

export type GroupMember = {
  readonly userId: string
  readonly name: string
  readonly studentNo: string | null
  readonly isLeader: boolean
}

/**
 * 組別歷程的一筆（票 14「組別頁看得到歷史」）：成立後的組員加入／移出、組長更換，舊的在前。
 * 事實（誰、何時）來自有效區間列 `group_memberships`／`group_leaders`。
 * `reason` 只在管理員的查詢裡帶，學生的查詢一律 null（和作廢理由同一政策）。
 */
export type GroupHistoryEntry = {
  readonly kind: 'member_added' | 'member_removed' | 'leader_changed'
  /** 業務時間。 */
  readonly at: Date
  /** 加入／移出的人，或新組長。 */
  readonly userName: string
  /** 換組長時的前任組長。 */
  readonly previousLeaderName: string | null
  /** 操作的管理員；學生的查詢一律 null。 */
  readonly byName: string | null
  readonly reason: string | null
}

export type GroupSummary = {
  readonly id: string
  readonly cohortId: string
  readonly code: string
  readonly groupType: GroupType
  readonly establishedBusinessAt: Date
  /** 樂觀鎖版本：管理員調整組員、換組長時帶回來。 */
  readonly revision: number
  readonly members: readonly GroupMember[]
  readonly history: readonly GroupHistoryEntry[]
}

export type ProposalInvitation = {
  readonly userId: string
  readonly name: string
  readonly studentNo: string | null
  readonly state: InvitationState
  /** 本人最後一次按確認／拒絕／撤回的時間。 */
  readonly decidedRealAt: Date | null
}

export type ProposalSummary = {
  readonly id: string
  readonly cohortId: string
  readonly groupType: GroupType
  readonly state: ProposalState
  readonly proposerUserId: string
  readonly proposerName: string
  readonly expiresBusinessAt: Date
  readonly createdBusinessAt: Date
  readonly closedBusinessAt: Date | null
  readonly terminationKind: TerminationKind | null
  /** 管理員作廢的理由：只在管理員的查詢裡帶，學生的查詢一律 null。 */
  readonly reason: string | null
  readonly establishedGroupCode: string | null
  readonly invitations: readonly ProposalInvitation[]
}

/** 學生「我的組別」一頁要的全部資料。 */
export type StudentGroupView = {
  readonly cohortId: string
  readonly group: GroupSummary | null
  readonly openProposal: ProposalSummary | null
  /** 我參與過、已經結束（成立或終止）的提案，新的在前。 */
  readonly history: readonly ProposalSummary[]
  readonly openToJoin: boolean
}

export type UngroupedStudent = {
  readonly name: string
  readonly studentNo: string
  readonly openToJoin: boolean
  /** 正被某個進行中提案占住。 */
  readonly inProposal: boolean
}

/** 管理員「分組總覽」。 */
export type CohortGroupingOverview = {
  readonly groups: readonly GroupSummary[]
  readonly openProposals: readonly ProposalSummary[]
  readonly closedProposals: readonly ProposalSummary[]
  readonly ungrouped: readonly UngroupedStudent[]
}

export interface GroupQuery {
  /** 學生本人的組別、進行中提案、歷史與找組員開關。沒有屆別的學生回 null。 */
  studentView(userId: string, cohortId: string): Promise<StudentGroupView>
  /**
   * 找組員名單：同屆、已核准、未停用、沒有有效組、本人開啟公開的學生，只回姓名、學號、聯絡 Email。
   * 看的人不是同屆學生、老師或管理員就回空的。自己不列在自己的名單裡。
   */
  teammates(actor: ResolvedActor, cohortId: string): Promise<TeammateListing[]>
  /** 管理員分組總覽（呼叫端守門）。 */
  overview(cohortId: string): Promise<CohortGroupingOverview>
}
