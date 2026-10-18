import type { ResolvedActor } from '@/application/accounts'
import type { EvaluationState, ScoreInput } from '@/application/grading/evaluation'
import type { GroupResult, OverrideSummary, RemovalChoice } from '@/application/grading/gradebook'
import type { SchemeItemType, SchemeStage, SchemeStageInput, SchemeVersionStatus } from '@/application/grading/scheme'
import type { GroupVersionWithFiles } from '@/application/submissions'
import type { Result } from '@/shared/result'

/**
 * 模組 06 評分的 port（模組實作設計 06 §5；票 23 只做方案、要求份數、指派、暫存、正式送出）。
 *
 * 退回、改派三選一、更正、成績表與匯出在票 24。授權都在實作裡判（契約 03 §1「評分：老師只看自己指派與輸入；
 * 管理員全部；學生無」）：學生呼叫任何一個都是 `FORBIDDEN`，也拿不到任何分數。
 */

// ── 回執 ────────────────────────────────────────────────────────────────────

export type SchemeVersionReceipt = {
  readonly schemeId: string
  readonly versionId: string
  readonly versionNo: number
  readonly status: SchemeVersionStatus
}

export type RequirementReceipt = {
  readonly groupId: string
  readonly groupCode: string
  readonly stageKey: string
  readonly stageName: string
  readonly requiredCount: number
  /** C1-04：實際一起改到的評分項目（同一評審組的全部項目；不屬於評審組就只有 `stageKey`）。 */
  readonly appliedStageKeys?: readonly string[]
}

export type AssignEvaluatorReceipt = {
  /** 請求的那個評分項目上新建的指派。 */
  readonly assignmentId: string
  readonly groupCode: string
  readonly stageName: string
  readonly teacherName: string
  /** C1-04：同交易一起指派的評分項目（評審組展開；不屬於評審組就只有請求的那一個）。 */
  readonly appliedStageKeys?: readonly string[]
}

export type DraftReceipt = {
  readonly assignmentId: string
  readonly evaluationId: string
  /** 伺服器收到的真實時間（ISO）。 */
  readonly savedAt: string
  readonly filled: number
  readonly total: number
}

export type FinalReceipt = {
  readonly assignmentId: string
  readonly evaluationId: string
  readonly groupCode: string
  readonly stageName: string
  /** 伺服器收件的真實時間（ISO）。 */
  readonly receivedAt: string
  /** 這位老師這一階段的正式分數（兩位小數）。 */
  readonly teacherScore: string
  readonly gate: 'pass' | 'fail' | null
  readonly versionNo: number
}

// ── 輸入 ────────────────────────────────────────────────────────────────────

export type CreateSchemeVersionInput = {
  readonly cohortId: string
  readonly stages: readonly SchemeStageInput[]
}

export type SetRequirementInput = {
  readonly groupId: string
  readonly stageKey: string
  readonly requiredCount: number
  /** 畫面看到的版本（還沒設定過是 0）；別人先改過就 `CONFLICT`。 */
  readonly revision: number
}

export type AssignEvaluatorInput = {
  readonly groupId: string
  readonly stageKey: string
  readonly teacherUserId: string
}

export type ScoresInput = {
  readonly assignmentId: string
  readonly scores: ScoreInput
  /** 評語（B 階段 TE-B4；選填，最多 500 字）：跟分數同一次寫入；空字串存成 null。 */
  readonly comment?: string | null
}

// ── 查詢結果 ────────────────────────────────────────────────────────────────

export type SchemeVersionView = {
  readonly id: string
  readonly versionNo: number
  readonly status: SchemeVersionStatus
  readonly stages: readonly SchemeStage[]
  readonly isCurrent: boolean
  readonly createdAt: Date
  readonly lockedAt: Date | null
}

export type AdminAssignmentView = {
  readonly id: string
  readonly groupId: string
  readonly stageKey: string
  readonly teacherUserId: string
  readonly teacherName: string
  /** 老師帳號停用或不再是老師（仍列出，不自動改派）。 */
  readonly teacherInactive: boolean
  readonly state: EvaluationState
  /** 暫存或正式的這位老師階段分數（兩位小數）；管理員才看得到。未開始是 null。 */
  readonly score: string | null
  readonly filled: number
  readonly total: number
  /** 最近一次暫存或正式送出的時間。 */
  readonly updatedAt: Date | null
  /** 跟 `score` 同一筆（有採計是採計那筆，否則最新暫存）的評語；管理員成績明細看得到。 */
  readonly comment: string | null
}

