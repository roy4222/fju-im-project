import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Pool, PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ANONYMOUS, rosterAccessDenied, type ResolvedActor } from '@/application/accounts'
import type { UploadRules } from '@/application/ops'
import { FsFileStorage } from '@/infrastructure/ops/file-storage'
import { assertTestDatabaseReachable, createIsolatedDatabase, poolAsRole, type IsolatedDatabase } from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'

/**
 * 共用檔案能力（票 6；模組 10 §3、§5；FIL-03）。
 *
 * 打真的 PostgreSQL（以 `fju_app` 連線，證明實際 GRANT 夠用也沒有多給）與真的檔案系統
 * （每次一個暫存根目錄）。重點是**拒絕路徑**：偽裝副檔名、超量、中斷、別人的 ticket、
 * 猜網址下載——每一種都要證明「被擋」而且「沒留下東西」。
 */

let db: IsolatedDatabase
let app: Pool
let root: string
let storage: FsFileStorage
let adminId: string
let studentId: string
let otherAdminId: string

const SECRET = 'integration-secret-integration-secret'
const csvRules: UploadRules = { purpose: 'roster_csv', allowedTypes: ['csv'], maxBytes: 1024, scope: { kind: 'global' } }
const CSV = new TextEncoder().encode('student_no,name\n411500001,王小明\n')

function actor(userId: string, roles: ('admin' | 'student' | 'teacher')[], status: 'active' | 'pending' = 'active'): ResolvedActor {
  return { kind: 'authenticated', userId, roles, status, mustChangePassword: false, cohortMemberships: [] }
}

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

/** 送到一半就斷線的串流。 */
function brokenStream(first: Uint8Array): ReadableStream<Uint8Array> {
  let sent = false
  return new ReadableStream({
    pull(controller) {
      if (!sent) {
        sent = true
        controller.enqueue(first)
      } else {
        controller.error(new Error('connection reset'))
      }
    },
  })
}

async function ticketFor(owner: string, fileName = '名單.csv', rules = csvRules) {
  const issued = await storage.issueUploadTicket(owner, { fileName, declaredMime: 'text/csv' }, rules)
  if (!issued.ok) throw new Error(issued.message)
  return issued.receipt
}

async function tmpEntries(): Promise<string[]> {
  return fs.readdir(path.join(root, 'tmp')).catch(() => [])
}

async function fileRow(id: string) {
  const row = await db.sql('select * from stored_files where id = $1', [id])
  return row.rows[0]!
}

async function inTx<T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> {
  const client = await app.connect()
  try {
    await client.query('begin')
    const result = await fn(client)
    await client.query('commit')
    return result
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}

beforeAll(async () => {
  await assertTestDatabaseReachable()
  db = await createIsolatedDatabase({ label: 'files', setup: migratedSchema })
  app = await poolAsRole(db, 'fju_app')
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'fju-files-'))

  const insertUser = async (email: string) => {
    const r = await db.sql(
      `insert into users (id, name, email, email_verified, updated_at, status)
       values (gen_random_uuid(), $1, $1, false, now(), 'active') returning id`,
      [email],
    )
    return String(r.rows[0]!.id)
  }
  adminId = await insertUser('admin@example.com')
  otherAdminId = await insertUser('admin2@example.com')
  studentId = await insertUser('student@example.com')

  storage = new FsFileStorage({
    root: () => root,
    environmentMaxBytes: () => 100 * 1024 * 1024,
    ticketSecret: () => SECRET,
    policies: { roster_csv: (a) => rosterAccessDenied(a) === null },
    db: () => app,
  })
})

afterAll(async () => {
  await app?.end()
  await db?.close()
  if (root) await fs.rm(root, { recursive: true, force: true })
})

