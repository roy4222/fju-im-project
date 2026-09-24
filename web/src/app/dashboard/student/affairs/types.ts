/** 作業區 Server Action 回給畫面的形狀（`actions.ts` 只能匯出 async 函式，型別放這裡）。 */

export type AffairOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string; fields?: string[] }

/** 收件章要顯示的內容（伺服器排好的字，畫面只顯示）。 */
export type ReceiptView = {
  title: string
  versionNo: number
  submittedByName: string
  receivedText: string
  schemaVersionNo: number
  /** 回執編號＝送出時的請求編號；繳交歷史也列得到。 */
  receiptNo: string
  sentence: string
  /** 整組一份時的組別代號（「代表全組」）；個人收件是 null。 */
  groupCode: string | null
  /** 這一版帶的附件：欄位、檔名、sha256 前 12 碼。 */
  files: { fieldKey: string; name: string; checksumShort: string }[]
}

/** 上傳前向伺服器要的憑證（`requestUploadAction`）。 */
export type UploadGrant = { ticket: string; fileId: string; maxBytes: number }

/** 畫面上一個已附上的檔。 */
export type FileMeta = { name: string; sizeBytes: number }