export type AdminGradingBoard = {
  readonly cohort: { readonly id: string; readonly code: string; readonly name: string; readonly archived: boolean }
  readonly schemeId: string | null
  readonly versions: readonly SchemeVersionView[]
  readonly current: SchemeVersionView | null
  readonly groups: readonly { readonly id: string; readonly code: string; readonly advisorName: string | null }[]
  readonly requirements: readonly {
    readonly groupId: string
    readonly stageKey: string
    readonly requiredCount: number
    readonly revision: number
  }[]
  readonly assignments: readonly AdminAssignmentView[]
  readonly teachers: readonly { readonly userId: string; readonly name: string }[]
}

export type TeacherQueueEntry = {
  readonly assignmentId: string
  readonly cohortCode: string
  readonly cohortName: string
  readonly groupId: string
  readonly groupCode: string
  readonly stageKey: string
  readonly stageName: string
  readonly state: EvaluationState
  readonly filled: number
  readonly total: number
  /** 票 24：系辦退回、還沒重新送出。 */
  readonly returned: boolean
  /** 本組現任組長的顯示名（`group_leaders.valid_to is null`）；沒有組長是 null。 */
  readonly leaderName: string | null
  /** 正式送出（採計）的這位老師階段分數（兩位小數，照目前方案版本算）；還沒送出是 null。 */
  readonly finalScore: string | null
  /** 採計那一筆的送出時間；還沒送出是 null。 */
  readonly submittedAt: Date | null
  /** B 階段 TE-B1：正式送出後又有新暫存（還沒重新送出）。 */
  readonly draftAfterFinal: boolean
  /** B 階段 TE-B2a：這一階段系辦已結算（唯讀）。 */
  readonly settled: boolean
  /**
   * C1-04：這個評分項目對應的作業（側表 `item_id`）與本組在那份作業的繳交概況（清單的「附件」欄）；沒有對應作業是 null。
   * `fileCount` 是最新一版的檔案數。
   */
  readonly linkedItem: {
    readonly itemId: string
    readonly title: string
    readonly submitted: boolean
    readonly lastSubmittedAt: Date | null
    readonly fileCount: number
  } | null
}

/** 系辦退回（票 24）：老師看得到理由與時間，退回前的分數預填回表單。 */
export type ReturnNotice = {
  readonly reason: string
  readonly returnedAt: Date
}

export type BenchEntry = {
  readonly assignmentId: string
  readonly stage: SchemeStage
  readonly state: EvaluationState
  /** 目前的暫存或正式送出的分數（本人的）；被退回時是退回前的分數（預填）。 */
  readonly scores: Readonly<Record<string, string>>
  readonly savedAt: Date | null
  readonly submittedAt: Date | null
  /** 正式送出的分數（兩位小數，照目前方案版本算）；還沒送出是 null。 */
  readonly finalScore: string | null
  /** 暫存是照舊版本填的（方案在正式評分前改過）：畫面提示重新確認。 */
  readonly draftFromOlderVersion: boolean
  /** 票 24：被系辦退回、還沒重新送出（有新的暫存也算，理由一直顯示到重新送出）。 */
  readonly returned: ReturnNotice | null
  /** 目前這一筆（暫存或採計，跟 `scores` 同一筆）的評語。 */
  readonly comment: string | null
  /** 正式送出後又有新暫存：`scores`、`comment`、`savedAt` 是那筆暫存，`finalScore`、`submittedAt` 仍是採計那筆。 */
  readonly draftAfterFinal: boolean
  /** 已採計、未結算、未退回 → 可重新送出。 */
  readonly resubmittable: boolean
  /** 這一階段系辦已結算（唯讀）；沒結算是 null。 */
  readonly settled: { readonly settledAt: Date } | null
  /** 第 1 次…第 n 次正式送出（舊的在前）。 */
  readonly submissionHistory: readonly { readonly no: number; readonly at: Date }[]
}

