import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Pool, PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { rosterAccessDenied, type ResolvedActor } from '@/application/accounts'
import type { AuditWriter } from '@/application/ops'
import { PgRosterCommand } from '@/infrastructure/accounts/roster-command'
import { PgAuditWriter } from '@/infrastructure/ops/audit-writer'
import { FsFileStorage } from '@/infrastructure/ops/file-storage'
import { PgOperationLedger } from '@/infrastructure/ops/operation-ledger'
import { assertTestDatabaseReachable, createIsolatedDatabase, poolAsRole, type IsolatedDatabase } from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'

/**
 * 名單匯入（票 6；ACC-01；模組 01 §6「名單匯入整批一交易」）。
 *
 * 全程以 `fju_app` 連線：`roster_versions`／`roster_entries` 只有 INSERT、`stored_files` 只能改
 * 幾個狀態欄——用例如果偷偷需要更多權限，這裡會直接紅。
 */

let db: IsolatedDatabase
let app: Pool
let root: string
let adminId: string
let studentId: string
let cohort115: string
let cohort114: string
let storage: FsFileStorage

const fixture = await fs.readFile(path.join(import.meta.dirname, '../../../test/fixtures/roster-115-test.csv'))

function actor(userId: string, roles: ('admin' | 'student')[]): ResolvedActor {
  return { kind: 'authenticated', userId, roles, status: 'active', mustChangePassword: false, cohortMemberships: [] }
}

function command(audit: AuditWriter<PoolClient> = new PgAuditWriter()) {
  return new PgRosterCommand({
    files: storage,
    audit,
    ledger: new PgOperationLedger(() => app),
    db: () => app,
  })
}

async function uploadFixture(owner: string, bytes: Uint8Array = fixture, name = 'roster-115-test.csv') {
  const roster = command()
  const ticket = await roster.startUpload(actor(owner, ['admin']), { fileName: name, declaredMime: 'text/csv', declaredSize: bytes.length })
  if (!ticket.ok) throw new Error(ticket.message)
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes)
      c.close()
    },
  })
  const uploaded = await storage.upload(owner, ticket.receipt.ticket, body, bytes.length)
  if (!uploaded.ok) throw new Error(uploaded.message)
  return uploaded.receipt.fileId
}

let seq = 0
const requestId = () => `22222222-2222-4222-8222-${String(++seq).padStart(12, '0')}`

beforeAll(async () => {
  await assertTestDatabaseReachable()
  db = await createIsolatedDatabase({ label: 'roster', setup: migratedSchema })
  app = await poolAsRole(db, 'fju_app')
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'fju-roster-'))

  const user = async (email: string, name: string) =>
    String(
      (
        await db.sql(
          `insert into users (id, name, email, email_verified, updated_at, status)
           values (gen_random_uuid(), $2, $1, false, now(), 'active') returning id`,
          [email, name],
        )
      ).rows[0]!.id,
    )
  adminId = await user('a1@example.com', '系辦 A1')
  studentId = await user('s1@example.com', '學生 S1')

  const cohort = async (code: string, open: boolean) =>
    String(
      (
        await db.sql(
          `insert into cohorts (id, code, name, created_by_kind, is_registration_open)
           values (gen_random_uuid(), $1, $2, 'system', $3) returning id`,
          [code, `${code} 學年度專題`, open],
        )
      ).rows[0]!.id,
    )
  cohort115 = await cohort('115', true)
  cohort114 = await cohort('114', false)

  storage = new FsFileStorage({
    root: () => root,
    environmentMaxBytes: () => 100 * 1024 * 1024,
    ticketSecret: () => 'integration-secret-integration-secret',
    policies: { roster_csv: (a) => rosterAccessDenied(a) === null },
    db: () => app,
  })
})

afterAll(async () => {
  await app?.end()
  await db?.close()
  if (root) await fs.rm(root, { recursive: true, force: true })
})

describe('預覽', () => {
  it('ACC-01：15 列 → 13 有效、1 重複、1 缺欄；自動選到 CSV 裡的 115 屆；不寫任何名單資料', async () => {
    const fileId = await uploadFixture(adminId)
    const preview = await command().preview(actor(adminId, ['admin']), { fileId, cohortId: null })
    expect(preview.ok).toBe(true)
    if (!preview.ok) return
    expect(preview.receipt.counts).toMatchObject({ total: 15, valid: 13, duplicate: 1, missing: 1, conflict: 0 })
    expect(preview.receipt.selectedCohortId).toBe(cohort115)
    expect(preview.receipt.cohorts.map((c) => c.code).sort()).toEqual(['114', '115'])
    expect(preview.receipt.sample[0]).toMatchObject({ studentNo: '411500001', departmentClass: '資管二甲' })

    const versions = await db.sql('select count(*)::int as n from roster_versions')
    expect(versions.rows[0]!.n).toBe(0)
  })

  it('選了別的屆別：CSV 屆別欄與所選不同的列標成提醒', async () => {
    const fileId = await uploadFixture(adminId)
    const preview = await command().preview(actor(adminId, ['admin']), { fileId, cohortId: cohort114 })
    expect(preview.ok && preview.receipt.selectedCohortId).toBe(cohort114)
    expect(preview.ok && preview.receipt.counts.cohortMismatch).toBe(13)
  })

  it('學生、別的管理員上傳的檔都不能預覽', async () => {
    const fileId = await uploadFixture(adminId)
    expect(await command().preview(actor(studentId, ['student']), { fileId, cohortId: null })).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await command().preview(actor(studentId, ['admin']), { fileId, cohortId: null })).toMatchObject({
      ok: false,
      code: 'FILE_NOT_OWNED',
    })
  })

  it('格式不對的 CSV 回可讀的原因', async () => {
    const fileId = await uploadFixture(adminId, new TextEncoder().encode('學號,姓名\n1,王\n'), 'bad.csv')
    const preview = await command().preview(actor(adminId, ['admin']), { fileId, cohortId: null })
    expect(preview).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(!preview.ok && preview.message).toMatch(/不認得的欄位/)
  })
})

