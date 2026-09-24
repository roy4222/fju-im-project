import type { ResolvedActor } from '@/application/accounts'
import type { FormField, ItemStatus, ReceiverUnit } from '@/application/items'
import type { DeclaredUpload, UploadTicket } from '@/application/ops'
import type { Answers } from '@/application/submissions/submissions'
import type { Result } from '@/shared/result'

/**
 * 模組 05 對外的 port（模組實作設計 05 §5 的 `SubmissionCommand`／`SubmissionQuery`；票 17 個人收件、票 21 組別收件與上傳）。
 *
 * 寫入的 port 自己做授權（在目前收件名單上、帳號正常、不是免填；組別收件還要此刻是那一組的有效組員）；
 * 收件者（本人或本組）一律由伺服器從登入者推出來，畫面不能指定。
 * 查詢的 port 只回「這個人自己的（或自己這一組的）」，呼叫它的頁面另外守角色。名單管理、免填、重開在後面的票（S08）。
 */

export type DraftReceipt = {
  readonly itemId: string
  /** 存好之後的草稿版本號；下次存或送出要帶這個（樂觀鎖）。 */
  readonly revision: number
  /** 伺服器存好的時間（真實時間，畫面顯示「已儲存 HH:MM」）。 */
  readonly savedAt: string
}

export type SubmitReceipt = {
  readonly itemId: string
  readonly title: string
  /** 第幾次正式送出（本人在這個項目上的版本號）。 */
  readonly versionNo: number
  /** 後端收到完整請求的業務時間：準時與否看這個（母 spec §4.11）。 */
  readonly receivedBusinessAt: string
  readonly receivedRealAt: string
  readonly submittedByName: string
  /** 照哪一版欄位填的。 */
  readonly schemaVersionNo: number
  readonly draftRevision: number
  /** 整組一份時的組別代號（回執寫「代表全組」）；個人收件是 null。 */
  readonly groupCode: string | null
  /** 這一版帶的附件（欄位、檔名、送出當下的 sha256）。 */
  readonly files: readonly { readonly fieldKey: string; readonly name: string; readonly checksum: string }[]
}

/** 主指導閱覽設定改好之後的回執（票 22；SUB-24）。 */
export type VisibilityReceipt = {
  readonly itemId: string
  readonly enabled: boolean
  /** 從第幾版欄位起送出的正式回答開放給主指導（舊回答不擴權）。 */
  readonly effectiveFromVersionNo: number
  readonly setAt: string
}

export interface SubmissionCommand {
  /**
   * 存草稿（個人收件）。`revision` 是畫面讀到的草稿版本號（還沒有草稿＝0）；
   * 資料庫裡的版本號對不上＝別的分頁或裝置已經存過，回 `CONFLICT`，不覆蓋。
   */
  saveDraft(actor: ResolvedActor, itemId: string, revision: number, answers: unknown, requestId: string): Promise<Result<DraftReceipt>>
  /**
   * 正式送出：把**已存的**草稿（版本號要對得上）切成一個不可變的正式版本，回收件回執。
   * 同一個 `requestId` 重送（連點、斷線重試）只算一次，回第一次的回執。
   */
  submit(actor: ResolvedActor, itemId: string, draftRevision: number, requestId: string): Promise<Result<SubmitReceipt>>
  /**
   * 替某個檔案欄位要一張上傳憑證（票 21；模組 10 §5 `issueUploadTicket`）。先判這個人現在能不能填這份收件
   * （名單、組員、開放、截止），再用那個欄位的規則（允許類型、大小上限）發 ticket。
   * 上傳本身走 `/api/files/upload`；上傳完成的檔案要在下一次存草稿時才綁到草稿上。
   */
  requestUpload(actor: ResolvedActor, itemId: string, fieldKey: string, declared: DeclaredUpload): Promise<Result<UploadTicket>>
  /**
   * 管理員開關「個人回答開放主指導閱覽」（票 22；模組實作設計 05 §5 `setAdvisorVisibility`；產品模組 05 §4「誰看得到個人回答」、SUB-24）。
   *
   * 只插不改：每改一次插一列。只對個人一份的收件。**已經有人作答（存過草稿或送出過）就不能開**
   * （`ITEM_HAS_RESPONSES`）：那些人填寫時沒看到「主指導可查看」的告知，舊回答不能因為後來改設定就給老師看，
   * 要另建一份收件或等之後的「新欄位版本」功能。關閉一律可以（收回權限不會擴權）。
   */
  setAdvisorVisibility(actor: ResolvedActor, itemId: string, enabled: boolean, requestId: string): Promise<Result<VisibilityReceipt>>
}

