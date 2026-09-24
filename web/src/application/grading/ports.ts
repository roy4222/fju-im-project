import type { ResolvedActor } from '@/application/accounts'
import type { EvaluationState, ScoreInput } from '@/application/grading/evaluation'
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
}

export type BenchEntry = {
  readonly assignmentId: string
  readonly stage: SchemeStage
  readonly state: EvaluationState
  /** 目前的暫存或正式送出的分數（本人的）。 */
  readonly scores: Readonly<Record<string, string>>
  readonly savedAt: Date | null
  readonly submittedAt: Date | null
  /** 正式送出時的正式分數（兩位小數）；還沒送出是 null。 */
  readonly finalScore: string | null
  /** 暫存是照舊版本填的（方案在正式評分前改過）：畫面提示重新確認。 */
  readonly draftFromOlderVersion: boolean
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
  /** 受指派老師暫存（可以沒填完）。不是本人的有效指派 → `NOT_ASSIGNED`。 */
  saveDraft(actor: ResolvedActor, input: ScoresInput, requestId: string): Promise<Result<DraftReceipt>>
  /** 受指派老師正式送出；同指派已有正式評分 → `CONFLICT`（需先退回）。第一份正式評分同時鎖定方案版本。 */
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
