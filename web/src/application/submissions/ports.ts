import type { ResolvedActor } from '@/application/accounts'
import type { FormField } from '@/application/items'
import type { Answers } from '@/application/submissions/submissions'
import type { Result } from '@/shared/result'

/**
 * 模組 05 對外的 port（模組實作設計 05 §5 的 `SubmissionCommand`／`SubmissionQuery`，票 17 個人收件的部分）。
 *
 * 寫入的 port 自己做授權（在目前收件名單上、帳號正常、不是免填）；查詢的 port 只回「這個人自己的」，
 * 呼叫它的頁面另外守角色。名單管理、免填、重開、組別收件、上傳在後面的票（18、21、S08）。
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
}

export type SubmissionFile = { readonly fileId: string; readonly name: string; readonly sizeBytes: number }

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
  readonly draft: {
    readonly answers: Answers
    readonly revision: number
    readonly updatedAt: Date
  } | null
  /** 本人每一次正式送出，新的在前。 */
  readonly versions: readonly VersionSummary[]
}

export type MyVersionDetail = VersionSummary & {
  readonly isLatest: boolean
  /** 送出當時的欄位（那一版的欄位結構）。 */
  readonly fields: readonly FormField[]
  readonly answers: Answers
}

export interface SubmissionQuery {
  /** 作業區：自己在目前收件名單上的個人收件（發布中），依截止排序。 */
  myItems(userId: string): Promise<MyItemRow[]>
  /** 內容頁：不在目前名單上（或不是個人收件、沒發布）回 null。 */
  myItem(userId: string, itemId: string): Promise<MyItemDetail | null>
  /** 某一次正式送出的內容（唯讀）。只回自己的。 */
  myVersion(userId: string, itemId: string, versionNo: number): Promise<MyVersionDetail | null>
}
