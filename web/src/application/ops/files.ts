import type { ResolvedActor } from '@/application/accounts'
import type { Result } from '@/shared/result'

/**
 * 共用檔案能力的規則面（模組 10 §2、§3、§5；契約 02 §6；契約 03 §5）。
 *
 * 「安全上傳一個檔 → 綁到資料上 → 每次下載重新驗權限」是所有用途共用的一條路：
 * 名單 CSV（票 6）、公告附件（S04）、組別繳交（S07）都走這裡，差別只在
 * **上傳規則**（允許類型、大小）與**下載政策**（誰可以拿）。
 *
 * 這個檔只有規則，沒有檔案系統也沒有資料庫：
 * 類型白名單、內容檢查（magic bytes／純文字檢查）、檔名安全化、storage key 的樣子，
 * 都是可以單獨測的純函式。真正寫檔與查表在 `infrastructure/ops/file-storage.ts`。
 */

// ── 用途與引用 ───────────────────────────────────────────────────────────────

/** 與 `stored_files_purpose_check` 一致。 */
export type FilePurpose =
  | 'submission'
  | 'attachment'
  | 'roster_csv'
  | 'advisor_csv'
  | 'poster'
  | 'photo'
  | 'export'
  | 'signoff_attachment'

/** 與 `file_references_ref_type_check` 一致。 */
export type FileRefType =
  | 'draft'
  | 'submission_version'
  | 'item_attachment'
  | 'signoff_version'
  | 'showcase_version'
  | 'showcase_draft'
  | 'export'
  | 'roster_version'

export type FileRef = { readonly refType: FileRefType; readonly refId: string }

// ── 類型白名單與內容檢查 ─────────────────────────────────────────────────────

/** v1 檔案政策的允許類型（模組 10 §11.2），每個用途再縮小。 */
export type FileTypeId = 'csv' | 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'png' | 'jpg' | 'zip'

type FileTypeSpec = {
  readonly extensions: readonly string[]
  /**
   * 瀏覽器可能宣告的 MIME。宣告值是**使用者可控的**，所以只拿來擋明顯不對的組合，
   * 真正的判定看內容（下面的 `createContentInspector`）。
   */
  readonly declaredMimes: readonly string[]
  /** 內容檢查通過後存進 `mime_detected` 的正規值，下載時也用這個。 */
  readonly canonicalMime: string
  readonly content: { readonly kind: 'signature'; readonly signatures: readonly (readonly number[])[] } | { readonly kind: 'utf8_text' }
}

const ZIP_SIGNATURES = [[0x50, 0x4b, 0x03, 0x04]] as const
// 空 ZIP 與分割 ZIP 的簽章只對 zip 本身有意義；Office 檔一定是一般的 local file header。
const ZIP_ALL_SIGNATURES = [...ZIP_SIGNATURES, [0x50, 0x4b, 0x05, 0x06], [0x50, 0x4b, 0x07, 0x08]] as const
const GENERIC_BINARY = 'application/octet-stream'

export const FILE_TYPES: Readonly<Record<FileTypeId, FileTypeSpec>> = {
  csv: {
    extensions: ['csv'],
    // Windows 上的 Excel 會把 CSV 宣告成 vnd.ms-excel；有些瀏覽器給 text/plain 或乾脆空白。
    declaredMimes: ['text/csv', 'text/plain', 'application/csv', 'application/vnd.ms-excel', GENERIC_BINARY, ''],
    canonicalMime: 'text/csv',
    content: { kind: 'utf8_text' },
  },
  pdf: {
    extensions: ['pdf'],
    declaredMimes: ['application/pdf', GENERIC_BINARY, ''],
    canonicalMime: 'application/pdf',
    content: { kind: 'signature', signatures: [[0x25, 0x50, 0x44, 0x46, 0x2d]] },
  },
  docx: {
    extensions: ['docx'],
    declaredMimes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', GENERIC_BINARY, ''],
    canonicalMime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    content: { kind: 'signature', signatures: ZIP_SIGNATURES },
  },
  xlsx: {
    extensions: ['xlsx'],
    declaredMimes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', GENERIC_BINARY, ''],
    canonicalMime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    content: { kind: 'signature', signatures: ZIP_SIGNATURES },
  },
  pptx: {
    extensions: ['pptx'],
    declaredMimes: ['application/vnd.openxmlformats-officedocument.presentationml.presentation', GENERIC_BINARY, ''],
    canonicalMime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    content: { kind: 'signature', signatures: ZIP_SIGNATURES },
  },
  png: {
    extensions: ['png'],
    declaredMimes: ['image/png', ''],
    canonicalMime: 'image/png',
    content: { kind: 'signature', signatures: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]] },
  },
  jpg: {
    extensions: ['jpg', 'jpeg'],
    declaredMimes: ['image/jpeg', 'image/pjpeg', ''],
    canonicalMime: 'image/jpeg',
    content: { kind: 'signature', signatures: [[0xff, 0xd8, 0xff]] },
  },
  zip: {
    extensions: ['zip'],
    declaredMimes: ['application/zip', 'application/x-zip-compressed', GENERIC_BINARY, ''],
    canonicalMime: 'application/zip',
    content: { kind: 'signature', signatures: ZIP_ALL_SIGNATURES },
  },
}

