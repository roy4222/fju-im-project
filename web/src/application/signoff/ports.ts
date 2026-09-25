import type { ResolvedActor } from '@/application/accounts'
import type {
  AttachmentVersion,
  AuthorizationScope,
  Participants,
  SignoffPurpose,
  SignoffState,
  SupersedeCause,
} from '@/application/signoff/version'
import type { Result } from '@/shared/result'
import type { RestartKind, VersionProgress, VoteDecision, VoteResult, VoteRole } from '@/application/signoff/approval'

/**
 * 模組 07 線上簽核的 port（模組實作設計 07 §5）。票 25：建版、參與者變更時的失效、三個角色的讀取；
 * 票 26：逐人表態、老師最後同意／退回、重置、重開、作廢、提醒、匯出。
 *
 * 授權都在實作裡判（契約 03 §1「簽核：當前版本參與者、管理員」）：建版、重置、重開、作廢、提醒、匯出只有管理員；
 * 表態只有這一版快照裡的參與者本人；讀版本只有管理員、該版參與者、該組此刻的組員與主指導。
 * **沒有任何一個方法能替別人表態**：`respond` 沒有「替誰」的參數，投的永遠是登入者本人那一票。
 */

// ── 回執 ────────────────────────────────────────────────────────────────────

export type CreateVersionReceipt = {
  readonly packageId: string
  readonly versionId: string
  readonly versionNo: number
  readonly groupCode: string
  readonly purpose: SignoffPurpose
  /** 參與學生人數（實際有效組員）。 */
  readonly studentCount: number
  readonly advisorName: string
  /** 這一版讓哪一版失效（同組同用途原本的目前版本）；第一版是 null。 */
  readonly supersededVersionNo: number | null
}

// ── 輸入 ────────────────────────────────────────────────────────────────────

export type CreateVersionInput = {
  readonly groupId: string
  readonly purpose: SignoffPurpose
  /** 管理員貼的全文（純文字或受限 HTML；存之前清洗）。 */
  readonly content: string
  /** 從這一組正式送出的繳交附件裡選的檔案。 */
  readonly attachmentFileIds: readonly string[]
  /** 最終文件授權：這一組的精選條目（從它的草稿凍結授權範圍）；期中結果確認一定不給。 */
  readonly showcaseEntryId: string | null
}

/** 本人表態（票 26）。沒有「替誰」的欄位：投票的人就是 actor。 */
export type RespondInput = {
  readonly versionId: string
  /** 頁面顯示的那一版內容核對碼；和伺服器上的不一樣（舊頁、過期頁）就拒絕。 */
  readonly contentChecksum: string
  readonly decision: VoteDecision
  /** 不同意／退回時必填。 */
  readonly reason?: string | null
}

export type RespondReceipt = {
  readonly versionId: string
  readonly versionNo: number
  readonly groupCode: string
  readonly purpose: SignoffPurpose
  readonly role: VoteRole
  readonly result: VoteResult
  readonly state: SignoffState
  readonly agreed: number
  readonly total: number
  readonly approvalId: string
  readonly realAt: string
}

/** 重置、重開、作廢都要理由（產品 8.2）。 */
export type ReasonedVersionInput = { readonly versionId: string; readonly reason: string }

export type RestartReceipt = CreateVersionReceipt & { readonly kind: RestartKind; readonly fromVersionNo: number }

export type VoidReceipt = { readonly versionId: string; readonly versionNo: number; readonly groupCode: string; readonly purpose: SignoffPurpose }

export type RemindReceipt = {
  readonly versionId: string
  readonly versionNo: number
  readonly groupCode: string
  readonly purpose: SignoffPurpose
  readonly studentCount: number
  readonly advisorIncluded: boolean
  readonly remindedAt: string
}

export type SignoffExportFormat = 'printable' | 'csv'

export type SignoffExportFile = {
  readonly exportId: string
  readonly fileName: string
  readonly mime: string
  readonly body: string
}

// ── 查詢結果 ────────────────────────────────────────────────────────────────

