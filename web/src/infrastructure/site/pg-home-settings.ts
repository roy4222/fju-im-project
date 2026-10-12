import 'server-only'
import type { Pool, PoolClient } from 'pg'
import type { ResolvedActor } from '@/application/accounts'
import type { BusinessClockSource } from '@/application/cohorts'
import { canonicalJson, isUuid, type AuditWriter, type DeclaredUpload, type FileStorage, type OperationLedger, type UploadTicket } from '@/application/ops'
import {
  HERO_UPLOAD,
  HOME_STALE_MESSAGE,
  normalizeHomeSettings,
  type HomeSettings,
  type HomeSettingsCommand,
  type HomeSettingsFields,
  type HomeSettingsQuery,
  type HomeSettingsReceipt,
  type HomeSettingsSaveInput,
} from '@/application/site'
import { authorizeAdmin, badRequestId, inTransaction, replayed, type PoolSource } from '@/infrastructure/cohorts/shared'
import { getPool } from '@/infrastructure/db/client'
import { sha256 } from '@/infrastructure/ops/audit-writer'
import { err, ok, type Result } from '@/shared/result'
import { RealClock, type Clock } from '@/shared/time'

/**
 * 首頁設定（第三波 W3；設計方案 §3）：單列設定 `home_settings`（`id = 1`），存了就生效（Q32）。
 *
 * 寫入的形狀同其他用例（契約 01 §8）：開交易 → 鎖設定列 → 帳本 `begin` → 檢查版本 → 寫入 → 稽核 `home.updated` → 帳本 `commit`。
 * 還沒有設定列時畫面帶版本 0，這次就新增列；兩個分頁同時第一次存，後到的撞主鍵 → 同一句「剛被改過」。
 *
 * 首頁大圖用既有的 `stored_files.purpose = 'photo'`、`scope = 'global'`，**不寫 `file_references`**
 * （設計方案 §3）：誰看得到由下載政策 `hero-photo-policy.ts` 直接看 `home_settings.hero_file_id`，
 * 換圖後舊圖回到「無法存取」。所以換圖時這裡自己驗新圖：本人上傳、用途是首頁大圖、已經傳完。
 */

const SINGLETON = 1

type Row = {
  hero_file_id: string | null
  hero_alt: string | null
  tagline_line1: string | null
  tagline_line2: string | null
  revision: number
}

type Deps = {
  audit: AuditWriter<PoolClient>
  ledger: OperationLedger<PoolClient>
  files: FileStorage<PoolClient>
  businessClock: BusinessClockSource
  pool?: PoolSource
  realClock?: Clock
}

const EMPTY: HomeSettingsFields = { heroFileId: null, heroAlt: null, line1: null, line2: null }

export class PgHomeSettingsCommand implements HomeSettingsCommand {
  readonly #audit: AuditWriter<PoolClient>
  readonly #ledger: OperationLedger<PoolClient>
  readonly #files: FileStorage<PoolClient>
  readonly #businessClock: BusinessClockSource
  readonly #pool: PoolSource
  readonly #realClock: Clock

  constructor(deps: Deps) {
    this.#audit = deps.audit
    this.#ledger = deps.ledger
    this.#files = deps.files
    this.#businessClock = deps.businessClock
    this.#pool = deps.pool ?? getPool
    this.#realClock = deps.realClock ?? new RealClock()
  }

  async save(actor: ResolvedActor, input: HomeSettingsSaveInput, requestId: string): Promise<Result<HomeSettingsReceipt>> {
    const denied = authorizeAdmin(actor, '修改首頁設定')
    if (denied) return denied
    const normalized = normalizeHomeSettings(input)
    if (!normalized.ok) return err('VALIDATION_FAILED', normalized.message, { details: { field: normalized.field } })
    return this.#write(actor, normalized.value, input.revision, requestId, false)
  }

  async reset(actor: ResolvedActor, input: { readonly revision: number }, requestId: string): Promise<Result<HomeSettingsReceipt>> {
    const denied = authorizeAdmin(actor, '修改首頁設定')
    if (denied) return denied
    return this.#write(actor, EMPTY, input.revision, requestId, true)
  }