/**
 * 常見的「不是文字」簽章。純文字類型（CSV）沒有 magic bytes，
 * 所以反過來檢查：開頭像執行檔、PDF、壓縮檔、圖片、舊版 Office 的，一律不是 CSV。
 */
const BINARY_SIGNATURES: readonly (readonly number[])[] = [
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0xcf, 0xfa, 0xed, 0xfe], // Mach-O
  [0xfe, 0xed, 0xfa, 0xcf],
  [0xca, 0xfe, 0xba, 0xbe],
  [0x25, 0x50, 0x44, 0x46, 0x2d], // %PDF-
  [0x50, 0x4b, 0x03, 0x04], // ZIP／Office
  [0x50, 0x4b, 0x05, 0x06],
  [0x89, 0x50, 0x4e, 0x47], // PNG
  [0xff, 0xd8, 0xff], // JPEG
  [0x47, 0x49, 0x46, 0x38, 0x37, 0x61], // GIF87a
  [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], // GIF89a
  [0xd0, 0xcf, 0x11, 0xe0], // 舊版 Office（.xls／.doc）
  [0x1f, 0x8b], // gzip
  [0x52, 0x61, 0x72, 0x21, 0x1a], // RAR
  [0x37, 0x7a, 0xbc, 0xaf], // 7z
]

/**
 * Windows 執行檔以 `MZ` 開頭。只看兩個字母會誤殺以「MZ」開頭的正常文字，
 * 所以要求第三個位元組不是可列印字元（真的 .exe 幾乎都是 0x90 或 0x00）。
 */
function looksLikeWindowsExecutable(head: Uint8Array): boolean {
  return head.length > 2 && head[0] === 0x4d && head[1] === 0x5a && (head[2]! < 0x20 || head[2]! >= 0x7f)
}

/** 看前幾個位元組就夠判斷簽章。 */
export const SIGNATURE_HEAD_BYTES = 16

function startsWith(head: Uint8Array, signature: readonly number[]): boolean {
  if (head.length < signature.length) return false
  return signature.every((byte, index) => head[index] === byte)
}

/** 從檔名取副檔名（小寫、不含點）。沒有副檔名回空字串。 */
export function extensionOf(fileName: string): string {
  const base = baseNameOf(fileName)
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return ''
  return base.slice(dot + 1).toLowerCase()
}

/** 副檔名對到哪一個允許類型；不在這次的白名單裡回 null。 */
export function typeForExtension(extension: string, allowed: readonly FileTypeId[]): FileTypeId | null {
  const ext = extension.toLowerCase()
  return allowed.find((id) => FILE_TYPES[id].extensions.includes(ext)) ?? null
}

/**
 * 逐塊檢查上傳內容。上傳是串流的，所以檢查也是：每收到一塊就 `push`，全部收完再 `finish`。
 *
 * - 有簽章的類型：看開頭幾個位元組。
 * - 純文字類型（CSV）：開頭不能是已知的二進位簽章、整份要是合法 UTF-8、不能有 NUL 與其他控制字元
 *   （Tab、換行、歸位除外）。一個 .exe 改名成 .csv，第一關就被 MZ 擋掉；
 *   就算是沒見過的二進位格式，也幾乎不可能通過「整份合法 UTF-8 且沒有控制字元」。
 */
export type ContentInspector = {
  push(chunk: Uint8Array): void
  finish(): { readonly ok: true } | { readonly ok: false; readonly reason: string }
}

