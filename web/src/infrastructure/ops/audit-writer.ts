import 'server-only'
import { createHash } from 'node:crypto'
import { uuidv7 } from 'uuidv7'
import type { PoolClient } from 'pg'
import type { AuditEventInput, AuditWriter } from '@/application/ops'

/**
 * 稽核紀錄的寫入（契約 01 §4.3；模組 10 §5）。
 *
 * 只有 INSERT，沒有 UPDATE 也沒有 DELETE——`fju_app` 根本沒有那兩個權限，
 * 資料庫還掛了 trigger 當第二層（S00-05）。所以這個類別不提供「修改稽核」的方法：
 * 不是忘了寫，是刻意沒有。
 *
 * 用 `PoolClient`（不是連線池）當 `tx`：稽核必須跟業務寫入在**同一個交易**，
 * 用例回滾時稽核也要跟著不見（契約 01 §8）。
 */
export class PgAuditWriter implements AuditWriter<PoolClient> {
  async append(tx: PoolClient, event: AuditEventInput): Promise<string> {
    const id = uuidv7()
    await tx.query(
      `insert into audit_events
         (id, actor_kind, actor_user_id, role, action, target_type, target_id,
          scope, cohort_id, reason, verification_method, real_at, business_at, payload)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)`,
      [
        id,
        event.actorKind,
        event.actorUserId ?? null,
        event.role ?? null,
        event.action,
        event.targetType,
        event.targetId ?? null,
        event.scope,
        event.cohortId ?? null,
        event.reason ?? null,
        event.verificationMethod ?? null,
        event.realAt,
        event.businessAt,
        JSON.stringify(event.payload ?? {}),
      ],
    )
    return id
  }
}

/**
 * 內容指紋（契約 01 §4.4：sha256 of canonical JSON）。
 *
 * 放在 infrastructure 是因為 `node:crypto` 不能進 application 層；
 * 「怎麼把物件變成穩定字串」那一半在 `application/ops/records.ts`，可以單獨測。
 */
export function sha256(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}