describe('上傳：ticket → 串流 → stored', () => {
  it('正常的 CSV 存成 stored，checksum 與內容一致，暫存清空，路徑不含原始檔名', async () => {
    const ticket = await ticketFor(adminId, '../../../etc/115 名單.csv')
    const result = await storage.upload(adminId, ticket.ticket, streamOf(CSV.subarray(0, 10), CSV.subarray(10)), CSV.length)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const expected = createHash('sha256').update(CSV).digest('hex')
    expect(result.receipt.checksum).toBe(expected)
    expect(result.receipt.originalName).toBe('115 名單.csv')

    const row = await fileRow(ticket.fileId)
    expect(row).toMatchObject({ status: 'stored', checksum: expected, mime_detected: 'text/csv', purpose: 'roster_csv', owner_user_id: adminId })
    expect(Number(row.size_bytes)).toBe(CSV.length)
    expect(String(row.storage_key)).toMatch(/^files\/\d{4}\/\d{2}\/[0-9a-f-]{36}$/)
    expect(String(row.storage_key)).not.toContain('名單')

    const onDisk = await fs.readFile(path.join(root, String(row.storage_key)))
    expect(createHash('sha256').update(onDisk).digest('hex')).toBe(expected)
    expect(await tmpEntries()).toEqual([])
  })

  it('同一張 ticket 不能用第二次', async () => {
    const ticket = await ticketFor(adminId)
    expect((await storage.upload(adminId, ticket.ticket, streamOf(CSV), CSV.length)).ok).toBe(true)
    const again = await storage.upload(adminId, ticket.ticket, streamOf(CSV), CSV.length)
    expect(again).toMatchObject({ ok: false, code: 'FORBIDDEN' })
  })

  it('拿別人的 ticket 上傳被擋；檔案列仍是 uploading、沒有暫存', async () => {
    const ticket = await ticketFor(adminId)
    const result = await storage.upload(studentId, ticket.ticket, streamOf(CSV), CSV.length)
    expect(result).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect((await fileRow(ticket.fileId)).status).toBe('uploading')
    expect(await tmpEntries()).toEqual([])
  })

  it('竄改過的 ticket 被擋', async () => {
    const ticket = await ticketFor(adminId)
    const result = await storage.upload(adminId, `${ticket.ticket}x`, streamOf(CSV), CSV.length)
    expect(result).toMatchObject({ ok: false, code: 'FORBIDDEN' })
  })
})