// ── 查詢 ──────────────────────────────────────────────────────────────────────

export type MyItemRow = {
  readonly itemId: string
  readonly title: string
  readonly stageName: string | null
  /** 設定的開放時間；null＝發布即開放。 */
  readonly opensAt: Date | null
  readonly dueAt: Date | null
  readonly attachmentCount: number
  readonly exempt: boolean
  readonly hasDraft: boolean
  readonly latestVersionNo: number | null
  readonly latestReceivedAt: Date | null
  /** 個人一份或整組一份。 */
  readonly receiverUnit: 'individual' | 'group'
  /** 整組一份時是自己這一組的代號。 */
  readonly groupCode: string | null
}

export type SubmissionFile = { readonly fileId: string; readonly name: string; readonly sizeBytes: number }

/** 繳交裡的一個附件（草稿或正式版本）。 */
export type AnswerFile = {
  readonly fieldKey: string
  readonly fileId: string
  readonly name: string
  readonly sizeBytes: number
  /** sha256（hex）；正式版本是送出當下抄下來的那一個。 */
  readonly checksum: string
}

/** 整組一份時畫面上方的組別資訊（原型 `groupinfo`）。 */
export type GroupSummary = {
  readonly groupId: string
  readonly code: string
  readonly members: readonly { readonly userId: string; readonly name: string; readonly isLeader: boolean }[]
  readonly advisorName: string | null
}

export type VersionSummary = {
  readonly versionNo: number
  readonly receivedBusinessAt: Date
  readonly receivedRealAt: Date
  readonly submittedByName: string
  readonly schemaVersionNo: number
  /** 回執編號（就是送出時的請求編號）。 */
  readonly requestId: string
}

export type MyItemDetail = {
  readonly itemId: string
  readonly title: string
  readonly summary: string
  /** 目前內容版本的正文（已清理過；輸出前畫面再清一次）。 */
  readonly bodyHtml: string
  readonly attachments: readonly SubmissionFile[]
  readonly stageName: string | null
  readonly opensAt: Date | null
  readonly dueAt: Date | null
  readonly schemaVersionNo: number
  readonly fields: readonly FormField[]
  readonly exempt: boolean
  readonly receiverUnit: 'individual' | 'group'
  /** 整組一份：自己這一組；個人一份是 null。 */
  readonly group: GroupSummary | null
  /** 個人回答開放主指導閱覽（填寫前要明示，產品模組 05 SUB-24）。 */
  readonly advisorCanView: boolean
  readonly draft: {
    readonly answers: Answers
    readonly revision: number
    readonly updatedAt: Date
    /** 最後存的人（組別共用草稿會是任何一位組員）。 */
    readonly updatedByName: string | null
    readonly files: readonly AnswerFile[]
  } | null
  /** 本人每一次正式送出，新的在前。 */
  readonly versions: readonly VersionSummary[]
}

export type MyVersionDetail = VersionSummary & {
  readonly isLatest: boolean
  /** 送出當時的欄位（那一版的欄位結構）。 */
  readonly fields: readonly FormField[]
  readonly answers: Answers
  readonly files: readonly AnswerFile[]
}

/**
 * 「我的繳交紀錄」一列（票 22；產品模組 05 SUB-20、25）：本人讀得到、但已經不在作業區的正式版本。
 * 被移出組別的人（只算送出當下自己在組裡的那幾版）、被移出個人收件名單的人（自己的回答）。
 */
export type MyRecordRow = {
  readonly itemId: string
  readonly title: string
  readonly receiverKind: 'user' | 'group'
  readonly receiverId: string
  /** 組別收件：那一組的代號。 */
  readonly groupCode: string | null
  /** 本人讀得到的版本數。 */
  readonly versionCount: number
  readonly latestVersionNo: number
  readonly latestReceivedAt: Date
}

export type MyRecordDetail = {
  readonly itemId: string
  readonly title: string
  readonly receiverKind: 'user' | 'group'
  readonly receiverId: string
  readonly groupCode: string | null
  /** 本人讀得到的正式版本（新的在前）。 */
  readonly versions: readonly VersionSummary[]
}

