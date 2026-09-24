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

export interface SubmissionQuery {
  /** 作業區：自己（個人收件）或自己此刻所在的組（組別收件）在目前收件名單上的收件（發布中），依截止排序。 */
  myItems(userId: string): Promise<MyItemRow[]>
  /** 內容頁：不在目前名單上（或不是這一組的有效組員、沒發布）回 null。 */
  myItem(userId: string, itemId: string): Promise<MyItemDetail | null>
  /** 某一次正式送出的內容（唯讀）。只回自己的（組別收件：自己此刻所在那一組的）。 */
  myVersion(userId: string, itemId: string, versionNo: number): Promise<MyVersionDetail | null>
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
 * 主指導閱覽正式回答在票 21／22 才接。
 */
export interface RosterQuery {
  roster(actor: ResolvedActor, itemId: string): Promise<ItemRoster | null>
  /** 某一位收件者的名單歷史與正式版本。不在這份收件的名單上（從來沒在過）回 null。 */
  receiver(actor: ResolvedActor, itemId: string, receiverId: string): Promise<ReceiverDetail | null>
  /** 某一位收件者某一次正式送出的內容（唯讀）。 */
  receiverVersion(actor: ResolvedActor, itemId: string, receiverId: string, versionNo: number): Promise<MyVersionDetail | null>
}