export type TeacherBench = {
  readonly groupId: string
  readonly groupCode: string
  readonly cohortCode: string
  readonly cohortName: string
  readonly memberNames: readonly string[]
  readonly versionNo: number
  readonly entries: readonly BenchEntry[]
}

/**
 * 評分單組頁一次讀齊的資料（TE-11；C1-04 改成一次看一個評分項目）：評閱桌＋組長＋老師自己的整份隊列＋
 * **這個評分項目對應作業**的本組正式版本與附件。
 * `submissions` 是**作業版本**（不是評分送出紀錄）：只有側表 `item_id` 那份作業的版本（新到舊）；
 * 這個評分項目沒有對應作業就是空的，**沒有「本組全部繳交」的退路**（設計方案① §3.4）。
 */
export type TeacherBenchPage = TeacherBench & {
  readonly leaderName: string | null
  readonly queue: readonly TeacherQueueEntry[]
  readonly submissions: readonly GroupVersionWithFiles[]
  /** 這一頁看的評分項目（`?stage=`；沒帶就是本組第一個分給我的項目）。 */
  readonly stageKey: string
  /** 這個評分項目對應的作業；沒有是 null（畫面顯示說明＋「這個項目不看作業，直接填分」）。 */
  readonly linkedItem: { readonly itemId: string; readonly title: string } | null
  /** 側表的說明（給老師看）；沒有是 null。 */
  readonly stageDescription: string | null
  /** 同屆同評分項目、照老師清單排序的上一組／下一組（第一組／最後一組那一邊是 null）。 */
  readonly neighbors: { readonly prev: string | null; readonly next: string | null }
}

/** 票 19 重派對話框：原老師在本組的評分指派（`groups.GradingAssignmentSummary` 的形狀）。 */
export type TeacherGroupAssignment = {
  readonly id: string
  readonly stageName: string
  readonly state: 'empty' | 'draft' | 'submitted'
}

// ── port ────────────────────────────────────────────────────────────────────

export interface GradingCommand {
  /** 管理員建一個方案版本（草稿）。一屆一個方案頭列，沒有就同交易建。權重不合 100 → `VALIDATION_FAILED`。 */
  createSchemeVersion(actor: ResolvedActor, input: CreateSchemeVersionInput, requestId: string): Promise<Result<SchemeVersionReceipt>>
  /** 發布草稿成為目前版本。目前版本已鎖定 → `SCHEME_LOCKED`（改結構要走新版本套用，票 24）。 */
  publishScheme(actor: ResolvedActor, input: { versionId: string }, requestId: string): Promise<Result<SchemeVersionReceipt>>
  /** 設定某組某階段要幾位老師評（0–10）。屬於評審組時同交易改評審組全部項目（`appliedStageKeys`）。 */
  setRequirement(actor: ResolvedActor, input: SetRequirementInput, requestId: string): Promise<Result<RequirementReceipt>>
  /**
   * 指派評分老師；老師收到「評分指派」通知。同組同階段同老師重複 → `VALIDATION_FAILED`。
   * 屬於評審組時同交易對評審組全部項目各建一筆（任一項目不能指派就整筆不做）。
   */
  assign(actor: ResolvedActor, input: AssignEvaluatorInput, requestId: string): Promise<Result<AssignEvaluatorReceipt>>
  /**
   * 受指派老師暫存（可以沒填完；正式送出後也可以，B 階段 TE-B1）。不是本人的有效指派 → `NOT_ASSIGNED`；
   * 階段已結算 → `CONFLICT`；評語超過 500 字 → `VALIDATION_FAILED`。第一位老師開始填時方案版本鎖定（產品 7.5）。
   */
  saveDraft(actor: ResolvedActor, input: ScoresInput, requestId: string): Promise<Result<DraftReceipt>>
  /**
   * 受指派老師正式送出。同指派已有正式評分 → 舊的改 historical、這一筆採計（重送，B 階段 TE-B1）；
   * 階段已結算 → `CONFLICT`。方案版本在第一位老師開始填時鎖定（見 saveDraft）。
   */
  submitFinal(actor: ResolvedActor, input: ScoresInput, requestId: string): Promise<Result<FinalReceipt>>
}

