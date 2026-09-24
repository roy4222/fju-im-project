import 'server-only'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs, { type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { Pool, PoolClient } from 'pg'
import { uuidv7 } from 'uuidv7'
import { statusGate, type ResolvedActor } from '@/application/accounts'
import {
  checkDeclaredUpload,
  createContentInspector,
  effectiveMaxBytes,
  FILE_TYPES,
  formatBytes,
  isUuid,
  storageKeyFor,
  tempKeyFor,
  type DeclaredUpload,
  type DownloadPolicies,
  type FileDownload,
  type FilePurpose,
  type FileRef,
  type FileStorage,
  type StoredFileContent,
  type StoredFileReceipt,
  type UploadRules,
  type UploadTicket,
} from '@/application/ops'
import { err, ok, type Result } from '@/shared/result'
import { RealClock, type Clock } from '@/shared/time'
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
 * 超過 24 小時由 GC 收（GC 在 S07／S12，本票不做）。
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
  /** 不在業務交易裡的查詢用這個；測試會指到自己的隔離 schema。 */
  readonly db: () => Pick<Pool, 'query'>
  readonly clock?: Clock
  /** ticket 有效時間，預設 15 分鐘。 */
  readonly ticketTtlMs?: number
}

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

    const checksum = hash.digest('hex')
    const mimeDetected = FILE_TYPES[claims.type].canonicalMime
    try {
      await fs.mkdir(path.dirname(finalPath), { recursive: true })
      await fs.rename(tempPath, finalPath)
      const updated = await this.#options.db().query(
        `update stored_files
            set status = 'stored', size_bytes = $2, checksum = $3, mime_detected = $4,
                finalized_at = $5, revision = revision + 1, updated_at = $5
          where id = $1 and status = 'uploading'`,
        [row.id, received, checksum, mimeDetected, this.#clock.now()],
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
      { fileId: row.id, originalName: row.original_name, sizeBytes: received, checksum, mimeDetected },
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
    expect: { ownerUserId: string; purpose: FilePurpose },
  ): Promise<Result<{ referenceId: string; checksum: string }>> {
    const now = this.#clock.now()
    if (!isUuid(fileId)) return err('VALIDATION_FAILED', '檔案編號不正確。')
    // 鎖住檔案列再檢查（模組 10 §3「stored→引用」；之後 GC 用同一把鎖判斷有沒有引用）。
    const found = await tx.query<{ owner_user_id: string; purpose: string; status: string; checksum: string | null }>(
      `select owner_user_id, purpose, status, checksum from stored_files where id = $1 for update`,
      [fileId],
    )
    const row = found.rows[0]
    if (!row || row.owner_user_id !== expect.ownerUserId || row.purpose !== expect.purpose) {
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
    if (actor.kind === 'anonymous') return err('UNAUTHENTICATED', '請先登入。')
    const blocked = statusGate(actor, 'business')
    if (blocked === 'UNAUTHENTICATED') return err('UNAUTHENTICATED', '請先登入。')
    // 待審、必須改密的人一律「無法存取」，不另外說明原因。
    if (blocked) return err('FORBIDDEN', DENIED)
    if (!isUuid(fileId)) return err('FORBIDDEN', DENIED)

    const found = await this.#options.db().query<FileRow>(
      `select id, owner_user_id, purpose, scope, cohort_id, status, storage_key, original_name, extension,
              size_bytes, checksum, mime_detected
         from stored_files where id = $1 and status = 'stored'`,
      [fileId],
    )
    const row = found.rows[0]
    // 「沒有這個檔」與「不是你的」回同一句話，不給人拿來探測檔案存不存在。
    if (!row) return err('FORBIDDEN', DENIED)

    const refs = await this.#options.db().query<{ ref_type: FileRef['refType']; ref_id: string }>(
      `select ref_type, ref_id from file_references where file_id = $1 and released_at is null`,
      [fileId],
    )
    const policy = this.#options.policies[row.purpose]
    const allowed =
      policy !== undefined &&
      (await policy(actor, {
        id: row.id,
        purpose: row.purpose,
        ownerUserId: row.owner_user_id,
        scope: row.scope,
        cohortId: row.cohort_id,
        references: refs.rows.map((r) => ({ refType: r.ref_type, refId: r.ref_id })),
      }))
    if (!allowed) return err('FORBIDDEN', DENIED)

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
        originalName: row.original_name,
        sizeBytes: Number(row.size_bytes),
        mime: row.mime_detected ?? 'application/octet-stream',
        checksum: row.checksum ?? '',
        body,
      },
      meta(now),
    )
  }
}
