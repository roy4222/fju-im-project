import 'server-only'
import type { Pool, PoolClient } from 'pg'
import type { ResolvedActor } from '@/application/accounts'
import type { BusinessClockSource } from '@/application/cohorts'
import { canonicalJson, isUuid, type AuditWriter, type OperationLedger } from '@/application/ops'
import {
  isSiteTextKey,
  normalizeSiteText,
  readSiteText,
  SITE_TEXT_STALE_MESSAGE,
  type SiteTextInput,
  type SiteTextKey,
  type SiteTextReceipt,
  type SiteTextRow,
  type SiteTexts,
  type SiteTextsCommand,
  type SiteTextsQuery,
} from '@/application/site'
import { authorizeAdmin, badRequestId, inTransaction, replayed, type PoolSource } from '@/infrastructure/cohorts/shared'
import { getPool } from '@/infrastructure/db/client'
import { sha256 } from '@/infrastructure/ops/audit-writer'
import { err, type Result } from '@/shared/result'
import { RealClock, type Clock } from '@/shared/time'

/**
 * 站內文字（C 階段規格② 設計方案 §6.5；C2-17）：`site_texts` 一個 key 一列，存了就生效。
 *
 * 寫入的形狀同首頁設定（`pg-home-settings.ts`、契約 01 §8）：開交易 → 鎖那一列 → 帳本 `begin` → 檢查版本 → 寫入
 * → 稽核 `site_text.updated` → 帳本 `commit`。還沒有列時畫面帶版本 0，這次就新增列；
 * 兩個分頁同時第一次存，後到的撞主鍵 → 同一句「剛被改過」。
 */

type Row = { key: string; value: unknown; revision: number; updated_at: Date }

type Deps = {
  audit: AuditWriter<PoolClient>
  ledger: OperationLedger<PoolClient>
  businessClock: BusinessClockSource
  pool?: PoolSource
  realClock?: Clock
}

export class PgSiteTextsCommand implements SiteTextsCommand {
  readonly #audit: AuditWriter<PoolClient>
  readonly #ledger: OperationLedger<PoolClient>
  readonly #businessClock: BusinessClockSource
  readonly #pool: PoolSource
  readonly #realClock: Clock

  constructor(deps: Deps) {
    this.#audit = deps.audit
    this.#ledger = deps.ledger
    this.#businessClock = deps.businessClock
    this.#pool = deps.pool ?? getPool
    this.#realClock = deps.realClock ?? new RealClock()
  }

  async save(actor: ResolvedActor, key: SiteTextKey, input: SiteTextInput, rawRevision: number, requestId: string): Promise<Result<SiteTextReceipt>> {
    const denied = authorizeAdmin(actor, '修改站內文字')
    if (denied) return denied
    if (!isSiteTextKey(key)) return err('VALIDATION_FAILED', '不認得這一種站內文字。', { details: { field: 'key' } })
    if (!isUuid(String(requestId))) return badRequestId()
    const normalized = normalizeSiteText(key, input)
    if (!normalized.ok) return err('VALIDATION_FAILED', normalized.message, { details: { field: normalized.field } })
    const revision = Number(rawRevision)
    // 版本 0＝畫面上還沒有這一列。
    if (!Number.isInteger(revision) || revision < 0) return err('CONFLICT', SITE_TEXT_STALE_MESSAGE)
    const adminId = actor.kind === 'authenticated' ? actor.userId : ''
    const businessNow = await this.#businessClock.now()
    const value = normalized.value

    return inTransaction(
      this.#pool,
      'site-texts',
      async (tx) => {
        const current = (await tx.query<Pick<Row, 'revision'>>(`select revision from site_texts where key = $1 for update`, [key])).rows[0]
        const realAt = this.#realClock.now()
        const begun = await this.#ledger.begin(
          tx,
          {
            actorUserId: adminId,
            operationKind: 'site_text.update',
            requestId,
            fingerprint: sha256(canonicalJson({ key, revision, value })),
            scope: 'global',
          },
          realAt,
        )
        if (begun.outcome !== 'fresh') return replayed<SiteTextReceipt>(begun)
        if ((current?.revision ?? 0) !== revision) return err('CONFLICT', SITE_TEXT_STALE_MESSAGE)

        const values = [key, JSON.stringify(value), realAt, adminId]
        const written = current
          ? await tx.query<{ revision: number }>(
              `update site_texts set value = $2::jsonb, revision = revision + 1, updated_at = $3, updated_by_user_id = $4 where key = $1 returning revision`,
              values,
            )
          : await tx.query<{ revision: number }>(
              `insert into site_texts (key, value, revision, updated_at, updated_by_user_id) values ($1, $2::jsonb, 1, $3, $4) returning revision`,
              values,
            )
        const newRevision = written.rows[0]!.revision

        await this.#audit.append(tx, {
          actorKind: 'user',
          actorUserId: adminId,
          role: 'admin',
          action: 'site_text.updated',
          targetType: 'site_text',
          targetId: null,
          scope: 'global',
          realAt,
          businessAt: businessNow,
          // 站內文字本身是公開字，記下來方便日後查「頁尾／卡片什麼時候改成什麼」。
          payload: { key, revision: newRevision, value },
        })
        const receipt = { key, revision: newRevision, requestId, serverTime: realAt.toISOString() }
        await this.#ledger.commit(tx, begun.recordId, { receipt, resultRef: { key, revision: newRevision } })
        return { ok: true as const, receipt }
      },
      // 兩個分頁同時第一次存：後到的 insert 撞主鍵。
      () => err('CONFLICT', SITE_TEXT_STALE_MESSAGE),
    )
  }
}

export class PgSiteTextsQuery implements SiteTextsQuery {
  readonly #reader: () => Pick<Pool, 'query'>

  constructor(options?: { reader?: () => Pick<Pool, 'query'> }) {
    this.#reader = options?.reader ?? getPool
  }

  async all(): Promise<SiteTexts> {
    const found = await this.#reader().query<Row>(`select key, value, revision, updated_at from site_texts`)
    const texts: { [K in SiteTextKey]?: SiteTextRow<K> } = {}
    for (const row of found.rows) {
      if (!isSiteTextKey(row.key)) continue
      // 形狀不對的列（手動改壞）當沒有列：畫面用預設，不整頁掛掉。
      const value = readSiteText(row.key, row.value)
      if (!value) continue
      texts[row.key] = { key: row.key, value, revision: row.revision, updatedAt: row.updated_at } as SiteTextRow<typeof row.key> as never
    }
    return texts
  }
}
