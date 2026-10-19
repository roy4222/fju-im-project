import 'server-only'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs, { type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { Pool, PoolClient } from 'pg'
import { uuidv7 } from 'uuidv7'
import { ANONYMOUS as ANONYMOUS_ACTOR, statusGate, type ResolvedActor } from '@/application/accounts'
import {
  canonicalJson,
  checkDeclaredUpload,
  createContentInspector,
  effectiveMaxBytes,
  extensionOf,
  FILE_TYPES,
  fileInUseMessage,
  formatBytes,
  isUuid,
  sanitizeDisplayName,
  storageKeyFor,
  tempKeyFor,
  type AttachExpectation,
  type AuditWriter,
  type DeclaredUpload,
  type FileAdminCommand,
  type FileDeleteReceipt,
  type DownloadPolicies,
  type FileDownload,
  type FileFacts,
  type FilePurpose,
  type FileRef,
  type FileStorage,
  type GeneratedFile,
  type OperationLedger,
  type StoredFileContent,
  type StoredFileReceipt,
  type UploadRules,
  type UploadTicket,
} from '@/application/ops'
import { err, ok, type Receipt, type Result } from '@/shared/result'
import { RealClock, type Clock } from '@/shared/time'
import { sha256 } from '@/infrastructure/ops/audit-writer'
import { issueTicket, verifyTicket } from '@/infrastructure/ops/upload-ticket'

/**
 * 共用檔案能力的實作（模組 10 §3、§5；契約 02 §6；契約 03 §4、§5）。
 *
 * 檔案本體放在 `FILES_ROOT` 底下（VM 的獨立 volume，不進 Git 也不進資料庫）：
 *
 * ```
 * <root>/tmp/<id>                 上傳中的暫存
 * <root>/files/<yyyy>/<mm>/<id>   驗證通過的正式檔
 * ```
 *
 * 路徑只由系統產生的 ID 組成，原始檔名只存在資料庫給人看。反向代理不直接開放這個目錄，
 * 下載一律經 `authorizeDownload`（`/api/files/[id]`）每次重新授權。
 *
 * 上傳失敗（類型不符、太大、中斷）時暫存檔當場刪掉；`uploading` 的檔案列留著，
 * 超過 24 小時由 GC 收（回收工作在 S12；票 21 的 0008 已建好回收索引，`reclaimableFiles` 列得出候選）。
 */

export type FileStorageOptions = {
  /** 檔案根目錄（`FILES_ROOT`）。用函式是為了讓環境變數在第一次用到時才讀。 */
  readonly root: () => string
  /** 環境單檔上限（`FILE_MAX_BYTES`）；實際上限＝這個與用途上限取小。 */
  readonly environmentMaxBytes: () => number
  /** 簽 ticket 的秘密。 */
  readonly ticketSecret: () => string
  /** 用途 → 下載政策。沒登記的用途一律拒絕。 */
  readonly policies: DownloadPolicies
  /**
   * 公開讀取例外（第三波 W3，主腦 2026-10-12 准）：列在這裡的用途，帳號狀態被擋的登入者（待審、必須改密）
   * **比照訪客**——以訪客身分問政策，政策對訪客放行才給。目前只有首頁大圖（`photo`，政策只放行首頁正在用的那一張）：
   * 首頁對所有人公開，待審的人開首頁不該看到破圖。沒列的用途照舊在政策之前就「無法存取」。
   */
  readonly publicReadPurposes?: readonly FilePurpose[]
  /** 不在業務交易裡的查詢用這個；測試會指到自己的隔離 schema。 */
  readonly db: () => Pick<Pool, 'query'>
  readonly clock?: Clock
  /** ticket 有效時間，預設 15 分鐘。 */
  readonly ticketTtlMs?: number
  /**
   * 用途 → 收檔後的轉換（SH-9：頭像縮成 256×256 WebP、清掉 EXIF）。內容檢查通過後、標 `stored` 之前套用，
   * 存下來的是輸出，`size_bytes`、`checksum`、`mime_detected` 都以輸出重算。轉換丟錯＝這個檔不收
   * （`FILE_TYPE_REJECTED`），列維持 `uploading` 等 GC，永遠不會變成可下載的檔。
   */
  readonly transforms?: Partial<Record<FilePurpose, FileTransform>>
}

export type FileTransform = (input: Buffer) => Promise<{ bytes: Buffer; mime: string }>

/**
 * 轉換拒絕這個檔、而且有一句給使用者看的理由（例如頭像尺寸太大）。`upload()` 回 `FILE_TYPE_REJECTED` 帶這句話；
 * 其他錯誤（解不開的檔）一律回「這張圖片無法處理」。
 */
export class FileTransformRejected extends Error {}

type FileRow = {
  id: string
  owner_user_id: string
  purpose: FilePurpose
  scope: 'cohort' | 'global'
  cohort_id: string | null
  status: string
  storage_key: string
  original_name: string
  extension: string
  size_bytes: number | string | null
  checksum: string | null
  mime_detected: string | null
}

const DENIED = '無法存取這個檔案。'

/**
 * 換掉或清掉的頭像（`soft_deleted`／`purged`）回 404（SH-9，設計方案 §2.2.3 ▶R2-5）：頭像網址本來就在每個人的 HTML 裡，
 * 404 不洩漏什麼，又能讓帶舊 ETag 回來問的瀏覽器拿不到 304。只限這兩種狀態的 avatar：`uploading`（含縮圖失敗留下的列）
 * 與其他用途的非 stored 檔照舊是「無法存取」（私有檔的「不存在」與「不是你的」仍同一句話）。
 */
function isGoneAvatar(row: Pick<FileRow, 'purpose' | 'status'>): boolean {
  return row.purpose === 'avatar' && (row.status === 'soft_deleted' || row.status === 'purged')
}

function meta(now: Date) {
  return { requestId: uuidv7(), serverTime: now.toISOString() }
}

export class FsFileStorage implements FileStorage<PoolClient> {
  readonly #options: FileStorageOptions
  readonly #clock: Clock

  constructor(options: FileStorageOptions) {
    this.#options = options
    this.#clock = options.clock ?? new RealClock()
  }

  /**
   * 把 storage key 換成絕對路徑，並確認它**還在根目錄底下**。
   * key 本來就是系統產生的，這一步是第二道：資料庫被竄改或 key 格式出錯時也逃不出根目錄。
   */
  #resolve(key: string): string {
    const root = path.resolve(this.#options.root())
    const full = path.resolve(root, key)
    if (full !== root && !full.startsWith(root + path.sep)) {
      throw new Error(`storage key 跑出檔案根目錄：${key}`)
    }
    return full
  }

  async issueUploadTicket(ownerUserId: string, input: DeclaredUpload, rules: UploadRules): Promise<Result<UploadTicket>> {
    const now = this.#clock.now()
    const environmentMax = this.#options.environmentMaxBytes()
    const checked = checkDeclaredUpload(input, rules, environmentMax)
    if (!checked.ok) return err(checked.code, checked.message)

    const fileId = uuidv7()
    const maxBytes = effectiveMaxBytes(rules.maxBytes, environmentMax)
    await this.#options.db().query(
      `insert into stored_files
         (id, owner_user_id, scope, cohort_id, purpose, original_name, mime_declared, extension,
          status, storage_key, uploaded_real_at, updated_by_user_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'uploading', $9, $10, $2)`,
      [
        fileId,
        ownerUserId,
        rules.scope.kind,
        rules.scope.kind === 'cohort' ? rules.scope.cohortId : null,
        rules.purpose,
        checked.displayName,
        input.declaredMime.slice(0, 200),
        checked.extension,
        storageKeyFor(fileId, now),
        now,
      ],
    )

    const expiresAt = now.getTime() + (this.#options.ticketTtlMs ?? 15 * 60 * 1000)
    const ticket = issueTicket(
      { fileId, userId: ownerUserId, type: checked.type, maxBytes, expiresAt },
      this.#options.ticketSecret(),
    )
    return ok({ ticket, fileId, maxBytes, expiresAt: new Date(expiresAt).toISOString() }, meta(now))
  }

  async upload(
    uploaderUserId: string,
    ticket: string,
    body: ReadableStream<Uint8Array>,
    declaredLength: number | null,
  ): Promise<Result<StoredFileReceipt>> {
    const now = this.#clock.now()
    const claims = verifyTicket(ticket, this.#options.ticketSecret(), now)
    if (!claims || claims.userId !== uploaderUserId || !isUuid(claims.fileId)) {
      return err('FORBIDDEN', '上傳憑證無效或已過期，請重新選擇檔案。')
    }

    const found = await this.#options.db().query<FileRow>(
      `select id, owner_user_id, purpose, scope, cohort_id, status, storage_key, original_name, extension,
              size_bytes, checksum, mime_detected
         from stored_files where id = $1`,
      [claims.fileId],
    )
    const row = found.rows[0]
    // 同一張 ticket 只能用一次：傳完之後列就不是 uploading 了。
    if (!row || row.owner_user_id !== uploaderUserId || row.status !== 'uploading') {
      return err('FORBIDDEN', '上傳憑證無效或已使用過，請重新選擇檔案。')
    }

    const limit = claims.maxBytes
    if (declaredLength === null || !Number.isFinite(declaredLength) || declaredLength < 0) {
      return err('VALIDATION_FAILED', '缺少檔案大小，請重新上傳。')
    }
    if (declaredLength > limit) return err('FILE_TOO_LARGE', `檔案超過上限 ${formatBytes(limit)}。`)
    if (declaredLength === 0) return err('VALIDATION_FAILED', '檔案是空的。')

    const tempPath = this.#resolve(tempKeyFor(row.id))
    const finalPath = this.#resolve(row.storage_key)
    await fs.mkdir(path.dirname(tempPath), { recursive: true })

    let handle: FileHandle
    try {
      // `wx`：暫存檔已經存在（同一張 ticket 同時送兩次）就失敗，不覆蓋、不跟著 symlink。
      handle = await fs.open(tempPath, 'wx', 0o600)
    } catch {
      return err('CONFLICT', '這個檔案正在上傳中，請稍候再試。')
    }

    const hash = createHash('sha256')
    const inspector = createContentInspector(claims.type)
    let received = 0
    const reader = body.getReader()
    let failure: Result<StoredFileReceipt> | null = null

    try {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>
        try {
          chunk = await reader.read()
        } catch {
          failure = err('VALIDATION_FAILED', '上傳中斷，請重新上傳。')
          break
        }
        if (chunk.done) break
        const bytes = chunk.value
        received += bytes.length
        // 以實際收到的位元組計數，不信 Content-Length：超過就立刻停，不把整個檔案讀完。
        if (received > limit) {
          failure = err('FILE_TOO_LARGE', `檔案超過上限 ${formatBytes(limit)}。`)
          await reader.cancel().catch(() => undefined)
          break
        }
        hash.update(bytes)
        inspector.push(bytes)
        await handle.write(bytes)
      }
    } catch (error) {
      // 寫檔本身失敗（磁碟滿之類）：暫存不留，錯誤往上丟給路由回 500。
      await handle.close().catch(() => undefined)
      await fs.rm(tempPath, { force: true })
      throw error
    }
    await handle.close()

    if (!failure && received !== declaredLength) failure = err('VALIDATION_FAILED', '上傳中斷，請重新上傳。')
    if (!failure) {
      const verdict = inspector.finish()
      if (!verdict.ok) failure = err('FILE_TYPE_REJECTED', `${verdict.reason}，已拒絕。`)
    }
    if (failure) {
      await fs.rm(tempPath, { force: true })
      return failure
    }

    let checksum = hash.digest('hex')
    let mimeDetected = FILE_TYPES[claims.type].canonicalMime
    let sizeBytes = received
    const transform = this.#options.transforms?.[row.purpose]
    if (transform) {
      // 暫存檔已經限過大小（頭像 ≤ 2 MiB），整個讀進記憶體處理，再用輸出覆寫暫存檔。
      let output: { bytes: Buffer; mime: string }
      try {
        output = await transform(await fs.readFile(tempPath))
      } catch (error) {
        await fs.rm(tempPath, { force: true })
        return err('FILE_TYPE_REJECTED', error instanceof FileTransformRejected ? error.message : '這張圖片無法處理，請換一張。')
      }
      await fs.writeFile(tempPath, output.bytes, { mode: 0o600 })
      checksum = createHash('sha256').update(output.bytes).digest('hex')
      mimeDetected = output.mime
      sizeBytes = output.bytes.length
    }
    try {
      await fs.mkdir(path.dirname(finalPath), { recursive: true })
      await fs.rename(tempPath, finalPath)
      const updated = await this.#options.db().query(
        `update stored_files
            set status = 'stored', size_bytes = $2, checksum = $3, mime_detected = $4,
                finalized_at = $5, revision = revision + 1, updated_at = $5
          where id = $1 and status = 'uploading'`,
        [row.id, sizeBytes, checksum, mimeDetected, this.#clock.now()],
      )
      if (updated.rowCount !== 1) {
        await fs.rm(finalPath, { force: true })
        return err('CONFLICT', '這個檔案的狀態已經改變，請重新上傳。')
      }
    } catch (error) {
      await fs.rm(tempPath, { force: true })
      await fs.rm(finalPath, { force: true })
      throw error
    }

    return ok(
      { fileId: row.id, originalName: row.original_name, sizeBytes, checksum, mimeDetected },
      meta(now),
    )
  }

  async readOwned(
    ownerUserId: string,
    fileId: string,
    purpose: FilePurpose,
    maxBytes: number,
  ): Promise<Result<StoredFileContent>> {
    const now = this.#clock.now()
    if (!isUuid(fileId)) return err('VALIDATION_FAILED', '檔案編號不正確。')
    const found = await this.#options.db().query<FileRow>(
      `select id, owner_user_id, purpose, scope, cohort_id, status, storage_key, original_name, extension,
              size_bytes, checksum, mime_detected
         from stored_files where id = $1`,
      [fileId],
    )
    const row = found.rows[0]
    if (!row || row.owner_user_id !== ownerUserId || row.purpose !== purpose) {
      return err('FILE_NOT_OWNED', '找不到你上傳的這個檔案，請重新上傳。')
    }
    if (row.status !== 'stored' || !row.checksum) return err('FILE_NOT_READY', '檔案還沒上傳完成，請重新上傳。')
    if (Number(row.size_bytes) > maxBytes) return err('FILE_TOO_LARGE', `檔案超過上限 ${formatBytes(maxBytes)}。`)

    const bytes = await fs.readFile(this.#resolve(row.storage_key))
    // 讀回來的內容要跟上傳時算的 checksum 一致；不一致代表檔案被動過，不拿來用。
    if (createHash('sha256').update(bytes).digest('hex') !== row.checksum) {
      return err('INTERNAL', '檔案內容與上傳時不一致，請重新上傳。')
    }
    return ok(
      { fileId: row.id, originalName: row.original_name, checksum: row.checksum, bytes: new Uint8Array(bytes) },
      meta(now),
    )
  }

  async attach(
    tx: PoolClient,
    fileId: string,
    ref: FileRef,
    expect: AttachExpectation,
  ): Promise<Result<{ referenceId: string; checksum: string }>> {
    const now = this.#clock.now()
    if (!isUuid(fileId)) return err('VALIDATION_FAILED', '檔案編號不正確。')
    // 鎖住檔案列再檢查（模組 10 §3「stored→引用」；之後 GC 用同一把鎖判斷有沒有引用）。
    const found = await tx.query<{ owner_user_id: string; purpose: string; status: string; checksum: string | null }>(
      `select owner_user_id, purpose, status, checksum from stored_files where id = $1 for update`,
      [fileId],
    )
    const row = found.rows[0]
    let allowed = row !== undefined && row.purpose === expect.purpose
    if (allowed && 'heldBy' in expect) {
      const held = await tx.query(
        `select 1 from file_references where file_id = $1 and ref_type = $2 and ref_id = $3 and released_at is null`,
        [fileId, expect.heldBy.refType, expect.heldBy.refId],
      )
      allowed = (held.rowCount ?? 0) > 0
    } else if (allowed && 'ownerUserId' in expect) {
      const owners = typeof expect.ownerUserId === 'string' ? [expect.ownerUserId] : expect.ownerUserId
      allowed = owners.includes(row!.owner_user_id)
    }
    if (!row || !allowed) {
      return err('FILE_NOT_OWNED', '找不到你上傳的這個檔案，請重新上傳。')
    }
    if (row.status !== 'stored' || !row.checksum) return err('FILE_NOT_READY', '檔案還沒上傳完成，請重新上傳。')

    const inserted = await tx.query<{ id: string }>(
      `insert into file_references (id, file_id, ref_type, ref_id)
       values ($1, $2, $3, $4)
       on conflict (file_id, ref_type, ref_id) where released_at is null do nothing
       returning id`,
      [uuidv7(), fileId, ref.refType, ref.refId],
    )
    let referenceId = inserted.rows[0]?.id
    if (!referenceId) {
      // 已經有一筆有效引用（重送）：回原本那一筆。
      const existing = await tx.query<{ id: string }>(
        `select id from file_references
          where file_id = $1 and ref_type = $2 and ref_id = $3 and released_at is null`,
        [fileId, ref.refType, ref.refId],
      )
      referenceId = existing.rows[0]!.id
    }
    return ok({ referenceId, checksum: row.checksum }, meta(now))
  }

  async release(tx: PoolClient, fileId: string, ref: FileRef): Promise<void> {
    await tx.query(
      `update file_references set released_at = $4
        where file_id = $1 and ref_type = $2 and ref_id = $3 and released_at is null`,
      [fileId, ref.refType, ref.refId, this.#clock.now()],
    )
  }

  async authorizeDownload(actor: ResolvedActor, fileId: string): Promise<Result<FileDownload>> {
    const now = this.#clock.now()
    // 沒登入的人（含停用，resolver 已經當成沒登入）照樣走到下載政策：只有政策明說「訪客也可以」的檔
    // （目前只有公開公告、資源、規則的附件，票 16）放行；其他一律 401，而且「沒有這個檔」也是 401，不給人探測。
    const anonymous = actor.kind === 'anonymous'
    const denied = () => (anonymous ? err('UNAUTHENTICATED', '請先登入。') : err('FORBIDDEN', DENIED))
    // 帳號狀態被擋（待審、必須改密）的登入者：只剩「公開讀取例外」的用途可以比照訪客（見 `publicReadPurposes`）。
    let gatedToVisitor = false
    if (!anonymous) {
      const blocked = statusGate(actor, 'business')
      if (blocked === 'UNAUTHENTICATED') return err('UNAUTHENTICATED', '請先登入。')
      // 待審、必須改密的人一律「無法存取」，不另外說明原因——除非有用途登記成公開讀取，那就往下查檔、比照訪客問政策。
      if (blocked) {
        if ((this.#options.publicReadPurposes ?? []).length === 0) return err('FORBIDDEN', DENIED)
        gatedToVisitor = true
      }
    }
    if (!isUuid(fileId)) return denied()

    const found = await this.#options.db().query<FileRow>(
      `select id, owner_user_id, purpose, scope, cohort_id, status, storage_key, original_name, extension,
              size_bytes, checksum, mime_detected
         from stored_files where id = $1`,
      [fileId],
    )
    const candidate = found.rows[0]
    // 「沒有這個檔」也照樣查一次引用再拒絕：跟「有這個檔但不是你的」走同樣的查詢，
    // 回同一句話，回應時間也不會因為少查一次而露出檔案存不存在。
    const refs = await this.#options.db().query<{ ref_type: FileRef['refType']; ref_id: string }>(
      `select ref_type, ref_id from file_references where file_id = $1 and released_at is null`,
      [fileId],
    )
    // 換掉的頭像：登入者（狀態正常）拿 404；訪客與狀態被擋的人跟其他拒絕一樣（401／無法存取）。
    if (candidate && isGoneAvatar(candidate) && !anonymous && !gatedToVisitor) {
      return err('FILE_GONE', '這張頭像已經換掉了。')
    }
    const row = candidate?.status === 'stored' ? candidate : undefined
    if (!row) return denied()
    if (gatedToVisitor && !this.#options.publicReadPurposes!.includes(row.purpose)) return denied()

    const policy = this.#options.policies[row.purpose]
    const facts: FileFacts = {
      id: row.id,
      purpose: row.purpose,
      ownerUserId: row.owner_user_id,
      scope: row.scope,
      cohortId: row.cohort_id,
      references: refs.rows.map((r) => ({ refType: r.ref_type, refId: r.ref_id })),
    }
    const allowed =
      policy !== undefined &&
      // 狀態被擋的人以訪客身分問政策：角色、組別都帶不進去，只拿得到訪客也拿得到的檔。
      (await policy(gatedToVisitor ? ANONYMOUS_ACTOR : actor, facts))
    if (!allowed) return denied()
    // 這個檔此刻對所有人公開嗎（V4：可快取的前提之一）：訪客走同一條政策也放行才算。
    // 訪客與比照訪客的人剛才問的就是訪客版，不必再問；登入者多問一次，用同一份事實、不重查檔案與引用。
    // 不准用 `publicReadPurposes` 或用途名稱推論公開——那是「狀態被擋的人比照訪客」，不是「這些用途公開」。
    const publicRead = anonymous || gatedToVisitor ? true : await policy(ANONYMOUS_ACTOR, facts)

    const fullPath = this.#resolve(row.storage_key)
    try {
      await fs.access(fullPath)
    } catch {
      return err('INTERNAL', '檔案本體不見了，請聯絡系辦。')
    }
    const body = Readable.toWeb(createReadStream(fullPath)) as ReadableStream<Uint8Array>
    return ok(
      {
        fileId: row.id,
        purpose: row.purpose,
        originalName: row.original_name,
        sizeBytes: Number(row.size_bytes),
        mime: row.mime_detected ?? 'application/octet-stream',
        checksum: row.checksum ?? '',
        publicRead,
        body,
      },
      meta(now),
    )
  }

  /**
   * 伺服器產生的檔（見 port 說明）：先把本體寫到正式位置（`wx`，不覆蓋），再在呼叫端交易裡建 `stored` 列與引用。
   * 寫列失敗就把剛寫的本體刪掉；交易之後才回滾的話，本體留作沒有列指向的孤兒（誰都下載不到）。
   */
  async storeGenerated(tx: PoolClient, input: GeneratedFile): Promise<StoredFileReceipt> {
    const now = this.#clock.now()
    const fileId = uuidv7()
    const storageKey = storageKeyFor(fileId, now)
    const displayName = sanitizeDisplayName(input.fileName)
    const extension = extensionOf(displayName)
    const checksum = createHash('sha256').update(input.bytes).digest('hex')
    const fullPath = this.#resolve(storageKey)
    await fs.mkdir(path.dirname(fullPath), { recursive: true })
    await fs.writeFile(fullPath, input.bytes, { flag: 'wx', mode: 0o600 })
    try {
      await tx.query(
        `insert into stored_files
           (id, owner_user_id, scope, cohort_id, purpose, original_name, size_bytes, mime_declared, mime_detected, extension,
            checksum, status, storage_key, uploaded_real_at, finalized_at, updated_by_user_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9, $10, 'stored', $11, $12, $12, $2)`,
        [
          fileId,
          input.ownerUserId,
          input.scope.kind,
          input.scope.kind === 'cohort' ? input.scope.cohortId : null,
          input.purpose,
          displayName,
          input.bytes.byteLength,
          input.mime,
          extension,
          checksum,
          storageKey,
          now,
        ],
      )
      await tx.query(`insert into file_references (id, file_id, ref_type, ref_id) values ($1, $2, $3, $4)`, [
        uuidv7(),
        fileId,
        input.ref.refType,
        input.ref.refId,
      ])
    } catch (error) {
      await fs.rm(fullPath, { force: true })
      throw error
    }
    return { fileId, originalName: displayName, sizeBytes: input.bytes.byteLength, checksum, mimeDetected: input.mime }
  }
}

/** 回收的門檻（模組 10 §2：超過 24 小時才碰）。 */
export const RECLAIM_AFTER_MS = 24 * 60 * 60 * 1000

export type ReclaimCandidate = { readonly id: string; readonly status: 'uploading' | 'stored'; readonly ownerUserId: string }

/**
 * 回收候選（模組 10 §2、§3；票 21 建索引，回收工作本身在 S12）。
 *
 * - `uploading` 超過 24 小時：上傳中斷、類型不符、太大被擋時暫存檔已經刪了，只剩這一列（走 `stored_files_uploading_gc_idx`）。
 * - `stored` 超過 24 小時而且沒有任何有效引用：傳完了卻沒存進草稿、或從草稿拿掉之後沒人再用（走 `(status, finalized_at)`）。
 *
 * 只列不刪：真正刪檔要照契約 01 §6 的鎖序（檔案列 `FOR UPDATE` 後再確認沒有引用），那是回收工作的事。
 */
export async function reclaimableFiles(
  db: Pick<Pool, 'query'>,
  now: Date,
  olderThanMs: number = RECLAIM_AFTER_MS,
): Promise<ReclaimCandidate[]> {
  const cutoff = new Date(now.getTime() - olderThanMs)
  const rows = await db.query<{ id: string; status: 'uploading' | 'stored'; owner_user_id: string }>(
    `select id, status, owner_user_id from stored_files where status = 'uploading' and uploaded_real_at < $1
     union all
     select f.id, f.status, f.owner_user_id from stored_files f
      where f.status = 'stored' and f.finalized_at < $1
        and not exists (select 1 from file_references r where r.file_id = f.id and r.released_at is null)`,
    [cutoff],
  )
  return rows.rows.map((r) => ({ id: r.id, status: r.status, ownerUserId: r.owner_user_id }))
}

export type FileAdminCommandOptions = {
  /** 交易要借連線；測試會指到自己的隔離 schema。 */
  readonly db: () => Pick<Pool, 'connect'>
  readonly audit: AuditWriter<PoolClient>
  readonly ledger: OperationLedger<PoolClient>
  /** 業務時間（稽核的 `business_at`）；在開交易**之前**讀，業務鐘自己也借連線。 */
  readonly businessClock: { now(): Promise<Date> }
  readonly clock?: Clock
}

/**
 * 系辦在檔案分頁刪掉沒人用的檔（C1-16；①設計方案 §1.6）。規則見 `FileAdminCommand`。
 *
 * 鎖序跟 `attach` 與回收工作一樣（契約 01 §6）：先 `FOR UPDATE` 鎖檔案列，再查引用。
 * 同時有人把這個檔附到別的地方：`attach` 也要先拿這把鎖，所以不是先附上（這裡看到引用、回 `CONFLICT`），
 * 就是先刪掉（`attach` 看到不是 `stored`、回 `FILE_NOT_READY`）。
 */
export class PgFileAdminCommand implements FileAdminCommand {
  readonly #options: FileAdminCommandOptions
  readonly #clock: Clock

  constructor(options: FileAdminCommandOptions) {
    this.#options = options
    this.#clock = options.clock ?? new RealClock()
  }

  async deleteUnreferenced(actor: ResolvedActor, fileId: string, requestId: string): Promise<Result<FileDeleteReceipt>> {
    const blocked = statusGate(actor, 'business')
    if (blocked) return err(blocked, '請先登入並完成帳號設定。')
    if (actor.kind !== 'authenticated' || !actor.roles.includes('admin')) return err('FORBIDDEN', '只有系辦可以刪除檔案。')
    if (!isUuid(requestId)) return err('VALIDATION_FAILED', '這次送出缺少請求編號，請重新整理頁面再試。')
    if (!isUuid(fileId)) return err('VALIDATION_FAILED', '找不到這個檔案，請重新整理頁面。')
    const userId = actor.userId
    const businessAt = await this.#options.businessClock.now()

    const client = await this.#options.db().connect()
    try {
      await client.query('begin')
      const result = await this.#delete(client, userId, fileId, requestId, businessAt)
      await client.query(result.ok ? 'commit' : 'rollback')
      return result
    } catch (error) {
      await client.query('rollback').catch(() => undefined)
      console.error('[file.delete] 寫入失敗', error)
      return err('INTERNAL', '系統暫時無法處理，請稍後再試。')
    } finally {
      client.release()
    }
  }

  async #delete(tx: PoolClient, userId: string, fileId: string, requestId: string, businessAt: Date): Promise<Result<FileDeleteReceipt>> {
    const realAt = this.#clock.now()
    const begun = await this.#options.ledger.begin(
      tx,
      { actorUserId: userId, operationKind: 'file.delete', requestId, fingerprint: sha256(canonicalJson({ fileId })), scope: 'global' },
      realAt,
    )
    if (begun.outcome === 'mismatch') return err('REQUEST_MISMATCH', '這個請求編號已經用在別的內容上，請重新整理頁面再送一次。')
    if (begun.outcome !== 'fresh') {
      if (begun.receiptExpired) return err('RECEIPT_EXPIRED', '這個動作之前已經處理過了。')
      return { ok: true, receipt: begun.receipt as Receipt<FileDeleteReceipt> }
    }

    const found = await tx.query<{ status: string; original_name: string; purpose: FilePurpose; scope: 'cohort' | 'global'; cohort_id: string | null }>(
      `select status, original_name, purpose, scope, cohort_id from stored_files where id = $1 for update`,
      [fileId],
    )
    const row = found.rows[0]
    if (!row || row.status !== 'stored') return err('VALIDATION_FAILED', '這個檔案已經刪除或還沒上傳完成，請重新整理頁面。')

    // 首頁大圖不寫 `file_references`（`pg-home-settings.ts`），由 `home_settings.hero_file_id` 指著；它也算一處在用。
    const refs = await tx.query<{ n: number }>(
      `select (select count(*)::int from file_references where file_id = $1 and released_at is null)
            + (select count(*)::int from home_settings where hero_file_id = $1) as n`,
      [fileId],
    )
    const inUse = refs.rows[0]?.n ?? 0
    if (inUse > 0) return err('CONFLICT', fileInUseMessage(inUse))

    await tx.query(
      `update stored_files set status = 'soft_deleted', soft_deleted_at = $2, revision = revision + 1, updated_at = $2
        where id = $1`,
      [fileId, realAt],
    )
    await this.#options.audit.append(tx, {
      actorKind: 'user',
      actorUserId: userId,
      role: 'admin',
      action: 'file.delete',
      targetType: 'stored_file',
      targetId: fileId,
      scope: row.scope,
      cohortId: row.cohort_id,
      realAt,
      businessAt,
      payload: { name: row.original_name, purpose: row.purpose },
    })
    const receipt = { fileId, name: row.original_name, requestId, serverTime: realAt.toISOString() }
    await this.#options.ledger.commit(tx, begun.recordId, { receipt, resultRef: { fileId } })
    return { ok: true, receipt }
  }
}