describe('上傳：拒絕路徑都不留下東西', () => {
  it('.exe 改名成 .csv：看內容擋下（FILE_TYPE_REJECTED），暫存刪掉、沒有正式檔', async () => {
    const ticket = await ticketFor(adminId, 'roster.csv')
    const exe = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00])
    const result = await storage.upload(adminId, ticket.ticket, streamOf(exe), exe.length)
    expect(result).toMatchObject({ ok: false, code: 'FILE_TYPE_REJECTED' })

    const row = await fileRow(ticket.fileId)
    expect(row.status).toBe('uploading')
    await expect(fs.access(path.join(root, String(row.storage_key)))).rejects.toThrow()
    expect(await tmpEntries()).toEqual([])
  })

  it('PDF 改名成 .csv 也擋', async () => {
    const ticket = await ticketFor(adminId, 'roster.csv')
    const pdf = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n')
    expect(await storage.upload(adminId, ticket.ticket, streamOf(pdf), pdf.length)).toMatchObject({
      ok: false,
      code: 'FILE_TYPE_REJECTED',
    })
  })

  it('副檔名不在白名單：發 ticket 前就擋，連檔案列都不建', async () => {
    const before = await db.sql('select count(*)::int as n from stored_files')
    const issued = await storage.issueUploadTicket(adminId, { fileName: 'setup.exe', declaredMime: 'application/x-msdownload' }, csvRules)
    expect(issued).toMatchObject({ ok: false, code: 'FILE_TYPE_REJECTED' })
    const after = await db.sql('select count(*)::int as n from stored_files')
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n)
  })

  it('宣告大小超過上限：不讀內容直接擋', async () => {
    const ticket = await ticketFor(adminId)
    const result = await storage.upload(adminId, ticket.ticket, streamOf(new Uint8Array(2048).fill(0x61)), 2048)
    expect(result).toMatchObject({ ok: false, code: 'FILE_TOO_LARGE' })
    expect(await tmpEntries()).toEqual([])
  })

  it('宣告大小說謊（說 100、實際送 2 KB）：以實際收到的位元組計數，超過就中止', async () => {
    const ticket = await ticketFor(adminId)
    const big = new Uint8Array(512).fill(0x61)
    const result = await storage.upload(adminId, ticket.ticket, streamOf(big, big, big), 100)
    expect(result).toMatchObject({ ok: false, code: 'FILE_TOO_LARGE' })
    expect(await tmpEntries()).toEqual([])
  })

  it('送到一半斷線：回「上傳中斷」，暫存刪掉', async () => {
    const ticket = await ticketFor(adminId)
    const result = await storage.upload(adminId, ticket.ticket, brokenStream(CSV.subarray(0, 5)), CSV.length)
    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(await tmpEntries()).toEqual([])
    expect((await fileRow(ticket.fileId)).status).toBe('uploading')
  })

  it('收到的比宣告的少（被截斷）：不當成功', async () => {
    const ticket = await ticketFor(adminId)
    const result = await storage.upload(adminId, ticket.ticket, streamOf(CSV.subarray(0, 10)), CSV.length)
    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(await tmpEntries()).toEqual([])
  })

  it('沒有 Content-Length：拒絕', async () => {
    const ticket = await ticketFor(adminId)
    expect(await storage.upload(adminId, ticket.ticket, streamOf(CSV), null)).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
  })
})

