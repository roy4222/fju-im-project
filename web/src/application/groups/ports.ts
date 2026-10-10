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
  DissolveGroupInput,
  DissolveReceipt,
  LeaderChangeReceipt,
  LeaderSuccession,
  LeadershipToSucceed,
  MemberChangeReceipt,
  RemoveMemberInput,
  SuccessorChoice,
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
import type {
  ChangeGroupTypeInput,
  CreateOpportunityInput,
  GroupOpportunityLink,
  GroupTypeReceipt,
  LinkOpportunityInput,
  LinkReceipt,
  ManagedOpportunity,
  OpportunityCard,
  OpportunityPage,
  OpportunityReceipt,
  OpportunityStatusInput,
  UnlinkOpportunityInput,
  UpdateOpportunityInput,
} from '@/application/groups/opportunities'
import type { RosterExportFormat, RosterExportRequest } from '@/application/groups/roster'
import type { Err, Result } from '@/shared/result'

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
   * 從某組移出：移出最後一人要走解散（`dissolveGroup`；這裡拒絕）；移出組長要同時指定接任。
   * 被移出的人只收到本人的異動說明（`group.member_removed`），其他人收 `group.members_changed`。
   */
  removeMember(actor: ResolvedActor, input: RemoveMemberInput, requestId: string): Promise<Result<MemberChangeReceipt>>
  /** 換組長：新組長要是有效成員；全組收 `group.leader_changed`。成員集合沒變，不觸發重簽。 */
  changeLeader(actor: ResolvedActor, input: ChangeLeaderInput, requestId: string): Promise<Result<LeaderChangeReceipt>>
  /**
   * 系辦解散組別（開站後，最小版；產品模組 03 §4「換成員與解散」、08 §4「組別解散」）。理由必填、帶組別版本。
   * 同一筆交易：記下組員快照與當下評分方案版本（`group.dissolve` 稽核 payload）、結束全部組員資格與組長列、
   * 結束該組有效評分指派並讓暫存失效（模組 06）、作廢目前簽核版本（模組 07）、組別標 dissolved；
   * 通知解散前有效成員、主指導、評分工作因此停止的老師（去重，每人一則）。之後這組任何寫入都回 `GROUP_DISSOLVED`。
   */
  dissolveGroup(actor: ResolvedActor, input: DissolveGroupInput, requestId: string): Promise<Result<DissolveReceipt>>
}

/**
 * 停用帳號時的組長接任（票 42；產品模組 03「組長」：移出或停用組長時要同時指定接任；GRP-18：否則不能完成操作）。
 *
 * 由模組 01 的停用用例呼叫（composition 注入，同 `SignoffParticipantHook` 的作法）；規則在 `decideDisableSuccession`。
 * 只看**屆別未封存、組別未解散**的組：封存屆的組別是唯讀的歷史，停用畢業生不需要接任。
 *
 * 鎖順序（跟管理員換組長／移出組員一致，不會互等成死結）：組別（屆別 FOR SHARE → 組別 FOR UPDATE）→ 帳號列。
 * 所以停用用例要先 `lockLeaderships` 再鎖帳號，鎖完帳號再 `succeed`（它會重讀一次，組長剛變過就 `CONFLICT`）。
 */
export interface LeaderSuccessionHook<Tx = unknown> {
  /** 停用對話框用（唯讀）：這個人目前擔任組長的組別，與每組可以接任的人。 */
  leadershipsOf(userId: string): Promise<readonly LeadershipToSucceed[]>
  /** 批次停用用（唯讀，可在呼叫端交易裡查）：名單裡哪些人目前是組長。 */
  leadersAmong(tx: Tx | null, userIds: readonly string[]): Promise<ReadonlySet<string>>
  /** 在呼叫端交易裡鎖住這個人目前擔任組長的組別（要在鎖帳號列之前呼叫）。 */
  lockLeaderships(tx: Tx, userId: string): Promise<void>
  /**
   * 在呼叫端交易裡完成接任：驗規則、結束舊組長列、插入新組長列、組別版本加一、通知全組（`group.leader_changed`）、
   * 稽核（`group.leader.change`，payload 標 `cause: 'account_disable'`）。只換組長，成員集合沒變，不重簽。
   * 不是組長又沒帶接任 → 回空陣列、什麼都不寫。
   */
  succeedOnDisable(
    tx: Tx,
    input: {
      readonly userId: string
      readonly choices: readonly SuccessorChoice[]
      readonly actorUserId: string
      /** 停用理由；寫進組長列與稽核，讓組別歷程看得出這次換組長是因為停用。 */
      readonly reason: string
      readonly realAt: Date
    },
  ): Promise<{ readonly ok: true; readonly successions: readonly LeaderSuccession[] } | Err>
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
 * 原老師在本組的評分指派（模組 06 `AssignmentsForTeacherQuery.listForGroup`；重派對話框要先列）。
 * composition 注入評分模組的查詢（票 23）。
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
  /**
   * 帳號登入信箱（票 20 C18「複製本組信箱」、匯出）。**只有管理員的查詢**（`overview`）填；
   * 學生與老師的查詢一律 null——同組學生看不到彼此的登入信箱（5.1 沒授權這件事）。
   */
  readonly loginEmail: string | null
}