export interface GradingQuery {
  /** 管理員的評分管理頁；不是管理員 → `FORBIDDEN`。 */
  adminBoard(actor: ResolvedActor, cohortId: string): Promise<Result<AdminGradingBoard>>
  /** 老師自己的有效指派（誰由 actor 決定）；不是老師回空清單。 */
  teacherQueue(actor: ResolvedActor): Promise<readonly TeacherQueueEntry[]>
  /** 老師的評閱桌：只回本人在這一組的有效指派；沒有 → `NOT_ASSIGNED`。 */
  teacherBench(actor: ResolvedActor, groupId: string): Promise<Result<TeacherBench>>
  /**
   * 評分單組頁：`teacherBench`、`teacherQueue`、本組正式繳交（含附件）並行一次讀。
   * 先驗本人對 `(groupId, stageKey)` 有有效指派（`stageKey` 沒給＝本組第一個分給我的項目），沒有 → `NOT_ASSIGNED`、不回任何繳交；
   * 繳交只留這個評分項目對應作業的版本，沒有對應作業是空陣列（C1-04）。
   */
  teacherBenchPage(actor: ResolvedActor, groupId: string, stageKey?: string | null): Promise<Result<TeacherBenchPage>>
  /** 系辦首頁（AD-21）：本屆待復核的更正（1 句 SQL；跟成績表的 `pendingReviews` 同一份）。不是管理員 → `FORBIDDEN`。 */
  pendingReviews(actor: ResolvedActor, cohortId: string): Promise<Result<readonly PendingReview[]>>
  /**
   * 系辦首頁評分卡（AD-21）：本屆未解散組別、目前版本有的階段上的有效指派份數（`required`）與其中已採計的份數（`counted`），
   * 跟 `admin/grading/progress.ts` 的 `teacherProgress` 同一個口徑（1 句 SQL）。不是管理員 → `FORBIDDEN`。
   */
  progressSummary(actor: ResolvedActor, cohortId: string): Promise<Result<GradingProgressSummary>>
}

export type GradingProgressSummary = { readonly counted: number; readonly required: number }

/** 給票 19 重派對話框用：某老師在某組的有效評分指派（管理員頁面才會呼叫）。 */
export interface AssignmentsForTeacherQuery {
  listForGroup(groupId: string, teacherUserId: string): Promise<readonly TeacherGroupAssignment[]>
}

// ════════════════════════════════════════════════════════════════════════════
// 票 24：成績表、退回、更正、改派三選一、套用新方案版本、匯出
// （產品模組 06 §4「7.3」「7.4」「7.5」「7.6」、2026-09-15 定案補充／成績匯出；模組實作設計 06 §3、§5、§6）
// ════════════════════════════════════════════════════════════════════════════

/** 更正（含歷史）的樣子。 */
export type OverrideView = OverrideSummary & {
  readonly schemeVersionNo: number
  readonly actorName: string
  readonly realAt: Date
  readonly resolvedAt: Date | null
  readonly resolvedByName: string | null
}

/** 還沒採計的有效指派（缺評）：老師停用時畫面顯示「老師已停用，待管理員處理」。 */
export type MissingEvaluation = {
  readonly assignmentId: string
  readonly stageKey: string
  readonly stageName: string
  readonly teacherName: string
  readonly teacherInactive: boolean
}

export type GradebookGroup = {
  readonly id: string
  readonly code: string
  readonly advisorName: string | null
  /**
   * 已解散（產品模組 03 §4「解散：原組別資料凍結，管理員可查與匯出」）：唯讀列出，不再有缺評、待指派，
   * 成績用解散當下套用的方案版本算（之後套用新版本不重算它）。
   */
  readonly dissolved: boolean
  /** 這一組的數字用哪個方案版本算：進行中的組＝目前版本；解散的組＝解散當下的版本。 */
  readonly versionNo: number | null
  /**
   * 組員（匯出每人一列；學號是文字）：進行中的組是此刻的有效組員；解散的組是解散當下的組員快照
   * （解散前就被移出的人不列）。
   */
  readonly members: readonly { readonly name: string; readonly studentNo: string | null }[]
  readonly result: GroupResult
  /** 最新一筆沒被取代的更正（生效中或待復核）；沒有是 null。 */
  readonly override: OverrideView | null
  /** 這一組目前的計算基礎（更正時帶回來比對，成績剛變動就要求重新整理）。 */
  readonly basisHash: string
  readonly missing: readonly MissingEvaluation[]
}