export function createContentInspector(type: FileTypeId): ContentInspector {
  const spec = FILE_TYPES[type]
  const head = new Uint8Array(SIGNATURE_HEAD_BYTES)
  let headLength = 0
  let failure: string | null = null
  const decoder = spec.content.kind === 'utf8_text' ? new TextDecoder('utf-8', { fatal: true }) : null

  return {
    push(chunk) {
      if (headLength < SIGNATURE_HEAD_BYTES) {
        const take = Math.min(SIGNATURE_HEAD_BYTES - headLength, chunk.length)
        head.set(chunk.subarray(0, take), headLength)
        headLength += take
      }
      if (failure || !decoder) return
      for (const byte of chunk) {
        // 0x09 Tab、0x0A LF、0x0D CR 以外的 C0 控制字元，以及 DEL。
        if ((byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) || byte === 0x7f) {
          failure = '內容含有控制字元，不是純文字檔'
          return
        }
      }
      try {
        decoder.decode(chunk, { stream: true })
      } catch {
        failure = '內容不是 UTF-8 文字'
      }
    },
    finish() {
      const headBytes = head.subarray(0, headLength)
      if (spec.content.kind === 'signature') {
        const matched = spec.content.signatures.some((signature) => startsWith(headBytes, signature))
        return matched ? { ok: true } : { ok: false, reason: '檔案內容與副檔名不符' }
      }
      if (looksLikeWindowsExecutable(headBytes) || BINARY_SIGNATURES.some((signature) => startsWith(headBytes, signature))) {
        return { ok: false, reason: '檔案內容與副檔名不符（看起來是二進位檔）' }
      }
      if (failure) return { ok: false, reason: failure }
      try {
        decoder?.decode()
      } catch {
        return { ok: false, reason: '內容不是 UTF-8 文字' }
      }
      return { ok: true }
    },
  }
}

// ── 上傳規則 ────────────────────────────────────────────────────────────────

/** 一次上傳的規則：由發 ticket 的用例決定（誰、什麼用途、哪些類型、多大）。 */
export type UploadRules = {
  readonly purpose: FilePurpose
  readonly allowedTypes: readonly FileTypeId[]
  /** 這個用途（或項目）的上限；實際上限還要跟環境上限取小（模組 10 §11.2）。 */
  readonly maxBytes: number
  readonly scope: { readonly kind: 'global' } | { readonly kind: 'cohort'; readonly cohortId: string }
}

/** 單檔上限＝環境設定與項目設定的較小值（模組 10 §11.2）。 */
export function effectiveMaxBytes(ruleMaxBytes: number, environmentMaxBytes: number): number {
  return Math.max(0, Math.min(ruleMaxBytes, environmentMaxBytes))
}

export type DeclaredUpload = {
  readonly fileName: string
  readonly declaredMime: string
  /** 瀏覽器回報的大小；只用來提早擋，實際以收到的位元組為準。 */
  readonly declaredSize?: number
}

/**
 * 發 ticket 前的第一關：副檔名在白名單、宣告 MIME 合理、宣告大小沒超過。
 * 內容檢查要等位元組真的進來才做（`createContentInspector`）。
 */
export function checkDeclaredUpload(
  input: DeclaredUpload,
  rules: UploadRules,
  environmentMaxBytes: number,
): { ok: true; type: FileTypeId; extension: string; displayName: string } | { ok: false; code: 'FILE_TYPE_REJECTED' | 'FILE_TOO_LARGE' | 'VALIDATION_FAILED'; message: string } {
  const displayName = sanitizeDisplayName(input.fileName)
  const extension = extensionOf(displayName)
  const type = typeForExtension(extension, rules.allowedTypes)
  const allowedList = rules.allowedTypes.flatMap((id) => FILE_TYPES[id].extensions).map((e) => `.${e}`).join('、')
  if (!type) {
    return { ok: false, code: 'FILE_TYPE_REJECTED', message: `只接受 ${allowedList} 檔。` }
  }
  const mime = input.declaredMime.trim().toLowerCase().split(';')[0]!.trim()
  if (!FILE_TYPES[type].declaredMimes.includes(mime)) {
    return { ok: false, code: 'FILE_TYPE_REJECTED', message: `檔案類型與副檔名不符，只接受 ${allowedList} 檔。` }
  }
  const limit = effectiveMaxBytes(rules.maxBytes, environmentMaxBytes)
  if (input.declaredSize !== undefined) {
    if (!Number.isFinite(input.declaredSize) || input.declaredSize < 0) {
      return { ok: false, code: 'VALIDATION_FAILED', message: '檔案大小不正確。' }
    }
    if (input.declaredSize === 0) return { ok: false, code: 'VALIDATION_FAILED', message: '檔案是空的。' }
    if (input.declaredSize > limit) {
      return { ok: false, code: 'FILE_TOO_LARGE', message: `檔案超過上限 ${formatBytes(limit)}。` }
    }
  }
  return { ok: true, type, extension, displayName }
}