/** 某個簽核包目前這一版的摘要（列表、卡片用）。 */
export type VersionSummary = {
  readonly versionId: string
  readonly versionNo: number
  readonly state: SignoffState
  readonly cause: string | null
  readonly studentCount: number
  readonly createdAt: Date
  /** 逐人進度（票 26）：三個角色看同一份。 */
  readonly progress: VersionProgress
  /** 最後一個事件的時間（建版、表態、狀態改變取最晚；產品 8.2「最後事件時間」）。 */
  readonly lastEventAt: Date
}

export type AdminGroupRow = {
  readonly groupId: string
  readonly groupCode: string
  /** 此刻的有效組員（建版的影響人數預覽）。 */
  readonly members: readonly { readonly name: string; readonly studentNo: string | null }[]
  readonly advisorName: string | null
  readonly showcase: { readonly entryId: string; readonly title: string; readonly revision: number; readonly ready: boolean } | null
  /** 這一組正式送出過的繳交附件（可以選來綁在版本上）。 */
  readonly submissionFiles: readonly {
    readonly fileId: string
    readonly name: string
    readonly itemTitle: string
    readonly versionNo: number
  }[]
  readonly packages: Readonly<Record<SignoffPurpose, VersionSummary | null>>
}

export type AdminSignoffBoard = {
  readonly cohort: { readonly id: string; readonly code: string; readonly archived: boolean }
  readonly groups: readonly AdminGroupRow[]
}

export type VersionDetail = {
  readonly versionId: string
  readonly packageId: string
  readonly versionNo: number
  readonly purpose: SignoffPurpose
  readonly groupId: string
  readonly groupCode: string
  readonly cohortCode: string
  /** 已經過伺服器端清洗的全文 HTML，畫面直接輸出。 */
  readonly contentHtml: string
  readonly contentChecksum: string
  readonly attachments: readonly AttachmentVersion[]
  readonly participants: Participants
  readonly authorizationScope: AuthorizationScope | null
  readonly supersedeCause: SupersedeCause | null
  readonly state: SignoffState
  readonly cause: string | null
  /** 是不是這個簽核包目前的那一版。 */
  readonly isCurrent: boolean
  readonly createdAt: Date
  readonly createdByName: string
  /** 同一個簽核包的所有版本（新到舊），給版本頁的歷史清單。 */
  readonly history: readonly {
    readonly versionId: string
    readonly versionNo: number
    readonly state: SignoffState
    readonly cause: string | null
    readonly createdAt: Date
  }[]
  /** 逐人進度（票 26）。 */
  readonly progress: VersionProgress
  /** 看這一頁的人在這一版裡是誰、能不能表態（由登入者決定；管理員永遠不能表態）。 */
  readonly viewer: {
    readonly userId: string
    readonly role: VoteRole | null
    /** 此刻還是有效組員／目前主指導。 */
    readonly eligible: boolean
    readonly voted: VoteResult | null
    /** 現在按得下去（狀態輪到你、還沒投、仍有資格、版本是目前那一版）。 */
    readonly canRespond: boolean
  }
  /** 上一次提醒未同意者的時間（24 小時內不能再提醒）。 */
  readonly lastRemindedAt: Date | null
  /** 匯出紀錄（新到舊；只有管理員看得到，其他人是空的）。 */
  readonly exports: readonly { readonly format: SignoffExportFormat; readonly at: Date; readonly byName: string }[]
}

/** 學生「簽核」頁：自己此刻所在組別的每個簽核包的目前那一版。 */
export type StudentSignoffView = {
  readonly groupCode: string | null
  readonly versions: readonly VersionDetail[]
}

/** 老師「簽核」頁：此刻指導的每一組、每個簽核包的目前那一版。 */
export type TeacherSignoffCard = {
  readonly groupId: string
  readonly groupCode: string
  readonly cohortCode: string
  readonly purpose: SignoffPurpose
  readonly current: VersionSummary
  /** 這位老師是不是這一版快照裡的主指導、表態了沒有（票 26 卡片的「輪到你／等待學生」）。 */
  readonly mine: { readonly isSnapshotAdvisor: boolean; readonly voted: VoteResult | null }
}

// ── port ────────────────────────────────────────────────────────────────────