export type PendingReview = {
  readonly overrideId: string
  readonly groupId: string
  readonly groupCode: string
  readonly originalValue: string
  readonly newValue: string
  /** 選填（C1-04）；沒填是 null。 */
  readonly reason: string | null
}

export type Gradebook = {
  readonly cohort: { readonly id: string; readonly code: string; readonly name: string; readonly archived: boolean }
  readonly version: { readonly id: string; readonly versionNo: number; readonly stages: readonly SchemeStage[] } | null
  readonly groups: readonly GradebookGroup[]
  readonly pendingReviews: readonly PendingReview[]
}

/** 計算明細頁：一組的每一份評分（含退回、歷史、失效的暫存）。只有管理員看得到。 */
export type EvaluationHistoryEntry = {
  readonly evaluationId: string
  readonly assignmentId: string
  readonly stageKey: string
  readonly stageName: string
  readonly teacherName: string
  readonly kind: 'draft' | 'final'
  readonly state: 'draft' | 'counted' | 'historical' | 'returned' | 'invalidated'
  readonly scores: Readonly<Record<string, string>>
  /** 照目前方案版本算的這一份分數（兩位小數）；暫存沒填完是已填部分的加權。 */
  readonly display: string
  readonly submittedAt: Date
  /** 最近一次狀態變化的理由（退回理由、替換、失效原因）。 */
  readonly lastReason: string | null
  readonly lastChangedAt: Date | null
  /** 這一份的評語（B 階段 TE-B4；AC-A-4 系辦在計算明細看全文）；沒填是 null。 */
  readonly comment: string | null
}

export type AssignmentHistoryEntry = {
  readonly id: string
  readonly stageKey: string
  readonly stageName: string
  readonly teacherName: string
  readonly teacherInactive: boolean
  readonly active: boolean
  readonly validFrom: Date
  readonly endedAt: Date | null
  readonly removalChoice: RemovalChoice | null
  readonly reason: string | null
  /** 改派時：這一列接手的舊指派。 */
  readonly previousAssignmentId: string | null
}

export type GroupGradeDetail = {
  readonly group: {
    readonly id: string
    readonly code: string
    readonly cohortId: string
    readonly cohortCode: string
    readonly cohortName: string
    readonly archived: boolean
    readonly dissolved: boolean
  }
  readonly version: { readonly id: string; readonly versionNo: number; readonly stages: readonly SchemeStage[] } | null
  readonly result: GroupResult
  readonly basisHash: string
  readonly overrides: readonly OverrideView[]
  readonly evaluations: readonly EvaluationHistoryEntry[]
  readonly assignments: readonly AssignmentHistoryEntry[]
  readonly missing: readonly MissingEvaluation[]
}

/** 移除／改派的預覽：三種選擇各自的前後結果，加上執行時要帶回來比對的 `basisHash`。 */
export type ReassignmentOption = {
  readonly choice: RemovalChoice
  /** 這個選擇現在能不能用；不能用時說明原因（例如這位老師還沒有正式分數，沒有可保留的）。 */
  readonly blockedReason: string | null
  readonly requiredAfter: number | null
  readonly countedAfter: readonly { readonly teacherName: string; readonly display: string }[]
  readonly averageAfter: string | null
  readonly stageStatusAfter: string
  readonly finalAfter: string | null
}

export type ReassignmentPreview = {
  readonly assignmentId: string
  readonly cohortId: string
  readonly groupId: string
  readonly groupCode: string
  readonly stageKey: string
  readonly stageName: string
  readonly teacherName: string
  /** 被移除的老師有沒有正式分數（沒有的話只剩「替換」：移除，或換一位老師）。 */
  readonly hasCounted: boolean
  readonly hasDraft: boolean
  readonly requiredBefore: number | null
  readonly countedBefore: readonly { readonly teacherName: string; readonly display: string }[]
  readonly averageBefore: string | null
  readonly stageStatusBefore: string
  readonly finalBefore: string | null
  /** 這一組有生效中的更正：替換、新增會讓它進「待復核」。 */
  readonly hasEffectiveOverride: boolean
  readonly options: readonly ReassignmentOption[]
  /** 可以接手的老師（有效、老師角色、這一組這一階段還沒有有效指派）。 */
  readonly teachers: readonly { readonly userId: string; readonly name: string }[]
  readonly basisHash: string
}