// ── 檔名、storage key、下載標頭 ───────────────────────────────────────────────

/** 取路徑最後一段：`../../etc/passwd` → `passwd`、`C:\\x\\y.csv` → `y.csv`。 */
export function baseNameOf(fileName: string): string {
  const parts = fileName.split(/[/\\]/)
  return parts[parts.length - 1] ?? ''
}

const DISPLAY_NAME_MAX = 150

/**
 * 顯示用檔名（`stored_files.original_name`）。
 *
 * 只拿來**顯示與下載時命名**，從來不拿來組路徑（路徑用系統產生的 storage key）。
 * 仍然清乾淨：去掉路徑、控制字元、雙向文字控制符（可以把 `exe.csv` 顯示成 `vsc.exe`）、
 * Windows 不允許的字元，限制長度但保留副檔名。
 */
export function sanitizeDisplayName(fileName: string): string {
  const cleaned = [...baseNameOf(fileName.normalize('NFC'))]
    // C0／C1 控制字元與 DEL
    .filter((ch) => {
      const code = ch.charCodeAt(0)
      return !(code <= 0x1f || (code >= 0x7f && code <= 0x9f))
    })
    .join('')
    // 雙向文字控制符與零寬字元
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    // 不能只剩點（`..`）或以點開頭變成隱藏檔。
    .replace(/^\.+/, '')

  if (cleaned === '') return 'file'
  if (cleaned.length <= DISPLAY_NAME_MAX) return cleaned

  const dot = cleaned.lastIndexOf('.')
  const ext = dot > 0 && cleaned.length - dot <= 10 ? cleaned.slice(dot) : ''
  return cleaned.slice(0, DISPLAY_NAME_MAX - ext.length) + ext
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value)
}

/**
 * 系統產生的 storage key（模組 10 §3：`files/<yyyy>/<mm>/<id>`）。
 *
 * 只由檔案 ID（uuidv7）與日期組成，**不含原始檔名**——猜不到、也不會跟別人撞。
 * 猜不到不代表安全：下載一律經授權用例（契約 03 §4）。
 */
export function storageKeyFor(fileId: string, at: Date): string {
  if (!isUuid(fileId)) throw new RangeError(`檔案 ID 格式不對：${fileId}`)
  const yyyy = String(at.getUTCFullYear()).padStart(4, '0')
  const mm = String(at.getUTCMonth() + 1).padStart(2, '0')
  return `files/${yyyy}/${mm}/${fileId}`
}

/** 上傳中的暫存位置（模組 10 §3：`tmp/<id>`）。 */
export function tempKeyFor(fileId: string): string {
  if (!isUuid(fileId)) throw new RangeError(`檔案 ID 格式不對：${fileId}`)
  return `tmp/${fileId}`
}

/**
 * 下載用的 `Content-Disposition`（一律 attachment，不讓瀏覽器直接開）。
 *
 * `filename=` 給舊瀏覽器一個純 ASCII 的名字，`filename*=` 帶 UTF-8 的真名（RFC 6266／5987）。
 * 換行與引號在兩邊都拿掉，避免標頭注入。
 */
