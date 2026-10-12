import 'server-only'
import type { Pool } from 'pg'
import type { SubmissionLateFlags } from '@/application/ops'
import { getPool } from '@/infrastructure/db/client'

type Reader = () => Pick<Pool, 'query'>

/**
 * `SubmissionLateFlags` 的 PostgreSQL 實作（模組 10；第三波 W10）。
 *
 * 只讀 `audit_events`：那一版送出時的 `submission.submit` 稽核帶 `late: true` 就是補交。稽核只插不改，
 * 所以系辦之後延長或提早全體截止，歷史版本的標記都不會變。一次用陣列查完整批，不逐版本查。
 */
export class PgSubmissionLateFlags implements SubmissionLateFlags {
  readonly #reader: Reader

  constructor(reader: Reader = getPool) {
    this.#reader = reader
  }

  async lateByVersionIds(versionIds: readonly string[]): Promise<ReadonlySet<string>> {
    if (versionIds.length === 0) return new Set()
    const rows = await this.#reader().query<{ version_id: string }>(
      `select distinct ae.payload->>'submissionVersionId' as version_id
         from audit_events ae
        where ae.target_type = 'item' and ae.action = 'submission.submit'
          and ae.payload @> '{"late": true}'::jsonb
          and ae.payload->>'submissionVersionId' = any($1::text[])`,
      [[...versionIds]],
    )
    return new Set(rows.rows.map((r) => r.version_id))
  }
}
