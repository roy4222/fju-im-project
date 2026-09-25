import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { listStoredFiles } from '@/infrastructure/ops/file-list'
import { assertTestDatabaseReachable, createIsolatedDatabase, poolAsRole, type IsolatedDatabase } from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'

/**
 * 檔案管理頁的唯讀清單（票 35）：以 `fju_app` 連線（證明既有 GRANT 夠讀），
 * 只列 stored 的檔、帶上傳者、有效引用數與引用位置（附件 → 項目、封面 → 項目）。
 */

let db: IsolatedDatabase
let app: Pool
let adminId: string
let cohortId: string
let itemId: string
const ids = { attached: '', cover: '', loose: '', released: '', deleted: '' }

const CHECKSUM = 'a'.repeat(64)

async function insertFile(name: string, status: 'stored' | 'soft_deleted', uploadedMinutesAgo: number): Promise<string> {
  const r = await db.sql(
    `insert into stored_files (id, owner_user_id, scope, cohort_id, purpose, original_name, size_bytes, mime_declared,
       extension, checksum, status, storage_key, uploaded_real_at, finalized_at, soft_deleted_at)
     values (gen_random_uuid(), $1, 'cohort', $2, 'attachment', $3, 2048, 'application/pdf', 'pdf', $4, $5,
       'files/' || gen_random_uuid(), now() - make_interval(mins => $6), now(),
       case when $5 = 'soft_deleted' then now() end)
     returning id`,
    [adminId, cohortId, name, CHECKSUM, status, uploadedMinutesAgo],
  )
  return String(r.rows[0]!.id)
}

async function reference(fileId: string, refType: string, refId: string, released = false) {
  await db.sql(
    `insert into file_references (id, file_id, ref_type, ref_id, released_at)
     values (gen_random_uuid(), $1, $2, $3, case when $4 then now() end)`,
    [fileId, refType, refId, released],
  )
}

beforeAll(async () => {
  await assertTestDatabaseReachable()
  db = await createIsolatedDatabase({ label: 'file_list', setup: migratedSchema })
  app = await poolAsRole(db, 'fju_app')

  const user = await db.sql(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), '系辦小王', 'admin@example.com', false, now(), 'active') returning id`,
  )
  adminId = String(user.rows[0]!.id)
  const cohort = await db.sql(
    `insert into cohorts (id, code, name, status, created_by_kind) values (gen_random_uuid(), 'T35', 'T35', 'preparing', 'system') returning id`,
  )
  cohortId = String(cohort.rows[0]!.id)

  ids.attached = await insertFile('報告範本.pdf', 'stored', 5)
  ids.cover = await insertFile('封面.png', 'stored', 4)
  ids.loose = await insertFile('沒人用.pdf', 'stored', 3)
  ids.released = await insertFile('解除過.pdf', 'stored', 2)
  ids.deleted = await insertFile('已刪除.pdf', 'soft_deleted', 1)

  const item = await db.sql(
    `insert into managed_items (id, cohort_id, placement, audience_kind, title, cover_file_id, created_by_kind)
     values (gen_random_uuid(), $1, 'resource', 'signed_in', '期中報告範本', $2, 'system') returning id`,
    [cohortId, ids.cover],
  )
  itemId = String(item.rows[0]!.id)
  await db.sql('insert into item_attachments (item_id, file_id, sort) values ($1, $2, 0)', [itemId, ids.attached])
  await reference(ids.attached, 'item_attachment', itemId)
  await reference(ids.cover, 'item_attachment', itemId)
  await reference(ids.released, 'item_attachment', itemId, true)
})

afterAll(async () => {
  await app?.end()
  await db?.close()
})

describe('listStoredFiles', () => {
  it('只列 stored 的檔，新的在前；帶上傳者、屆別與有效引用數', async () => {
    const rows = await listStoredFiles(app)
    expect(rows.map((r) => r.name)).toEqual(['解除過.pdf', '沒人用.pdf', '封面.png', '報告範本.pdf'])
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]))
    expect(byName['報告範本.pdf']).toMatchObject({ uploaderName: '系辦小王', cohortCode: 'T35', sizeBytes: 2048, activeRefs: 1 })
    // 解除過的引用不算。
    expect(byName['解除過.pdf']!.activeRefs).toBe(0)
    expect(byName['沒人用.pdf']).toMatchObject({ activeRefs: 0, where: null })
  })

  it('引用位置：附件與封面都指到那一筆專題事務', async () => {
    const rows = await listStoredFiles(app)
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]))
    expect(byName['報告範本.pdf']!.where).toEqual({ kind: 'item_attachment', itemId, title: '期中報告範本', placement: 'resource' })
    expect(byName['封面.png']!.where).toEqual({ kind: 'item_cover', itemId, title: '期中報告範本', placement: 'resource' })
  })
})