/**
 * 組別歷程的一筆（票 14「組別頁看得到歷史」）：成立後的組員加入／移出、組長更換，舊的在前。
 * 事實（誰、何時）來自有效區間列 `group_memberships`／`group_leaders`。
 * `reason` 只在管理員的查詢裡帶，學生的查詢一律 null（和作廢理由同一政策）。
 */
export type GroupHistoryEntry = {
  /**
   * 票 19 加兩種：主指導指派（首次、認領或重派）與解除。
   * 票 20 加三種：組別類型變更、連結（首次或換案）合作案、解除合作案連結。
   */
  readonly kind:
    | 'member_added'
    | 'member_removed'
    | 'leader_changed'
    | 'advisor_assigned'
    | 'advisor_removed'
    | 'type_changed'
    | 'opportunity_linked'
    | 'opportunity_unlinked'
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
  /** 類型變更（票 20）：改之前、改之後；其他種類是 null。 */
  readonly groupTypes: { readonly from: GroupType; readonly to: GroupType } | null
  /** 換案（票 20）：原本的合作案名稱；首次連結與解除是 null（合作案名稱放在 `userName`）。 */
  readonly previousOpportunityName: string | null
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
  /** 目前連結的合作案（票 20；只帶公開欄位的名稱與狀態）；沒有連結是 null。 */
  readonly opportunity: GroupOpportunityLink | null
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

/** 已解散的組別（管理員分組總覽的唯讀清單；資料凍結，成績在成績頁查看與匯出）。 */
export type DissolvedGroupSummary = {
  readonly id: string
  readonly code: string
  readonly groupType: GroupType
  readonly dissolvedAt: Date
  readonly reason: string
  /** 解散當下的有效成員快照（組長標出）。 */
  readonly members: readonly { readonly name: string; readonly studentNo: string | null; readonly isLeader: boolean }[]
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
  /** 管理員分組總覽的「已解散的組別」（呼叫端守門）。新的在前。 */
  dissolvedGroups(cohortId: string): Promise<DissolvedGroupSummary[]>
  /** 管理員指派對話框的老師選項：帳號正常、目前是老師。 */
  teacherOptions(): Promise<TeacherOption[]>
  /** 這位老師目前指導幾組（未封存的屆別）。 */
  advisedGroupCount(teacherUserId: string): Promise<number>
}

// ── 產學合作案（票 20） ────────────────────────────────────────────────────────

/**
 * 合作案的建立、編輯、發布、下架、重新發布；組別連結、換案、解除；組別類型變更
 * （模組實作設計 03 §5 `OpportunityCommand`；產品 03 §4「5.3」「6.1–6.3」）。
 *
 * 共同規則：寫入的 port 自己做授權；帶版本（合作案或組別的 `revision`），別人先改過 `CONFLICT`；
 * 同一個請求編號重送只做一次（操作帳本）。
 */
export interface OpportunityCommand {
  /** 老師建立（案主＝本人）；可以直接發布或存草稿。管理員不建立（案主一定是老師）。 */
  create(actor: ResolvedActor, input: CreateOpportunityInput, requestId: string): Promise<Result<OpportunityReceipt>>
  /** 案主或系辦編輯。已下架的不能改（組員看到的是下架前發布的內容），要改先重新發布。 */
  update(actor: ResolvedActor, input: UpdateOpportunityInput, requestId: string): Promise<Result<OpportunityReceipt>>
  /** 發布草稿，或重新發布已下架的（不恢復以前解除的連結）。 */
  publish(actor: ResolvedActor, input: OpportunityStatusInput, requestId: string): Promise<Result<OpportunityReceipt>>
  /** 下架：列表不再顯示、不接受新連結；既有連結保留。 */
  withdraw(actor: ResolvedActor, input: OpportunityStatusInput, requestId: string): Promise<Result<OpportunityReceipt>>
  /**
   * 組長（或系辦）把已成立的產學組連結到已發布的合作案；已經連著別的就是換案（理由必填）。
   * 一般組、別人的組、未發布或已下架的案 `OPPORTUNITY_NOT_LINKABLE`／`FORBIDDEN`。
   * 換案通知全組與新舊兩位案主；首次連結不在產品通知矩陣裡，只留事件與稽核。
   */
  link(actor: ResolvedActor, input: LinkOpportunityInput, requestId: string): Promise<Result<LinkReceipt>>
  /** 案主或系辦解除（理由必填）；通知該組全員與案主。 */
  unlink(actor: ResolvedActor, input: UnlinkOpportunityInput, requestId: string): Promise<Result<LinkReceipt>>
  /**
   * 改組別類型。組長：在成組期內、尚未指派主指導、未連結合作案三個條件都成立才可以，否則 `FORBIDDEN`
   * 並說明是哪一條、請聯絡系辦。系辦：理由必填，既有主指導與合作案連結**保留**（不靜默刪關聯），回執列出來。
   */
  changeGroupType(actor: ResolvedActor, input: ChangeGroupTypeInput, requestId: string): Promise<Result<GroupTypeReceipt>>
}

/** 學生「我的組別」的合作案與類型區塊要的資料。 */
export type LeaderPanel = {
  readonly groupId: string
  readonly groupCode: string
  readonly groupType: GroupType
  readonly revision: number
  readonly isLeader: boolean
  readonly link: GroupOpportunityLink | null
  /** 組長自己改類型不符合的條件（空＝可以改）。 */
  readonly typeChangeBlockers: readonly string[]
  /** 可以連結的合作案（已發布；已經連著的那一案不列）。 */
  readonly linkable: readonly OpportunityCard[]
}

export type OpportunityListFilter = {
  /** `open` 尚未有組別連結、`linked` 已有組別。 */
  readonly linked?: 'open' | 'linked'
  readonly ownerUserId?: string
  readonly q?: string
  readonly sort?: 'newest' | 'oldest' | 'company'
}

/**
 * 合作案的查詢。**查詢本身看 actor**（不是呼叫端守門）：回的是別人的公司聯絡資料，
 * 訪客一律拿不到東西、聯絡資訊只有案主與系辦的查詢會去 select。
 */
export interface OpportunityQuery {
  /** 已發布的合作案列表（登入者）；訪客與沒有角色的帳號回空陣列。 */
  list(actor: ResolvedActor, filter?: OpportunityListFilter): Promise<OpportunityCard[]>
  /** 打開一案（見 `OpportunityPage` 的五種結果）。 */
  open(actor: ResolvedActor, opportunityId: string): Promise<OpportunityPage>
  /** 老師看自己的全部合作案（含草稿、下架）；系辦看全部。其他人回空陣列。 */
  manageList(actor: ResolvedActor): Promise<ManagedOpportunity[]>
  /** 學生本人的組別在合作案與類型區塊要的資料；沒有組別回 null。 */
  leaderPanel(actor: ResolvedActor, cohortId: string): Promise<LeaderPanel | null>
}

/** 組別名單匯出的結果（票 20；#105）：檔案內容與筆數，檔名由呼叫端依時間組。 */
export type RosterExportResult = {
  readonly format: RosterExportFormat
  readonly cohortCode: string
  /** 匯出了幾組、幾列（每位組員一列）。 */
  readonly groupCount: number
  readonly rowCount: number
  /** CSV 是字串（含 BOM），XLSX 是位元組。 */
  readonly body: string | Uint8Array
}

/**
 * 管理員匯出本屆組別名單（CSV／XLSX，帶登入信箱）。每次重新授權、重新查詢，只信「勾選的組別」或「篩選條件」，
 * 不收瀏覽器算好的列；寫一筆稽核（只記範圍與筆數，不記個資）。
 */
export interface GroupRosterExporter {
  exportRoster(actor: ResolvedActor, request: RosterExportRequest): Promise<Result<RosterExportResult>>
}