export type RemoveAssignmentInput = {
  readonly assignmentId: string
  readonly choice: RemovalChoice
  /** 替換時可選（不選＝只移除，缺評等之後再指派）；新增時必填；保留時不能給。 */
  readonly newTeacherUserId: string | null
  /** 選填（C1-04、X2）；空白當沒填。 */
  readonly reason?: string | null
  /** 預覽拿到的；執行時在鎖內重算，不同就 `CONFLICT`（預覽過期，要重新預覽）。 */
  readonly basisHash: string
}

export type RemoveAssignmentReceipt = {
  readonly groupCode: string
  readonly stageName: string
  readonly teacherName: string
  readonly newTeacherName: string | null
  readonly choice: RemovalChoice
  readonly requiredCount: number | null
  /** C1-04：同交易一起移除／改派的評分項目（評審組展開；不屬於評審組就只有被移除的那一個）。 */
  readonly appliedStageKeys?: readonly string[]
}

export type ReturnEvaluationInput = { readonly evaluationId: string; readonly reason: string }

export type ReturnReceipt = {
  readonly evaluationId: string
  readonly groupCode: string
  readonly stageName: string
  readonly teacherName: string
}

export type OverrideInput = {
  readonly groupId: string
  /** 更正後的最終成績（0–100、最多兩位小數）。 */
  readonly newValue: string
  /** 選填（C1-04、X2）；空白當沒填。 */
  readonly reason?: string | null
  /** 畫面看到的計算基礎；成績剛變動就 `CONFLICT`。 */
  readonly basisHash: string
}

export type OverrideReceipt = {
  readonly overrideId: string
  readonly groupCode: string
  readonly originalValue: string
  readonly newValue: string
}

/** 復核待復核的更正：沿用原更正值（套在新的計算基礎上）或改成新的更正值。兩種都留一筆新的更正版本。 */
export type ResolveReviewInput = {
  readonly overrideId: string
  readonly decision: 'keep' | 'new'
  /** `new` 時必填。 */
  readonly newValue: string | null
  readonly reason: string
  readonly basisHash: string
}

/** 套用新方案版本（目前版本已鎖定之後）的影響預覽。 */
export type SchemeApplyPreview = {
  readonly cohortId: string
  readonly versionId: string
  readonly versionNo: number
  readonly currentVersionNo: number
  /** 不能套用的原因（例如已有正式評分的階段少了項目）；空的才能套用。 */
  readonly blockers: readonly string[]
  readonly groups: readonly {
    readonly groupId: string
    readonly code: string
    readonly finalBefore: string | null
    readonly finalAfter: string | null
    readonly stages: readonly { readonly name: string; readonly before: string | null; readonly after: string | null }[]
    readonly changed: boolean
    /** 有生效中的更正：套用後一定進待復核（方案版本是計算基礎的一部分），和數字變不變無關。 */
    readonly hasOverride: boolean
  }[]
  /** 執行時帶回來比對（方案、採計或份數在預覽後變了 → `CONFLICT`）。 */
  readonly token: string
}

export type ApplySchemeInput = { readonly versionId: string; readonly token: string }

export interface GradingResultsCommand {
  /** 退回某位老師的正式分數（理由**必填**，C 階段 X2 也不放寬）；老師收到通知、可以修改後重送。指派已結束 → `NOT_ASSIGNED`；已不是採計中 → `CONFLICT`。 */
  returnEvaluation(actor: ResolvedActor, input: ReturnEvaluationInput, requestId: string): Promise<Result<ReturnReceipt>>
  /**
   * 移除或改派評分老師（三選一；理由選填）。預覽後採計集合變了 → `CONFLICT`（要重新預覽）。
   * 被移除的項目屬於評審組時，同交易對評審組其他項目上同一位老師的指派做同一件事（各自套既有規則，任一不行整筆不做）。
   */
  removeAssignment(actor: ResolvedActor, input: RemoveAssignmentInput, requestId: string): Promise<Result<RemoveAssignmentReceipt>>
  /** 更正最終結果（保留原值；理由選填）。最終還沒完成 → `FINAL_INCOMPLETE`。 */
  override(actor: ResolvedActor, input: OverrideInput, requestId: string): Promise<Result<OverrideReceipt>>
  /** 處理待復核的更正。 */
  resolveReview(actor: ResolvedActor, input: ResolveReviewInput, requestId: string): Promise<Result<OverrideReceipt>>
  /** 方案鎖定後套用新版本（先看 `previewSchemeVersion`）。 */
  applySchemeVersion(actor: ResolvedActor, input: ApplySchemeInput, requestId: string): Promise<Result<SchemeVersionReceipt>>
}