export interface SignoffCommand {
  /**
   * 管理員建一個簽核版本（S11-04）。同組同用途原本的目前版本同交易失效（cause=content_change）；
   * 每位參與學生收到「輪到你同意」。全文空、附件不是這組正式送出的、最終文件授權沒給精選草稿、
   * 期中卻給了精選草稿、沒有主指導 → `VALIDATION_FAILED`／`FILE_*`；組別解散 → `GROUP_DISSOLVED`。
   */
  createVersion(actor: ResolvedActor, input: CreateVersionInput, requestId: string): Promise<Result<CreateVersionReceipt>>

  /**
   * 本人表態（S11-05／06）：快照裡的學生同意／不同意、快照裡的主指導同意／退回。投的永遠是 actor 本人那一票，
   * 登入方式讀 actor 上的 session 事實。拒絕：不是目前版本或內容核對碼不符 `VERSION_SUPERSEDED`、不是參與者或已失去資格
   * `NOT_PARTICIPANT`（管理員也是）、投過 `ALREADY_VOTED`、學生沒全同意老師先按 `STUDENTS_PENDING`、理由空 `VALIDATION_FAILED`。
   */
  respond(actor: ResolvedActor, input: RespondInput, requestId: string): Promise<Result<RespondReceipt>>

  /** 重置（S11-07）：收集中、等老師、已完成的版本 → 以同內容建新版重新收集（已完成的留作歷史）。理由必填。 */
  reset(actor: ResolvedActor, input: ReasonedVersionInput, requestId: string): Promise<Result<RestartReceipt>>

  /** 重開（S11-12；Roy 2026-09-25＝建新版本）：退回、已失效、已作廢的版本 → 以同內容建新版重新收集。理由必填。 */
  reopen(actor: ResolvedActor, input: ReasonedVersionInput, requestId: string): Promise<Result<RestartReceipt>>

  /** 作廢目前版本（S11-07）：之後誰都不能再表態；理由必填。 */
  voidVersion(actor: ResolvedActor, input: ReasonedVersionInput, requestId: string): Promise<Result<VoidReceipt>>

  /** 提醒還沒表態的參與者（S11-11）：同一版 24 小時內只能一次，只在收集中／等老師時可按。 */
  remind(actor: ResolvedActor, input: { readonly versionId: string }, requestId: string): Promise<Result<RemindReceipt>>

  /** 匯出某版本（S11-09）：可列印頁或 CSV 明細；每次匯出都存檔並留一筆 `signoff_exports`。只有管理員。 */
  exportVersion(actor: ResolvedActor, input: { readonly versionId: string; readonly format: SignoffExportFormat }): Promise<Result<SignoffExportFile>>
}

/**
 * 組員或主指導改變時，讓該組每個簽核包的目前版本失效（模組 07 §5 `supersedeForParticipantChange`、§6「由 03 呼叫（同 tx）」）。
 *
 * **在呼叫端的交易裡跑**：成員異動成功＝簽核同時失效，回滾就一起回滾。只標狀態、寫原因、留事件；**不自動建新版**
 * （RR05：新版由系辦建立）。已經失效或作廢的版本不動。回傳這次失效的版本 id。
 */
export interface SignoffParticipantHook<Tx = unknown> {
  supersedeForParticipantChange(
    tx: Tx,
    input: {
      readonly groupId: string
      readonly cause: 'member_change' | 'advisor_change'
      readonly actorUserId: string
      readonly realAt: Date
      readonly businessAt: Date
    },
  ): Promise<{ readonly supersededVersionIds: readonly string[] }>
}

export interface SignoffQuery {
  /** 管理員的簽核頁；不是管理員 → `FORBIDDEN`。 */
  adminBoard(actor: ResolvedActor, cohortId: string): Promise<Result<AdminSignoffBoard>>
  /** 版本頁：管理員、該版參與者、該組此刻的組員與主指導看得到；其他人 `FORBIDDEN`（不透露版本存不存在）。 */
  versionDetail(actor: ResolvedActor, versionId: string): Promise<Result<VersionDetail>>
  /** 學生自己的簽核（誰由 actor 決定）；不是學生回空的。 */
  studentView(actor: ResolvedActor): Promise<StudentSignoffView>
  /** 老師此刻指導的組的簽核（誰由 actor 決定）；不是老師回空清單。 */
  teacherView(actor: ResolvedActor): Promise<readonly TeacherSignoffCard[]>
}
