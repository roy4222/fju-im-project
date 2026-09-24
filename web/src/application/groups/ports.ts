import type { ResolvedActor } from '@/application/accounts'
import type {
  AdvisorBatchPreview,
  AdvisorBatchReceipt,
  AdvisorChangeReceipt,
  AdvisorInfo,
  AdvisorUploadTicket,
  AssignAdvisorInput,
  ClaimInput,
  ExecuteBatchInput,
  GradingAssignmentSummary,
  TeacherOption,
  UnassignAdvisorInput,
} from '@/application/groups/advisors'
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
 * 主指導的指派、認領與重派（票 19；模組實作設計 03 §5 `GroupCommand` 的 `assignAdvisor`、`reassignAdvisor`、
 * `unassignAdvisor`、`claimGroup`、`batchAssign`）。
 *
 * 共同規則：每組同時只有一位有效主指導（資料庫部分唯一）；每次變更都把組別版本加一（批次預覽、指派對話框
 * 帶這個版本，別人先改過就 `CONFLICT`）；屆別封存 `COHORT_ARCHIVED`；已解散 `GROUP_DISSOLVED`。
 * 首次指派或認領通知全組與新老師；重派另通知原老師；解除通知全組與原老師。沒有實際變更不發通知。
 */
export interface AdvisorCommand {
  /**
   * 老師認領「尚未指派的產學組」。一般組 `FORBIDDEN`（由系辦指派）；已經有主指導（含兩位同時搶、晚到的那位）
   * `ALREADY_CLAIMED`，訊息點名是誰先認領。
   */
  claim(actor: ResolvedActor, input: ClaimInput, requestId: string): Promise<Result<AdvisorChangeReceipt>>
  /** 管理員逐組指派；組別已經有別的主指導就是重派（結束舊的、插新的）。理由必填；同一位老師 `VALIDATION_FAILED`。 */
  assign(actor: ResolvedActor, input: AssignAdvisorInput, requestId: string): Promise<Result<AdvisorChangeReceipt>>
  /** 管理員解除主指導（理由必填）。 */
  unassign(actor: ResolvedActor, input: UnassignAdvisorInput, requestId: string): Promise<Result<AdvisorChangeReceipt>>
  /** 批次指派：拿一張只能傳 CSV 的上傳 ticket（共用檔案能力，同名單匯入）。 */
  startBatchUpload(
    actor: ResolvedActor,
    input: { fileName: string; declaredMime: string; declaredSize: number },
  ): Promise<Result<AdvisorUploadTicket>>
  /** 讀伺服器上的原檔，依所選屆別分成六類；不寫任何資料。 */
  previewBatch(actor: ResolvedActor, input: { fileId: string; cohortId: string }): Promise<Result<AdvisorBatchPreview>>
  /**
   * 重新分析同一份原檔後逐列執行（每列一個交易）。有錯誤列、沒填理由、有重派卻沒勾確認就整批不做；
   * 預覽之後被改過的組別（版本不符）那一列 `CONFLICT`、其他列照做。同一個請求編號重送不會重複指派或通知。
   */
  executeBatch(actor: ResolvedActor, input: ExecuteBatchInput, requestId: string): Promise<Result<AdvisorBatchReceipt>>
}

/**
 * 原老師在本組的評分指派（模組 06 `listAssignmentsForTeacher`；重派對話框要先列）。
 * 評分模組還沒做：composition 注入的實作永遠回空清單，等評分的票接上。
 */
export interface AdvisorGradingLookup {
  assignmentsFor(groupId: string, teacherUserId: string): Promise<readonly GradingAssignmentSummary[]>
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
  /** 票 19 加兩種：主指導指派（首次、認領或重派）與解除。 */
  readonly kind: 'member_added' | 'member_removed' | 'leader_changed' | 'advisor_assigned' | 'advisor_removed'
  /** 業務時間。 */
  readonly at: Date
  /** 加入／移出的人，或新組長。 */
  readonly userName: string
  /** 換組長時的前任組長。 */
  readonly previousLeaderName: string | null
  /** 重派時的原主指導（首次指派、解除是 null；解除的原老師放在 `userName`）。 */
  readonly previousAdvisorName: string | null
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
  /** 目前的主指導（票 19）；還沒指派是 null。 */
  readonly advisor: AdvisorInfo | null
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
  /**
   * 一屆已成立的組別、成員與主指導（老師的「分組」頁；所有老師都可查看一般與產學組別，呼叫端守門）。
   * 歷程不帶理由與操作者。
   */
  cohortGroups(cohortId: string): Promise<GroupSummary[]>
  /** 管理員指派對話框的老師選項：帳號正常、目前是老師。 */
  teacherOptions(): Promise<TeacherOption[]>
  /** 這位老師目前指導幾組（未封存的屆別）。 */
  advisedGroupCount(teacherUserId: string): Promise<number>
}
