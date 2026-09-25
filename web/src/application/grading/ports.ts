import type { ResolvedActor } from '@/application/accounts'
import type { EvaluationState, ScoreInput } from '@/application/grading/evaluation'
import type { GroupResult, OverrideSummary, RemovalChoice } from '@/application/grading/gradebook'
import type { SchemeStage, SchemeStageInput, SchemeVersionStatus } from '@/application/grading/scheme'
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
}

export type AssignEvaluatorReceipt = {
  readonly assignmentId: string
  readonly groupCode: string
  readonly stageName: string
  readonly teacherName: string
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
}

export type AdminGradingBoard = {
  readonly cohort: { readonly id: string; readonly code: string; readonly archived: boolean }
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
  readonly groupId: string
  readonly groupCode: string
  readonly stageKey: string
  readonly stageName: string
  readonly state: EvaluationState
  readonly filled: number
  readonly total: number
  /** 票 24：系辦退回、還沒重新送出。 */
  readonly returned: boolean
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
}

export type TeacherBench = {
  readonly groupId: string
  readonly groupCode: string
  readonly cohortCode: string
  readonly memberNames: readonly string[]
  readonly versionNo: number
  readonly entries: readonly BenchEntry[]
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
  /** 設定某組某階段要幾份評分（0–10）。 */
  setRequirement(actor: ResolvedActor, input: SetRequirementInput, requestId: string): Promise<Result<RequirementReceipt>>
  /** 指派評分老師；老師收到「評分指派」通知。同組同階段同老師重複 → `VALIDATION_FAILED`。 */
  assign(actor: ResolvedActor, input: AssignEvaluatorInput, requestId: string): Promise<Result<AssignEvaluatorReceipt>>
  /** 受指派老師暫存（可以沒填完）。不是本人的有效指派 → `NOT_ASSIGNED`。第一位老師開始填時方案版本鎖定（產品 7.5）。 */
  saveDraft(actor: ResolvedActor, input: ScoresInput, requestId: string): Promise<Result<DraftReceipt>>
  /** 受指派老師正式送出；同指派已有正式評分 → `CONFLICT`（需先退回）。方案版本在第一位老師開始填時鎖定（見 saveDraft）。 */
  submitFinal(actor: ResolvedActor, input: ScoresInput, requestId: string): Promise<Result<FinalReceipt>>
}

export interface GradingQuery {
  /** 管理員的評分管理頁；不是管理員 → `FORBIDDEN`。 */
  adminBoard(actor: ResolvedActor, cohortId: string): Promise<Result<AdminGradingBoard>>
  /** 老師自己的有效指派（誰由 actor 決定）；不是老師回空清單。 */
  teacherQueue(actor: ResolvedActor): Promise<readonly TeacherQueueEntry[]>
  /** 老師的評閱桌：只回本人在這一組的有效指派；沒有 → `NOT_ASSIGNED`。 */
  teacherBench(actor: ResolvedActor, groupId: string): Promise<Result<TeacherBench>>
}

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
  readonly reason: string
}

export type Gradebook = {
  readonly cohort: { readonly id: string; readonly code: string; readonly archived: boolean }
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
  readonly reason: string
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
  readonly reason: string
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
  /** 退回某位老師的正式分數（理由必填）；老師收到通知、可以修改後重送。指派已結束 → `NOT_ASSIGNED`；已不是採計中 → `CONFLICT`。 */
  returnEvaluation(actor: ResolvedActor, input: ReturnEvaluationInput, requestId: string): Promise<Result<ReturnReceipt>>
  /** 移除或改派評分老師（三選一）。預覽後採計集合變了 → `CONFLICT`（要重新預覽）。 */
  removeAssignment(actor: ResolvedActor, input: RemoveAssignmentInput, requestId: string): Promise<Result<RemoveAssignmentReceipt>>
  /** 更正最終結果（保留原值、理由）。最終還沒完成 → `FINAL_INCOMPLETE`。 */
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
