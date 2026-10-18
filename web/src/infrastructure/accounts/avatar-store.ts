import 'server-only'
import type { Pool, PoolClient } from 'pg'
import { uuidv7 } from 'uuidv7'
import {
  accountAdminDenied,
  AVATAR_MAX_BYTES,
  AVATAR_UPLOAD_TYPES,
  isUserId,
  normalizeAvatarResetReason,
  parseAvatarChoice,
  statusGate,
  type AvatarChoice,
  type AvatarCommand,
  type ResolvedActor,
} from '@/application/accounts'
import { isUuid, type AuditWriter, type DeclaredUpload, type FileStorage, type UploadRules, type UploadTicket } from '@/application/ops'
import type { ErrorCode } from '@/shared/errors'
import { err, ok, type Err, type Result } from '@/shared/result'
import { RealClock, type Clock } from '@/shared/time'
import { isEffectiveAdmin, lockAdmins } from '@/infrastructure/accounts/admin-guard'
import { bustIdentity } from '@/infrastructure/auth/identity-cache'

/**
 * 頭像的寫入（SH-9；B 設計方案 §2.2；Q105、Q109）。讀的部分在身分解析器（SH-8，`actor-resolver.ts` 同一句多讀兩欄）。
 *
 * - 上傳：`avatarUploadTicket` 發票券 → 瀏覽器 POST `/api/files/upload?ticket=`（同一個限流桶）→ `FsFileStorage`
 *   收檔時縮成 256×256 WebP、清掉 EXIF（`avatar-image.ts`），成功才是 `stored`。
 * - 換頭像（`updateAvatar`）與系辦重設（`resetAvatar`）在**同一個交易**裡，鎖序同帳號操作（停用、去識別化）：
 *   （重設先 `lockAdmins` 重驗操作者）→ 鎖 `users` 列（`FOR NO KEY UPDATE`）並重驗狀態 → 鎖 `user_profiles` 列 →
 *   （換成上傳檔時）經 `FileStorage.attach` 驗「本人上傳、purpose avatar、已 stored」並寫 `file_references(avatar, userId)`
 *   → 舊的上傳檔立刻標刪、釋放引用（Q109，舊網址馬上 404）→ 更新兩欄 → 稽核。
 * - 去識別化（`account-directory-command.ts` 的 `scrubPersonalData`）用同一個 `softDeleteAvatarFile`。
 */

/** 上傳頭像的規則：本人限制由 ticket 的 `ownerUserId` 保證（`upload()` 驗上傳者、`attach` 驗擁有者），不另設 scope。 */
export const AVATAR_UPLOAD_RULES: UploadRules = {
  purpose: 'avatar',
  allowedTypes: AVATAR_UPLOAD_TYPES,
  maxBytes: AVATAR_MAX_BYTES,
  scope: { kind: 'global' },
}

/**
 * 把一張上傳過的頭像標刪（`soft_deleted`）並釋放它的頭像引用。之後 `/api/files/<id>` 回 404（`FILE_GONE`），
 * 本體 7 天後由回收工作清（模組 10 §2）。只動 `stored` 的 avatar 列；已經標刪過的、其他用途的不碰。
 */
export async function softDeleteAvatarFile(tx: PoolClient, fileId: string, now: Date): Promise<void> {
  await tx.query(
    `update stored_files
        set status = 'soft_deleted', soft_deleted_at = $2, revision = revision + 1, updated_at = $2
      where id = $1 and purpose = 'avatar' and status = 'stored'`,
    [fileId, now],
  )
  await tx.query(
    `update file_references set released_at = $2
      where file_id = $1 and ref_type = 'avatar' and released_at is null`,
    [fileId, now],
  )
}

export type AvatarCommandDeps = {
  readonly db: () => Pick<Pool, 'connect'>
  readonly audit: AuditWriter<PoolClient>
  readonly files: FileStorage<PoolClient>
  readonly clock?: Clock
}

type ProfileAvatar = { avatar_preset: number | null; avatar_file_id: string | null }