export interface GradebookQuery {
  /** 整屆成績表；不是管理員 → `FORBIDDEN`。 */
  gradebook(actor: ResolvedActor, cohortId: string): Promise<Result<Gradebook>>
  /** 一組的計算明細與歷史；不是管理員 → `FORBIDDEN`。 */
  groupDetail(actor: ResolvedActor, groupId: string): Promise<Result<GroupGradeDetail>>
  /** 移除／改派的三選一預覽。 */
  previewReassignment(actor: ResolvedActor, assignmentId: string): Promise<Result<ReassignmentPreview>>
  /** 套用新方案版本的影響預覽（只讀，取消不會重算任何東西）。 */
  previewSchemeVersion(actor: ResolvedActor, versionId: string): Promise<Result<SchemeApplyPreview>>
}

// ════════════════════════════════════════════════════════════════════════════
// B 階段 TE-B2a：系辦結算（設計方案 §2.2；實作 `infrastructure/grading/pg-grade-settlements.ts`）
// ════════════════════════════════════════════════════════════════════════════

export type Settlement = {
  readonly settlementId: string
  readonly cohortId: string
  readonly stageKey: string
  /** 從目前方案版本找；套用新版本後找不到就是 `stageKey`。 */
  readonly stageName: string
  readonly settledAt: Date
  readonly settledBy: { readonly userId: string; readonly name: string }
  /** 選填（C1-04、X2）；沒填是 null。 */
  readonly reason: string | null
  readonly countedEvaluations: number
}

export type SettlementHistory = Settlement & {
  readonly releasedAt: Date | null
  readonly releasedBy: { readonly userId: string; readonly name: string } | null
  readonly releaseReason: string | null
}

/**
 * `serverTime` 跟全站回執（`shared/result.ts` 的 `Receipt`）一樣是 ISO 字串（設計方案 §2.2 寫 `Date`，
 * 但 `Result<R>` 會再交集 `serverTime: string`，兩者並存型別不成立）。日期欄（`settledAt`、`releasedAt`）是 `Date`，重放也是。
 */
export type SettlementReceipt = Settlement & { readonly requestId: string; readonly serverTime: string }

export type ReleaseReceipt = {
  readonly settlementId: string
  readonly stageKey: string
  readonly stageName: string
  readonly releasedAt: Date
  readonly requestId: string
  readonly serverTime: string
}

export interface GradingSettlementCommand {
  /**
   * 系辦結算一個階段。FORBIDDEN → VALIDATION_FAILED（理由選填、有填 ≤ 500 字；階段不在目前版本）→ COHORT_ARCHIVED →
   * CONFLICT「{階段名}已於 {時間} 結算」。不發通知。
   */
  settleStage(
    actor: ResolvedActor,
    input: { readonly cohortId: string; readonly stageKey: string; readonly reason?: string | null },
    requestId: string,
  ): Promise<Result<SettlementReceipt>>
  /**
   * 解除結算。找不到 → VALIDATION_FAILED「找不到這筆結算，請重新整理頁面。」（錯誤碼表沒有 NOT_FOUND）；
   * 已解除 → CONFLICT「這筆結算已於 {時間} 解除」。
   */
  releaseSettlement(
    actor: ResolvedActor,
    input: { readonly settlementId: string; readonly reason?: string | null },
    requestId: string,
  ): Promise<Result<ReleaseReceipt>>
}

export interface GradingSettlementQuery {
  /**
   * 老師與系辦都可讀；非兩者 → FORBIDDEN。沒有現行結算時 `settlement` 是 null。
   * （設計方案 §2.2 寫 `Result<Settlement | null>`，但 `Receipt<R>` 是 `R & {requestId, serverTime}`，null 放不進去——
   * `ok(null)` 會變成只有 requestId 的物件、判斷「有沒有結算」會誤判——所以包一層。）
   */
  settlementOf(actor: ResolvedActor, cohortId: string, stageKey: string): Promise<Result<{ readonly settlement: Settlement | null }>>
  /** 系辦：該屆所有階段的現行結算＋歷史（新的在前）。 */
  settlements(actor: ResolvedActor, cohortId: string): Promise<Result<readonly SettlementHistory[]>>
}