describe('匯入（整批一交易）', () => {
  it('寫一個名單版本、13 筆名單列、原檔引用、稽核與帳本；原檔可追溯', async () => {
    const fileId = await uploadFixture(adminId)
    const rid = requestId()
    const result = await command().importRoster(actor(adminId, ['admin']), { fileId, cohortId: cohort115, requestId: rid })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const { rosterVersionId } = result.receipt
    expect(result.receipt.counts.valid).toBe(13)

    const version = (await db.sql('select * from roster_versions where id = $1', [rosterVersionId])).rows[0]!
    expect(version).toMatchObject({ cohort_id: cohort115, imported_by_user_id: adminId, file_id: fileId })
    expect((version.summary as { counts: unknown }).counts).toMatchObject({ total: 15, valid: 13, duplicate: 1, missing: 1 })

    const entries = await db.sql(
      'select student_no, name_raw, name_normalized, department_class, email, conflict_flag from roster_entries where roster_version_id = $1 order by student_no',
      [rosterVersionId],
    )
    expect(entries.rowCount).toBe(13)
    expect(entries.rows.find((e) => e.student_no === '411500009')).toMatchObject({ email: null, department_class: '資管二乙' })
    expect(entries.rows.find((e) => e.student_no === '411500013')).toMatchObject({
      name_raw: 'Nguyen, Van An',
      name_normalized: 'nguyen, van an',
    })
    expect(entries.rows.find((e) => e.student_no === '411500006')?.department_class).toBeNull()
    expect(entries.rows.every((e) => e.conflict_flag === null)).toBe(true)

    const refs = await db.sql(
      `select ref_type, ref_id from file_references where file_id = $1 and released_at is null`,
      [fileId],
    )
    expect(refs.rows).toEqual([{ ref_type: 'roster_version', ref_id: rosterVersionId }])

    const audit = await db.sql(`select actor_user_id, scope, cohort_id from audit_events where action = 'roster.import' and target_id = $1`, [
      rosterVersionId,
    ])
    expect(audit.rows).toEqual([{ actor_user_id: adminId, scope: 'cohort', cohort_id: cohort115 }])
  })

  it('同一個 requestId 重送（連點、斷線重試）只匯入一次，回同一個版本', async () => {
    const fileId = await uploadFixture(adminId)
    const rid = requestId()
    const first = await command().importRoster(actor(adminId, ['admin']), { fileId, cohortId: cohort115, requestId: rid })
    const second = await command().importRoster(actor(adminId, ['admin']), { fileId, cohortId: cohort115, requestId: rid })
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.receipt.rosterVersionId).toBe(first.receipt.rosterVersionId)

    const count = await db.sql('select count(*)::int as n from roster_versions where file_id = $1', [fileId])
    expect(count.rows[0]!.n).toBe(1)
  })

  it('同一個 requestId 換了屆別：REQUEST_MISMATCH，不偷偷匯入', async () => {
    const fileId = await uploadFixture(adminId)
    const rid = requestId()
    expect((await command().importRoster(actor(adminId, ['admin']), { fileId, cohortId: cohort115, requestId: rid })).ok).toBe(true)
    expect(await command().importRoster(actor(adminId, ['admin']), { fileId, cohortId: cohort114, requestId: rid })).toMatchObject({
      ok: false,
      code: 'REQUEST_MISMATCH',
    })
  })

  it('中途失敗（例如稽核寫不進去）整批回滾：沒有半套名單', async () => {
    const fileId = await uploadFixture(adminId)
    const failing = { append: async () => Promise.reject(new Error('audit down')) }
    await expect(
      command(failing).importRoster(actor(adminId, ['admin']), { fileId, cohortId: cohort115, requestId: requestId() }),
    ).rejects.toThrow('audit down')

    expect((await db.sql('select count(*)::int as n from roster_versions where file_id = $1', [fileId])).rows[0]!.n).toBe(0)
    expect((await db.sql('select count(*)::int as n from file_references where file_id = $1', [fileId])).rows[0]!.n).toBe(0)
  })

  it('學生不能匯入；不存在的屆別不能匯入', async () => {
    const fileId = await uploadFixture(adminId)
    expect(
      await command().importRoster(actor(studentId, ['student']), { fileId, cohortId: cohort115, requestId: requestId() }),
    ).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(
      await command().importRoster(actor(adminId, ['admin']), {
        fileId,
        cohortId: '0199a1b2-c3d4-7e5f-8a9b-000000000000',
        requestId: requestId(),
      }),
    ).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
  })

  it('版本列表看得到誰、何時、哪一屆、幾筆與原檔；學生看不到', async () => {
    const listed = await command().listVersions(actor(adminId, ['admin']))
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    expect(listed.receipt.versions.length).toBeGreaterThan(0)
    expect(listed.receipt.versions[0]).toMatchObject({
      cohortCode: '115',
      importedBy: '系辦 A1',
      fileName: 'roster-115-test.csv',
      counts: expect.objectContaining({ valid: 13 }),
    })
    expect(await command().listVersions(actor(studentId, ['student']))).toMatchObject({ ok: false, code: 'FORBIDDEN' })
  })
})