const NO_PROFILE = '這個帳號的個人資料還沒建立，暫時不能設定頭像。'

function meta(now: Date) {
  return { requestId: uuidv7(), serverTime: now.toISOString() }
}

function denied(code: ErrorCode, forbidden: string): Err {
  const messages: Partial<Record<ErrorCode, string>> = {
    UNAUTHENTICATED: '請先登入。',
    FORBIDDEN: forbidden,
    PASSWORD_CHANGE_REQUIRED: '請先修改密碼。',
    ACCOUNT_PENDING: '帳號還在審核中。',
  }
  return err(code, messages[code] ?? '目前的帳號狀態不能做這件事。')
}

/**
 * 鎖帳號列並讀**此刻**的狀態（同 `account-directory-command.ts` 的 `lockAccounts`：`FOR NO KEY UPDATE`）。
 * 請求開始時解析的 actor 可能已經過時：等鎖期間被停用或去識別化，這裡讀到的是 commit 之後的值。
 */
async function lockUser(tx: PoolClient, userId: string): Promise<{ active: boolean } | undefined> {
  const found = await tx.query<{ active: boolean }>(
    `select (status = 'active' and deidentified_at is null) as active from users where id = $1 for no key update`,
    [userId],
  )
  return found.rows[0]
}

async function lockProfile(tx: PoolClient, userId: string): Promise<ProfileAvatar | undefined> {
  const found = await tx.query<ProfileAvatar>(
    `select avatar_preset, avatar_file_id from user_profiles where user_id = $1 for update`,
    [userId],
  )
  return found.rows[0]
}

export class PgAvatarCommand implements AvatarCommand {
  readonly #deps: AvatarCommandDeps
  readonly #clock: Clock

  constructor(deps: AvatarCommandDeps) {
    this.#deps = deps
    this.#clock = deps.clock ?? new RealClock()
  }

  async avatarUploadTicket(actor: ResolvedActor, input: DeclaredUpload): Promise<Result<UploadTicket>> {
    const blocked = statusGate(actor, 'business')
    if (blocked || actor.kind !== 'authenticated') return denied(blocked ?? 'UNAUTHENTICATED', '目前的帳號狀態不能上傳頭像。')
    return this.#deps.files.issueUploadTicket(actor.userId, input, AVATAR_UPLOAD_RULES)
  }

  async updateAvatar(actor: ResolvedActor, input: AvatarChoice): Promise<Result<void>> {
    const blocked = statusGate(actor, 'business')
    if (blocked || actor.kind !== 'authenticated') return denied(blocked ?? 'UNAUTHENTICATED', '目前的帳號狀態不能換頭像。')
    const choice = parseAvatarChoice(input)
    if (!choice) return err('VALIDATION_FAILED', '請選一張預設圖，或上傳一張圖片。')
    if ('fileId' in choice && !isUuid(choice.fileId)) return err('FILE_NOT_OWNED', '找不到你上傳的這張圖片，請重新上傳。')

    const now = this.#clock.now()
    const userId = actor.userId
    const result = await this.#inTx(async (tx) => {
      // 先鎖帳號再鎖個人資料：去識別化、停用同一個人時兩邊排隊，不會在去識別化清完頭像之後又寫回去。
      const account = await lockUser(tx, userId)
      if (!account?.active) return err('ACCOUNT_DISABLED', '這個帳號目前不能換頭像。')
      const before = await lockProfile(tx, userId)
      if (!before) return err('CONFLICT', NO_PROFILE)

      let after: ProfileAvatar
      if ('fileId' in choice) {
        // 同一張重送：什麼都不用做（不重複標刪、不多寫稽核）。
        if (before.avatar_file_id === choice.fileId) return ok(undefined, meta(now))
        const attached = await this.#deps.files.attach(
          tx,
          choice.fileId,
          { refType: 'avatar', refId: userId },
          { purpose: 'avatar', ownerUserId: userId },
        )
        if (!attached.ok) return attached
        after = { avatar_preset: before.avatar_preset, avatar_file_id: choice.fileId }
      } else {
        after = { avatar_preset: choice.preset, avatar_file_id: null }
      }