/**
 * 屆別評分快照（B 階段 TE-B6；設計方案 §4）：系辦成績管理頁一次讀完屆別、方案版本、組別、組員、指派與事實，
 * `board`（老師評分進度）與 `gradebook`（階段完成率、成績表、更正）都從同一份資料組出來，形狀與 `adminBoard`／`gradebook` 相同。
 * 階段篩選不在這裡（頁面對快照做，見 `snapshot.ts`）。
 */
export type CohortGradingSnapshot = {
  readonly board: AdminGradingBoard
  readonly gradebook: Gradebook
  /** 現行結算（未解除），依階段代號排序。 */
  readonly settlements: readonly Settlement[]
  readonly loadedAt: Date
}

export interface GradingSnapshotQuery {
  /**
   * 只有系辦；非系辦 → FORBIDDEN「只有系辦可以看評分管理。」。屆別不存在 → VALIDATION_FAILED「找不到這個屆別，請重新整理頁面。」
   * （設計方案 §4.2 寫 NOT_FOUND，但錯誤碼表沒有 NOT_FOUND，跟 `adminBoard`／`gradebook`／結算一樣用 VALIDATION_FAILED。）
   */
  cohortSnapshot(actor: ResolvedActor, cohortId: string): Promise<Result<CohortGradingSnapshot>>
}

// ════════════════════════════════════════════════════════════════════════════
// C 階段 C1-04：評分項目側表（對應作業、說明、評審組）與前台評分方式（設計方案① §1.3、§3.4、§7.5）
// ════════════════════════════════════════════════════════════════════════════

/** 一個評分項目的側表設定；`itemTitle` 是對應作業的標題（沒有對應是 null）。 */
export type StageSetting = {
  readonly stageKey: string
  readonly itemId: string | null
  readonly itemTitle: string | null
  readonly description: string | null
  readonly panelKey: string | null
}

export type SetStageSettingInput = {
  readonly cohortId: string
  readonly stageKey: string
  readonly itemId: string | null
  readonly description: string | null
  readonly panelKey: string | null
}

export interface GradingStageSettingCommand {
  /**
   * 系辦設定評分項目的對應作業、說明、評審組；三者都 null＝刪列。`stageKey` 必須在目前已發布版本裡（還沒發布 → `VALIDATION_FAILED`）；
   * `itemId` 要同屆、收件、整組、非草稿、非同意書；`panelKey` 非 null 且同屆已有別的項目用同一個 `panelKey` 時，
   * 先驗每一組這些項目的有效指派老師集合與「要幾位老師評」相同，不同 → `VALIDATION_FAILED` 列組別（`details.groups`），
   * 不自動補指派、不結束任何指派。不建新版、不鎖方案。
   */
  setStageSetting(actor: ResolvedActor, input: SetStageSettingInput, requestId: string): Promise<Result<StageSetting>>
}

export interface GradingStageSettingQuery {
  /** 系辦讀一屆的側表；只回目前已發布版本存在的 `stage_key`（依 `stage_key` 排序）。不是系辦 → `FORBIDDEN`。 */
  stageSettings(actor: ResolvedActor, cohortId: string): Promise<Result<readonly StageSetting[]>>
}

/** 前台 /rules「評分方式」區塊：一屆目前方案的評分項目、比例、說明、細項。 */
export type PublicGradingWeights = {
  readonly cohortName: string
  readonly stages: readonly {
    readonly name: string
    readonly weight: number
    readonly description: string | null
    readonly items: readonly { readonly name: string; readonly weight: number; readonly type: SchemeItemType }[]
  }[]
}

/** 前台 /rules 用：這一屆已發布方案的評分項目與比例；沒有已發布方案 → `weights: null`。訪客可讀（不帶任何分數）。 */
export interface PublicGradingQuery {
  weights(cohortId: string): Promise<Result<{ readonly weights: PublicGradingWeights | null }>>
}