export interface SubmissionQuery {
  /** 作業區：自己（個人收件）或自己此刻所在的組（組別收件）在目前收件名單上的收件（發布中），依截止排序。 */
  myItems(userId: string): Promise<MyItemRow[]>
  /** 內容頁：不在目前名單上（或不是這一組的有效組員、沒發布）回 null。 */
  myItem(userId: string, itemId: string): Promise<MyItemDetail | null>
  /** 某一次正式送出的內容（唯讀）。只回自己的（組別收件：自己此刻所在那一組的）。 */
  myVersion(userId: string, itemId: string, versionNo: number): Promise<MyVersionDetail | null>
  /** 我的繳交紀錄（唯讀）：讀得到、但不在作業區的正式版本，依收件分組（票 22）。 */
  myRecords(userId: string): Promise<MyRecordRow[]>
  /** 某一份紀錄：本人讀得到的版本；一版都讀不到回 null（不透露這份收件存在）。 */
  myRecord(userId: string, itemId: string, receiverId: string): Promise<MyRecordDetail | null>
  /** 紀錄裡某一版的內容；讀不到回 null。 */
  myRecordVersion(userId: string, itemId: string, receiverId: string, versionNo: number): Promise<MyVersionDetail | null>
}

// ── 收件名單（票 18，管理員）─────────────────────────────────────────────────

/** 名單頁頂端的項目資訊。 */
export type RosterItem = {
  readonly itemId: string
  readonly cohortId: string
  readonly cohortCode: string
  readonly title: string
  readonly status: ItemStatus
  readonly receiverUnit: ReceiverUnit
  readonly stageName: string | null
  readonly opensAt: Date | null
  readonly dueAt: Date | null
  /** 目前發布中的欄位版本（還沒發布過是 null）。 */
  readonly schemaVersionNo: number | null
  readonly fields: readonly FormField[]
}

/** 名單上的一位收件者（人或組）。同一收件者有多列時只取「目前那一列」，沒有目前的就取最後一次移出的那一列。 */
export type RosterEntry = {
  readonly receiverKind: 'user' | 'group'
  readonly receiverId: string
  /** 人：顯示名稱；組：組別代號。 */
  readonly name: string
  readonly studentNo: string | null
  /** 人目前所在的組（本屆）；組別收件就是自己的代號。 */
  readonly groupCode: string | null
  /** 這一列的資格生效時間（業務時間）。 */
  readonly eligibleFrom: Date
  /** 移出時間；null＝還在名單上。 */
  readonly eligibleTo: Date | null
  /** 自動展開或管理員加入。 */
  readonly source: 'auto' | 'admin'
  readonly exempt: boolean
  readonly exemptReason: string | null
  readonly removedReason: string | null
  readonly hasDraft: boolean
  readonly latestVersionNo: number | null
  readonly latestReceivedAt: Date | null
  readonly latestSubmittedByName: string | null
}

export type ItemRoster = { readonly item: RosterItem; readonly entries: readonly RosterEntry[] }

/** 名單列的歷史（加入、免填、移出；新的在前）。 */
export type RosterSpan = {
  readonly eligibleFrom: Date
  readonly eligibleTo: Date | null
  readonly source: 'auto' | 'admin'
  readonly exempt: boolean
  readonly exemptReason: string | null
  readonly removedReason: string | null
}

export type ReceiverDetail = {
  readonly item: RosterItem
  readonly entry: RosterEntry
  readonly spans: readonly RosterSpan[]
  /** 草稿只給「有沒有、最後存的時間」：管理員看的是正式送出的版本，草稿內容不在名單頁出現。 */
  readonly draftUpdatedAt: Date | null
  /** 每一次正式送出，新的在前。已移出的人也列（回答保留）。 */
  readonly versions: readonly VersionSummary[]
}

/**
 * 收件名單頁的查詢（模組實作設計 05 §5 `SubmissionQuery` 的管理員部分）。
 *
 * 每個方法自己再判一次授權（只有系辦管理員；老師與學生一律拿不到，回 null）——頁面的角色守衛不是唯一的一道。
 * 主指導看正式回答走另一個 port：`AdvisorSubmissionQuery`（票 22）。
 */
/** 名單頁的「主指導閱覽」面板（票 22；只有個人一份的收件有）。 */
export type AdvisorVisibilityView = {
  /** 最新一列；沒設過是 null（＝不開放）。 */
  readonly current: {
    readonly enabled: boolean
    readonly effectiveFromVersionNo: number
    readonly setAt: Date
    readonly setByName: string
  } | null
  /** 已經有人作答（存過草稿或送出過）：不能再開。 */
  readonly hasResponses: boolean
}

