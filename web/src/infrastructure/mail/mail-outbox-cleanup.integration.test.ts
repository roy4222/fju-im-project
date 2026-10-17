import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { purgeMailOutbox } from '@/infrastructure/mail/mail-outbox-cleanup'
import {
  assertTestDatabaseReachable,
  createIsolatedDatabase,
  poolAsRole,
  type IsolatedDatabase,
} from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'

/**
 * B 階段 VB-13：寄信紀錄 90 天清理（AC-VI-80）。全程以 `fju_app` 連線，DELETE 權限漏給這裡就紅。
 */

const NOW = new Date('2026-10-20T12:00:00Z')
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000)
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60 * 1000)

let db: IsolatedDatabase
let app: Pool

beforeAll(async () => {
  await assertTestDatabaseReachable()
  db = await createIsolatedDatabase({ label: 'vb13-outbox-cleanup', setup: migratedSchema })
  app = await poolAsRole(db, 'fju_app')
})

afterAll(async () => {
  await app?.end()
  await db?.close()
})

async function seed(label: string, status: string, createdAt: Date) {
  await db.sql(
    `insert into mail_outbox (id, to_email, template, subject, status, created_at)
     values (gen_random_uuid(), $1, 'email_otp', 'x', $2, $3)`,
    [`${label}@example.com`, status, createdAt],
  )
}
const remaining = async () =>
  (await db.sql(`select to_email from mail_outbox order by to_email`)).rows.map((r) =>
    String(r.to_email).replace('@example.com', ''),
  )

describe('purgeMailOutbox', () => {
  it('AC-VI-80：91 天前的 sent／failed、超過 1 小時的 queued 刪掉，89 天那列保留，回傳 3', async () => {
    await db.sql('delete from mail_outbox')
    await seed('old-sent', 'sent', daysAgo(91))
    await seed('old-failed', 'failed', daysAgo(91))
    await seed('fresh-sent', 'sent', daysAgo(89))
    await seed('old-queued', 'queued', daysAgo(91))
    expect(await purgeMailOutbox(app, NOW)).toBe(3)
    expect(await remaining()).toEqual(['fresh-sent'])
  })

  it('剛寄、還在寄送中的 queued（未滿 1 小時）不刪；超過 1 小時且過 90 天才刪', async () => {
    await db.sql('delete from mail_outbox')
    await seed('queued-now', 'queued', minutesAgo(5))
    expect(await purgeMailOutbox(app, NOW, { keepDays: 0 })).toBe(0)
    expect(await remaining()).toEqual(['queued-now'])
    expect(await purgeMailOutbox(app, new Date(NOW.getTime() + 2 * 60 * 60 * 1000), { keepDays: 0 })).toBe(1)
  })

  it('剛好 90 天整的不刪（只刪早於 90 天前的）', async () => {
    await db.sql('delete from mail_outbox')
    await seed('edge', 'sent', daysAgo(90))
    expect(await purgeMailOutbox(app, NOW)).toBe(0)
  })

  it('超過一批的量會接著刪完，總數正確', async () => {
    await db.sql('delete from mail_outbox')
    for (let i = 0; i < 7; i++) await seed(`bulk-${i}`, 'captured', daysAgo(100 + i))
    await seed('keep', 'sent', daysAgo(1))
    expect(await purgeMailOutbox(app, NOW, { batch: 3 })).toBe(7)
    expect(await remaining()).toEqual(['keep'])
  })

  it('沒有可刪的列回傳 0', async () => {
    await db.sql('delete from mail_outbox')
    expect(await purgeMailOutbox(app, NOW)).toBe(0)
  })
})
