import 'server-only'
import { uuidv7 } from 'uuidv7'
import type { PoolClient } from 'pg'
import {
  receiptExpiryFrom,
  type LedgerBeginResult,
  type LedgerOperation,
  type OperationLedger,
} from '@/application/ops'
import type { Pool } from 'pg'
import { getPool } from '@/infrastructure/db/client'

/**
 * 操作帳本（契約 01 §8 的 ON CONFLICT 協議）。
 *
 * 要解決的問題：使用者按兩次送出、或送出後回應在路上掉了又重送。
 * 解法是每個會改資料的動作都帶一個 `requestId`，帳本對
 * `(actor_user_id, operation_kind, request_id)` 有唯一鍵：
 *
 * ```sql
 * INSERT ... ON CONFLICT (actor_user_id, operation_kind, request_id) DO NOTHING RETURNING id
 * ```
 *
 * - **有回傳列** → 第一次，繼續跑用例。
 * - **沒有回傳列** → 已經有人插過了。這裡有個 PostgreSQL 的細節值得寫下來：
 *   兩個交易同時 INSERT 同一個鍵時，後到的那個會**卡在 `DO NOTHING` 上等**前者 commit
 *   或 rollback；前者 commit 就回 0 列（本交易沒進 aborted 狀態，可以直接 SELECT 讀回），
 *   前者 rollback 則後者的 INSERT 會成功。所以不需要額外的鎖或重試迴圈。
 *   讀回來之後比 `fingerprint`：一樣就回原回執，不一樣就 `REQUEST_MISMATCH`。
 *
 * 帳本列寫在用例交易內，用例失敗整體回滾（不留 failed 列）；`state='failed'` 只用在
 * 「已 commit 但後續外部步驟失敗」。
 */
export class PgOperationLedger implements OperationLedger<PoolClient> {
  /**
   * 查回執是唯一不在用例交易裡的操作，所以它自己要有連線來源。
   * 預設用應用連線池；測試會傳自己的隔離 schema 連線進來。
   */
  readonly #reader: () => Pick<Pool, 'query'>

  constructor(reader: () => Pick<Pool, 'query'> = getPool) {
    this.#reader = reader
  }

  async begin(tx: PoolClient, operation: LedgerOperation, committedRealAt: Date): Promise<LedgerBeginResult> {
    const id = uuidv7()
    const inserted = await tx.query<{ id: string }>(
      `insert into operation_records
         (id, actor_user_id, operation_kind, request_id, fingerprint, state,
          result_ref, receipt, scope, cohort_id, committed_real_at, receipt_expires_at)
       values ($1, $2, $3, $4, $5, 'committed', '{}'::jsonb, null, $6, $7, $8, $9)
       on conflict (actor_user_id, operation_kind, request_id) do nothing
       returning id`,
      [
        id,
        operation.actorUserId,
        operation.operationKind,
        operation.requestId,
        operation.fingerprint,
        operation.scope,
        operation.cohortId ?? null,
        committedRealAt,
        receiptExpiryFrom(committedRealAt),
      ],
    )

    if (inserted.rowCount === 1) return { outcome: 'fresh', recordId: inserted.rows[0]!.id }

    // 沒插進去＝已經有一筆。同一交易內讀回來比對內容。
    const existing = await tx.query<{
      id: string
      fingerprint: string
      receipt: unknown
      result_ref: unknown
    }>(
      `select id, fingerprint, receipt, result_ref
       from operation_records
       where actor_user_id = $1 and operation_kind = $2 and request_id = $3`,
      [operation.actorUserId, operation.operationKind, operation.requestId],
    )

    const row = existing.rows[0]
    if (!row) {
      // 前一個交易 rollback 了，鍵其實是空的——重試一次 INSERT 就會成功。
      return this.begin(tx, operation, committedRealAt)
    }

    if (row.fingerprint !== operation.fingerprint) return { outcome: 'mismatch' }

    return {
      outcome: 'replay',
      recordId: row.id,
      receipt: row.receipt,
      resultRef: row.result_ref,
      receiptExpired: row.receipt === null,
    }
  }

  async commit(
    tx: PoolClient,
    recordId: string,
    payload: { receipt: unknown; resultRef: unknown },
  ): Promise<void> {
    // 只改矩陣允許的四欄（契約 01 §5 的欄級 GRANT）。
    await tx.query(
      `update operation_records set receipt = $2::jsonb, result_ref = $3::jsonb where id = $1`,
      [recordId, JSON.stringify(payload.receipt ?? null), JSON.stringify(payload.resultRef ?? {})],
    )
  }

  /** 查回執：只回本人的紀錄（契約 01 §8）。 */
  async get(actorUserId: string, operationKind: string, requestId: string): Promise<LedgerBeginResult> {
    const rows = await this.#reader().query<{
      id: string
      fingerprint: string
      receipt: unknown
      result_ref: unknown
    }>(
      `select id, fingerprint, receipt, result_ref
       from operation_records
       where actor_user_id = $1 and operation_kind = $2 and request_id = $3`,
      [actorUserId, operationKind, requestId],
    )

    const row = rows.rows[0]
    if (!row) return { outcome: 'mismatch' }
    return {
      outcome: 'replay',
      recordId: row.id,
      receipt: row.receipt,
      resultRef: row.result_ref,
      // 回執被 worker 清掉了；結果參照仍在（契約 01 §4.4）。
      receiptExpired: row.receipt === null,
    }
  }
}