export interface RosterQuery {
  roster(actor: ResolvedActor, itemId: string): Promise<ItemRoster | null>
  /** 某一位收件者的名單歷史與正式版本。不在這份收件的名單上（從來沒在過）回 null。 */
  receiver(actor: ResolvedActor, itemId: string, receiverId: string): Promise<ReceiverDetail | null>
  /** 某一位收件者某一次正式送出的內容（唯讀）。 */
  receiverVersion(actor: ResolvedActor, itemId: string, receiverId: string, versionNo: number): Promise<MyVersionDetail | null>
  /** 主指導閱覽的目前設定（個人一份才有；整組一份、不是管理員回 null）。 */
  advisorVisibility(actor: ResolvedActor, itemId: string): Promise<AdvisorVisibilityView | null>
}

// ── 主指導（票 22，老師）──────────────────────────────────────────────────────

/** 老師此刻指導的一組（`advisor_assignments.valid_to IS NULL`、組別沒解散）。 */
export type AdvisedGroup = {
  readonly groupId: string
  readonly code: string
  readonly groupType: 'general' | 'industry'
  readonly cohortId: string
  readonly cohortCode: string
  readonly memberNames: readonly string[]
}

/** 矩陣的一欄：老師指導組別所在屆別、發布中、整組一份的收件。 */
export type AdvisorMatrixItem = {
  readonly itemId: string
  readonly title: string
  readonly cohortId: string
  readonly stageName: string | null
  readonly opensAt: Date | null
  readonly dueAt: Date | null
}

/**
 * 矩陣的一格（一組 × 一份收件）。那一組不在這份收件的名單上就沒有這一格。
 * **沒有草稿欄位**：老師看不到組別共用草稿（契約 03 §1），連「有沒有草稿」都不給——畫面照「未繳」顯示。
 */
export type AdvisorMatrixCell = {
  readonly groupId: string
  readonly itemId: string
  readonly eligibleTo: Date | null
  readonly exempt: boolean
  readonly latestVersionNo: number | null
  readonly latestReceivedAt: Date | null
  readonly latestSubmittedByName: string | null
}

/** 開放主指導閱覽的個人收件（老師指導的學生裡：應交幾位、幾位已有老師看得到的正式版本）。 */
export type AdvisorIndividualItem = AdvisorMatrixItem & {
  readonly effectiveFromVersionNo: number
  readonly required: number
  readonly submitted: number
}

export type AdvisorMatrix = {
  readonly groups: readonly AdvisedGroup[]
  readonly items: readonly AdvisorMatrixItem[]
  readonly cells: readonly AdvisorMatrixCell[]
  readonly individualItems: readonly AdvisorIndividualItem[]
}

/**
 * 老師看某一份收件：只列自己此刻指導的組（整組一份）或那些組裡的學生（個人一份、而且開放主指導閱覽）。
 * `entries` 的 `hasDraft` 一律是 false（不給老師看草稿）；個人一份的最後一版只算老師看得到的那幾版。
 */
export type AdvisorItemView = {
  readonly item: RosterItem
  readonly entries: readonly RosterEntry[]
  /** 個人一份：主指導閱覽的生效欄位版本；整組一份是 null。 */
  readonly effectiveFromVersionNo: number | null
}

export type AdvisorReceiverView = {
  readonly item: RosterItem
  readonly entry: RosterEntry
  /** 老師看得到的正式版本（新的在前）；跟組員、系辦看到的是同一份（同一段查詢）。 */
  readonly versions: readonly VersionSummary[]
}

/**
 * 主指導看繳交（模組實作設計 05 §5 `SubmissionQuery` 的老師部分；契約 03 §1「組別正式版本：目前主指導」
 * 「個人回答：主指導只在項目開放閱覽、版本 ≥ 生效版本、目前有效指導關係時看正式版本」）。
 *
 * 每個方法自己判授權（帳號正常＋老師角色），看得到的版本一律經 `canReadSubmission`：列表列得出來的，
 * 就是點得開、附件下載得到的。換掉的老師、不是主指導的老師回 null（頁面 404）。
 */
export interface AdvisorSubmissionQuery {
  matrix(actor: ResolvedActor): Promise<AdvisorMatrix | null>
  item(actor: ResolvedActor, itemId: string): Promise<AdvisorItemView | null>
  receiver(actor: ResolvedActor, itemId: string, receiverId: string): Promise<AdvisorReceiverView | null>
  receiverVersion(actor: ResolvedActor, itemId: string, receiverId: string, versionNo: number): Promise<MyVersionDetail | null>
}