export function contentDispositionFor(displayName: string): string {
  const safe = sanitizeDisplayName(displayName)
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_').replace(/["\\;]/g, '_')
  const encoded = encodeURIComponent(safe).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MiB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`
  return `${bytes} B`
}

// ── 下載政策 ────────────────────────────────────────────────────────────────

/** 下載政策看得到的檔案事實。 */
export type FileFacts = {
  readonly id: string
  readonly purpose: FilePurpose
  readonly ownerUserId: string
  readonly scope: 'cohort' | 'global'
  readonly cohortId: string | null
  /** 目前有效（未釋放）的引用。 */
  readonly references: readonly FileRef[]
}

/**
 * 某個用途的檔案，這個人現在能不能下載。
 *
 * 每次下載都呼叫（契約 03 §4：uuid 猜不到但不當授權）。回 false 一律變成「無法存取」，
 * 不告訴對方是「沒有這個檔」還是「不是你的」。
 *
 * `actor` 可能是**訪客**（票 16：公開公告的附件訪客也能下載）。政策沒有明說放行訪客就是拒絕，
 * 訪客被拒絕時回 401（請先登入），已登入被拒絕回 403。待審、必須改密的人在政策之前就被擋。
 */
export type DownloadPolicy = (actor: ResolvedActor, file: FileFacts) => Promise<boolean> | boolean

/** 用途 → 下載政策。沒登記的用途一律拒絕（預設拒絕，不是預設放行）。 */
export type DownloadPolicies = Partial<Record<FilePurpose, DownloadPolicy>>

// ── port ────────────────────────────────────────────────────────────────────

export type AttachExpectation =
  | { readonly purpose: FilePurpose; readonly ownerUserId: string | readonly string[] }
  | { readonly purpose: FilePurpose; readonly heldBy: FileRef }

export type UploadTicket = {
  readonly ticket: string
  readonly fileId: string
  readonly maxBytes: number
  readonly expiresAt: string
}

export type StoredFileReceipt = {
  readonly fileId: string
  readonly originalName: string
  readonly sizeBytes: number
  /** sha256（hex）。 */
  readonly checksum: string
  readonly mimeDetected: string
}

export type StoredFileContent = {
  readonly fileId: string
  readonly originalName: string
  readonly checksum: string
  readonly bytes: Uint8Array
}

export type FileDownload = {
  readonly fileId: string
  readonly originalName: string
  readonly sizeBytes: number
  readonly mime: string
  readonly checksum: string
  readonly body: ReadableStream<Uint8Array>
}

/**
 * 共用檔案能力（模組 10 §5 `FileStorage`）。
 *
 * 流程：用例授權後 `issueUploadTicket` → 瀏覽器把位元組 POST 到 `/api/files/upload?ticket=`
 * → `upload` 串流寫暫存、邊算 sha256、邊檢查內容 → 通過才變 `stored`
 * → 業務用例在自己的交易裡 `attach` 綁到資料上 → 下載時 `authorizeDownload` 每次重驗。
 *
 * `Tx` 是 infrastructure 的交易把手，這一層只當它是不透明的東西（同 `AuditWriter`）。
 */
export interface FileStorage<Tx = unknown> {
  /** 建一筆 `uploading` 的檔案列並發一張有時效、綁上傳者的 ticket。呼叫前由用例自己做授權。 */
  issueUploadTicket(ownerUserId: string, input: DeclaredUpload, rules: UploadRules): Promise<Result<UploadTicket>>

  /** 收位元組：驗 ticket 與上傳者、限大小、驗內容、算 checksum，成功才標成 `stored`。 */
  upload(
    uploaderUserId: string,
    ticket: string,
    body: ReadableStream<Uint8Array>,
    declaredLength: number | null,
  ): Promise<Result<StoredFileReceipt>>

  /** 讀回自己上傳的某個用途的小檔（例如預覽名單）。不是自己的、用途不對、還沒 stored 一律拒絕。 */
  readOwned(ownerUserId: string, fileId: string, purpose: FilePurpose, maxBytes: number): Promise<Result<StoredFileContent>>

  /**
   * 在業務交易裡把檔案綁到一筆資料上（鎖住檔案列再檢查）。
   *
   * 「這個檔能不能綁」有兩種證明（`expect`）：
   * - `ownerUserId`：上傳者是這個人（或這幾個人之一——組別共用草稿時是此刻的有效組員，票 21）。
   * - `heldBy`：這個檔已經被某個引用者有效引用著（例如正式送出時，把草稿上已經附好的檔再綁到正式版本；
   *   上傳它的組員之後被移出也一樣送得出去）。
   */
  attach(tx: Tx, fileId: string, ref: FileRef, expect: AttachExpectation): Promise<Result<{ referenceId: string; checksum: string }>>

  /** 解除引用：只設 `released_at`，之後同一個引用者可以再附回來（契約 01 §11）。 */
  release(tx: Tx, fileId: string, ref: FileRef): Promise<void>

  /** 每次下載都重新授權；通過才回串流。 */
  authorizeDownload(actor: ResolvedActor, fileId: string): Promise<Result<FileDownload>>
}