  async requestHeroUpload(actor: ResolvedActor, input: DeclaredUpload): Promise<Result<UploadTicket>> {
    const denied = authorizeAdmin(actor, '上傳首頁大圖')
    if (denied || actor.kind !== 'authenticated') return denied ?? err('UNAUTHENTICATED', '請先登入。')
    const issued = await this.#files.issueUploadTicket(
      actor.userId,
      { fileName: input.fileName, declaredMime: input.declaredMime, declaredSize: input.declaredSize },
      { purpose: 'photo', allowedTypes: HERO_UPLOAD.allowedTypes, maxBytes: HERO_UPLOAD.maxBytes, scope: { kind: 'global' } },
    )
    if (!issued.ok) return issued
    const { ticket, fileId, maxBytes, expiresAt } = issued.receipt
    return ok({ ticket, fileId, maxBytes, expiresAt }, { requestId: issued.receipt.requestId, serverTime: issued.receipt.serverTime })
  }

  async #write(
    actor: ResolvedActor,
    fields: HomeSettingsFields,
    rawRevision: number,
    requestId: string,
    reset: boolean,
  ): Promise<Result<HomeSettingsReceipt>> {
    if (!isUuid(String(requestId))) return badRequestId()
    const revision = Number(rawRevision)
    // 版本 0＝畫面上還沒有設定列。
    if (!Number.isInteger(revision) || revision < 0) return err('CONFLICT', HOME_STALE_MESSAGE)
    const adminId = actor.kind === 'authenticated' ? actor.userId : ''
    const businessNow = await this.#businessClock.now()

    return inTransaction(
      this.#pool,
      'home-settings',
      async (tx) => {
        const current = (
          await tx.query<Row>(
            `select hero_file_id, hero_alt, tagline_line1, tagline_line2, revision from home_settings where id = $1 for update`,
            [SINGLETON],
          )
        ).rows[0]
        const realAt = this.#realClock.now()
        const begun = await this.#ledger.begin(
          tx,
          {
            actorUserId: adminId,
            operationKind: reset ? 'home.reset' : 'home.update',
            requestId,
            fingerprint: sha256(canonicalJson({ revision, reset, ...fields })),
            scope: 'global',
          },
          realAt,
        )
        if (begun.outcome !== 'fresh') return replayed<HomeSettingsReceipt>(begun)
        if ((current?.revision ?? 0) !== revision) return err('CONFLICT', HOME_STALE_MESSAGE)

        const previousHero = current?.hero_file_id ?? null
        const heroChanged = fields.heroFileId !== previousHero
        if (heroChanged && fields.heroFileId !== null) {
          const usable = await heroUsable(tx, fields.heroFileId, adminId)
          if (!usable) {
            return err('FILE_NOT_OWNED', '找不到你剛上傳的首頁大圖，請重新上傳 PNG 或 JPG。', { details: { field: 'hero' } })
          }
        }

        const values = [SINGLETON, fields.heroFileId, fields.heroAlt, fields.line1, fields.line2, realAt, adminId]
        const written = current
          ? await tx.query<{ revision: number }>(
              `update home_settings
                  set hero_file_id = $2, hero_alt = $3, tagline_line1 = $4, tagline_line2 = $5,
                      revision = revision + 1, updated_at = $6, updated_by_user_id = $7
                where id = $1
                returning revision`,
              values,
            )
          : await tx.query<{ revision: number }>(
              `insert into home_settings (id, hero_file_id, hero_alt, tagline_line1, tagline_line2, revision, updated_at, updated_by_user_id)
               values ($1, $2, $3, $4, $5, 1, $6, $7)
               returning revision`,
              values,
            )
        const newRevision = written.rows[0]!.revision

        await this.#audit.append(tx, {
          actorKind: 'user',
          actorUserId: adminId,
          role: 'admin',
          action: 'home.updated',
          targetType: 'home_settings',
          targetId: null,
          scope: 'global',
          realAt,
          businessAt: businessNow,
          // 標語本身是公開字，記下來方便日後查「首頁什麼時候寫了什麼」。
          payload: {
            revision: newRevision,
            reset,
            heroFileId: fields.heroFileId,
            previousHeroFileId: heroChanged ? previousHero : undefined,
            heroAlt: fields.heroAlt,
            line1: fields.line1,
            line2: fields.line2,
          },
        })
        const receipt = { revision: newRevision, reset, heroChanged, requestId, serverTime: realAt.toISOString() }
        await this.#ledger.commit(tx, begun.recordId, { receipt, resultRef: { revision: newRevision } })
        return { ok: true as const, receipt }
      },
      // 兩個分頁同時第一次存：後到的 insert 撞主鍵。
      () => err('CONFLICT', HOME_STALE_MESSAGE),
    )
  }
}

/** 新圖：本人上傳、用途是首頁大圖、已經傳完（鎖住檔案列再看，同 `attach`）。 */
async function heroUsable(tx: PoolClient, fileId: string, adminId: string): Promise<boolean> {
  const found = await tx.query(
    `select 1 from stored_files
      where id = $1 and purpose = 'photo' and status = 'stored' and owner_user_id = $2
      for share`,
    [fileId, adminId],
  )
  return (found.rowCount ?? 0) > 0
}

export class PgHomeSettingsQuery implements HomeSettingsQuery {
  readonly #reader: () => Pick<Pool, 'query'>

  constructor(options?: { reader?: () => Pick<Pool, 'query'> }) {
    this.#reader = options?.reader ?? getPool
  }

  async current(): Promise<HomeSettings | null> {
    const found = await this.#reader().query<Row & { updated_at: Date; updated_by_name: string | null }>(
      `select h.hero_file_id, h.hero_alt, h.tagline_line1, h.tagline_line2, h.revision, h.updated_at, u.name as updated_by_name
         from home_settings h left join users u on u.id = h.updated_by_user_id
        where h.id = $1`,
      [SINGLETON],
    )
    const row = found.rows[0]
    if (!row) return null
    return {
      heroFileId: row.hero_file_id,
      heroAlt: row.hero_alt,
      line1: row.tagline_line1,
      line2: row.tagline_line2,
      revision: row.revision,
      updatedAt: row.updated_at,
      updatedByName: row.updated_by_name,
    }
  }
}