      if (before.avatar_file_id && before.avatar_file_id !== after.avatar_file_id) {
        await softDeleteAvatarFile(tx, before.avatar_file_id, now)
      }
      await tx.query(
        `update user_profiles
            set avatar_preset = $2, avatar_file_id = $3, revision = revision + 1, updated_at = $4
          where user_id = $1`,
        [userId, after.avatar_preset, after.avatar_file_id, now],
      )
      await this.#deps.audit.append(tx, {
        actorKind: 'user',
        actorUserId: userId,
        action: 'account.avatar_update',
        targetType: 'user',
        targetId: userId,
        scope: 'global',
        realAt: now,
        businessAt: now,
        payload: {
          from: { avatarPreset: before.avatar_preset, avatarFileId: before.avatar_file_id },
          to: { avatarPreset: after.avatar_preset, avatarFileId: after.avatar_file_id },
        },
      })
      return ok(undefined, meta(now))
    })
    // 外殼頭像跟身分一起快取（B 設計方案 §4.1）：commit 之後丟掉，下一頁就是新頭像。
    if (result.ok) bustIdentity(userId)
    return result
  }

  async resetAvatar(actor: ResolvedActor, userId: string, reason: string): Promise<Result<void>> {
    const blocked = accountAdminDenied(actor)
    if (blocked || actor.kind !== 'authenticated') return denied(blocked ?? 'UNAUTHENTICATED', '只有系辦可以重設頭像。')
    if (!isUserId(userId)) return err('VALIDATION_FAILED', '找不到這個帳號，請重新整理頁面。')
    const normalized = normalizeAvatarResetReason(reason)
    if (!normalized.ok) {
      return err('VALIDATION_FAILED', '理由最多 200 個字。', { details: { field: 'reason' } })
    }

    const now = this.#clock.now()
    const result = await this.#inTx(async (tx) => {
      // 鎖序同停用、去識別化：先整組管理員（重驗操作者此刻仍是有效系辦），再目標帳號，再個人資料。
      const admins = await lockAdmins(tx)
      if (!isEffectiveAdmin(admins, actor.userId)) return denied('FORBIDDEN', '只有系辦可以重設頭像。')
      if (!(await lockUser(tx, userId))) return err('CONFLICT', '找不到這個帳號，請重新整理頁面。')
      const before = await lockProfile(tx, userId)
      if (!before) return err('CONFLICT', NO_PROFILE)
      if (before.avatar_file_id) await softDeleteAvatarFile(tx, before.avatar_file_id, now)
      await tx.query(
        `update user_profiles
            set avatar_preset = null, avatar_file_id = null, revision = revision + 1, updated_at = $2
          where user_id = $1`,
        [userId, now],
      )
      await this.#deps.audit.append(tx, {
        actorKind: 'user',
        actorUserId: actor.userId,
        role: 'admin',
        action: 'account.avatar_reset',
        targetType: 'user',
        targetId: userId,
        scope: 'global',
        reason: normalized.value,
        realAt: now,
        businessAt: now,
        payload: { reason: normalized.value, avatarPreset: before.avatar_preset, avatarFileId: before.avatar_file_id },
      })
      return ok(undefined, meta(now))
    })
    if (result.ok) bustIdentity(userId)
    return result
  }

  /** 開交易跑 `work`：回 `ok` 才 commit，回錯誤或丟錯都 rollback。 */
  async #inTx<R>(work: (tx: PoolClient) => Promise<Result<R>>): Promise<Result<R>> {
    const tx = (await this.#deps.db().connect()) as PoolClient
    try {
      await tx.query('begin')
      const result = await work(tx)
      await tx.query(result.ok ? 'commit' : 'rollback')
      return result
    } catch (error) {
      await tx.query('rollback').catch(() => undefined)
      throw error
    } finally {
      tx.release()
    }
  }
}