describe('綁到資料上（attach／release）', () => {
  async function storedFile(owner = adminId) {
    const ticket = await ticketFor(owner)
    const result = await storage.upload(owner, ticket.ticket, streamOf(CSV), CSV.length)
    if (!result.ok) throw new Error(result.message)
    return ticket.fileId
  }

  it('attach 建有效引用；release 後同一個引用者再附回不撞唯一鍵（契約 01 §11）', async () => {
    const fileId = await storedFile()
    const ref = { refType: 'roster_version' as const, refId: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b' }

    const first = await inTx((tx) => storage.attach(tx, fileId, ref, { ownerUserId: adminId, purpose: 'roster_csv' }))
    expect(first.ok).toBe(true)
    // 重送同一個 attach：回原本那一筆，不多插。
    const again = await inTx((tx) => storage.attach(tx, fileId, ref, { ownerUserId: adminId, purpose: 'roster_csv' }))
    expect(again.ok && first.ok && again.receipt.referenceId).toBe(first.ok && first.receipt.referenceId)

    await inTx((tx) => storage.release(tx, fileId, ref))
    const reattached = await inTx((tx) => storage.attach(tx, fileId, ref, { ownerUserId: adminId, purpose: 'roster_csv' }))
    expect(reattached.ok).toBe(true)

    const refs = await db.sql('select released_at from file_references where file_id = $1 order by created_at, id', [fileId])
    expect(refs.rowCount).toBe(2)
    expect(refs.rows.filter((r) => r.released_at === null)).toHaveLength(1)
  })

  it('不是自己上傳的、還沒傳完的檔案都不能 attach', async () => {
    const fileId = await storedFile(adminId)
    const ref = { refType: 'roster_version' as const, refId: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c' }
    expect(await inTx((tx) => storage.attach(tx, fileId, ref, { ownerUserId: otherAdminId, purpose: 'roster_csv' }))).toMatchObject({
      ok: false,
      code: 'FILE_NOT_OWNED',
    })

    const pending = await ticketFor(adminId)
    expect(
      await inTx((tx) => storage.attach(tx, pending.fileId, ref, { ownerUserId: adminId, purpose: 'roster_csv' })),
    ).toMatchObject({ ok: false, code: 'FILE_NOT_READY' })
  })
})

describe('下載：每次重新授權（FIL-03）', () => {
  let fileId: string

  beforeAll(async () => {
    const ticket = await ticketFor(adminId, '115 名單.csv')
    const result = await storage.upload(adminId, ticket.ticket, streamOf(CSV), CSV.length)
    if (!result.ok) throw new Error(result.message)
    fileId = ticket.fileId
  })

  async function bytesOf(stream: ReadableStream<Uint8Array>) {
    return new Uint8Array(await new Response(stream).arrayBuffer())
  }

  it('管理員拿得到，內容與 checksum 一致', async () => {
    const result = await storage.authorizeDownload(actor(adminId, ['admin']), fileId)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.receipt).toMatchObject({ originalName: '115 名單.csv', mime: 'text/csv', sizeBytes: CSV.length })
    const bytes = await bytesOf(result.receipt.body)
    expect(bytes).toEqual(CSV)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(result.receipt.checksum)
  })

  it('另一位管理員也拿得到（名單原檔是系辦共用的）', async () => {
    const result = await storage.authorizeDownload(actor(otherAdminId, ['admin']), fileId)
    expect(result.ok).toBe(true)
    if (result.ok) await result.receipt.body.cancel()
  })

  it('沒登入 → UNAUTHENTICATED；學生、老師、待審的管理員 → FORBIDDEN', async () => {
    expect(await storage.authorizeDownload(ANONYMOUS, fileId)).toMatchObject({ ok: false, code: 'UNAUTHENTICATED' })
    expect(await storage.authorizeDownload(actor(studentId, ['student']), fileId)).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await storage.authorizeDownload(actor(studentId, ['teacher']), fileId)).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await storage.authorizeDownload(actor(adminId, ['admin'], 'pending'), fileId)).toMatchObject({ ok: false, code: 'FORBIDDEN' })
  })

  it('不存在的檔案、亂寫的 ID 跟「不是你的」回同一句話', async () => {
    const denied = await storage.authorizeDownload(actor(studentId, ['student']), fileId)
    const missing = await storage.authorizeDownload(actor(adminId, ['admin']), '0199a1b2-c3d4-7e5f-8a9b-000000000000')
    const garbage = await storage.authorizeDownload(actor(adminId, ['admin']), '../../etc/passwd')
    expect(missing).toEqual(denied)
    expect(garbage).toEqual(denied)
  })

  it('還在上傳中的檔案拿不到', async () => {
    const pending = await ticketFor(adminId)
    expect(await storage.authorizeDownload(actor(adminId, ['admin']), pending.fileId)).toMatchObject({ ok: false, code: 'FORBIDDEN' })
  })

  it('沒登記下載政策的用途一律拒絕（預設拒絕）', async () => {
    const rules: UploadRules = { purpose: 'attachment', allowedTypes: ['csv'], maxBytes: 1024, scope: { kind: 'global' } }
    const ticket = await ticketFor(adminId, 'a.csv', rules)
    expect((await storage.upload(adminId, ticket.ticket, streamOf(CSV), CSV.length)).ok).toBe(true)
    expect(await storage.authorizeDownload(actor(adminId, ['admin']), ticket.fileId)).toMatchObject({ ok: false, code: 'FORBIDDEN' })
  })

  it('資料庫裡的 storage key 被竄改成往外跳：丟錯，不會讀到根目錄外的檔', async () => {
    const ticket = await ticketFor(adminId)
    expect((await storage.upload(adminId, ticket.ticket, streamOf(CSV), CSV.length)).ok).toBe(true)
    await db.sql(`update stored_files set storage_key = '../../../etc/hosts' where id = $1`, [ticket.fileId])
    await expect(storage.authorizeDownload(actor(adminId, ['admin']), ticket.fileId)).rejects.toThrow(/根目錄/)
  })
})
