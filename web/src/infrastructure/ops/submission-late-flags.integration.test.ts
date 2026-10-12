import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { assertTestDatabaseReachable, createIsolatedDatabase, poolAsRole, type IsolatedDatabase } from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'
import { PgAuditWriter } from '@/infrastructure/ops/audit-writer'
import { PgSubmissionLateFlags } from '@/infrastructure/ops/submission-late-flags'

/**
 * 第三波 W10（PR #374 第四輪）：收件模組不再直接讀模組 10 的 `audit_events` 判「補交」，改問這個 port。
 * 這裡證明 port 本身：只認 `submission.submit` 且 `late: true` 的稽核；`late: false`、沒有這個鍵、別的動作都不算；
 * 一次批次查，空陣列不打資料庫。
 */

let db: IsolatedDatabase
let app: Pool
let itemId: string
const NOW = new Date('2026-11-16T02:00:00Z')

async function audit(action: string, payload: Record<string, unknown>) {
  const client = await app.connect()
  try {
    await new PgAuditWriter().append(client, {
      actorKind: 'system',
      action,
      targetType: 'item',
      targetId: itemId,
      scope: 'global',
      realAt: NOW,
      businessAt: NOW,
      payload,
    })
  } finally {
    client.release()
  }
}

beforeAll(async () => {
  await assertTestDatabaseReachable()
  db = await createIsolatedDatabase({ label: 'late_flags', setup: migratedSchema })
  app = await poolAsRole(db, 'fju_app')
  itemId = randomUUID()
})

afterAll(async () => {
  await app?.end()
  await db?.close()
})

describe('SubmissionLateFlags（模組 10 的批次查詢 port）', () => {
  it('只有「submission.submit 且 late: true」的版本在集合裡；late: false、沒有鍵、別的動作、沒問到的都不算', async () => {
    const late = randomUUID()
    const onTime = randomUUID()
    const legacy = randomUUID()
    const otherAction = randomUUID()
    const notAsked = randomUUID()
    await audit('submission.submit', { submissionVersionId: late, late: true, versionNo: 1 })
    await audit('submission.submit', { submissionVersionId: onTime, late: false, versionNo: 2 })
    await audit('submission.submit', { submissionVersionId: legacy, versionNo: 3 })
    await audit('submission.reopen', { submissionVersionId: otherAction, late: true })
    await audit('submission.submit', { submissionVersionId: notAsked, late: true, versionNo: 4 })

    const flags = await new PgSubmissionLateFlags(() => app).lateByVersionIds([late, onTime, legacy, otherAction, randomUUID()])
    expect([...flags]).toEqual([late])
  })

  it('一次批次查：N 個版本只打一次資料庫；空陣列不打', async () => {
    let calls = 0
    const counting = () => ({
      query: (...args: Parameters<Pool['query']>) => {
        calls += 1
        return app.query(...args)
      },
    })
    const ids = [randomUUID(), randomUUID(), randomUUID()]
    for (const id of ids) await audit('submission.submit', { submissionVersionId: id, late: true })
    const port = new PgSubmissionLateFlags(counting as unknown as () => Pick<Pool, 'query'>)

    expect([...(await port.lateByVersionIds(ids))].sort()).toEqual([...ids].sort())
    expect(calls).toBe(1)
    expect((await port.lateByVersionIds([])).size).toBe(0)
    expect(calls).toBe(1)
  })
})
