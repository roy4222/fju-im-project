import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Pool, PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ANONYMOUS, rosterAccessDenied, type ResolvedActor } from '@/application/accounts'
import { isCacheableDownload, type FileFacts, type FilePurpose, type UploadRules } from '@/application/ops'
import { PgAuditWriter } from '@/infrastructure/ops/audit-writer'
import { FsFileStorage, PgFileAdminCommand } from '@/infrastructure/ops/file-storage'
import { PgOperationLedger } from '@/infrastructure/ops/operation-ledger'
import { createHeroPhotoPolicy } from '@/infrastructure/site/hero-photo-policy'
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

  it('訪客：不存在的檔案與存在但不給看的檔案，回應相同、查資料庫的形狀也相同（不靠時間差探測）', async () => {
    const statements: string[] = []
    const counting = {
      query: (text: string, values?: unknown[]) => {
        statements.push(text)
        return app.query(text, values)
      },
    } as unknown as Pool
    const probe = new FsFileStorage({
      root: () => root,
      environmentMaxBytes: () => 100 * 1024 * 1024,
      ticketSecret: () => SECRET,
      policies: { roster_csv: (a) => rosterAccessDenied(a) === null },
      db: () => counting,
    })

    const hidden = await probe.authorizeDownload(ANONYMOUS, fileId)
    const hiddenStatements = statements.splice(0)
    const missing = await probe.authorizeDownload(ANONYMOUS, '0199a1b2-c3d4-7e5f-8a9b-000000000000')
    const missingStatements = statements.splice(0)

    expect(hidden).toMatchObject({ ok: false, code: 'UNAUTHENTICATED' })
    expect(missing).toEqual(hidden)
    expect(missingStatements).toEqual(hiddenStatements)
  })

  it('公開讀取例外（第三波 W3）：待審、必須改密的人比照訪客，只拿得到登記成公開的用途裡、政策對訪客放行的檔', async () => {
    // 首頁大圖：政策只放行「目前首頁用的那一張」。公告附件：假設政策對誰都放行，但這個用途沒登記成公開讀取。
    const photoRules: UploadRules = { purpose: 'photo', allowedTypes: ['csv'], maxBytes: 1024, scope: { kind: 'global' } }
    const attachmentRules: UploadRules = { purpose: 'attachment', allowedTypes: ['csv'], maxBytes: 1024, scope: { kind: 'global' } }
    const current = await ticketFor(adminId, 'hero.csv', photoRules)
    const old = await ticketFor(adminId, 'old.csv', photoRules)
    const attachment = await ticketFor(adminId, 'a.csv', attachmentRules)
    for (const t of [current, old, attachment]) {
      expect((await storage.upload(adminId, t.ticket, streamOf(CSV), CSV.length)).ok).toBe(true)
    }
    const seen: ResolvedActor[] = []
    const gated = new FsFileStorage({
      root: () => root,
      environmentMaxBytes: () => 100 * 1024 * 1024,
      ticketSecret: () => SECRET,
      policies: {
        photo: (a, f) => {
          seen.push(a)
          return f.id === current.fileId
        },
        attachment: () => true,
        roster_csv: (a) => rosterAccessDenied(a) === null,
      },
      publicReadPurposes: ['photo'],
      db: () => app,
    })
    const pendingUser = actor(studentId, ['student'], 'pending')
    const mustChange: ResolvedActor = { kind: 'authenticated', userId: studentId, roles: ['student'], status: 'active', mustChangePassword: true, cohortMemberships: [] }
    const pendingAdmin = actor(adminId, ['admin'], 'pending')

    for (const who of [pendingUser, mustChange, pendingAdmin]) {
      const got = await gated.authorizeDownload(who, current.fileId)
      expect(got.ok).toBe(true)
      if (got.ok) await got.receipt.body.cancel()
      // 其他首頁大圖、沒登記成公開讀取的用途（即使政策放行）、名單原檔：照舊「無法存取」。
      expect(await gated.authorizeDownload(who, old.fileId)).toMatchObject({ ok: false, code: 'FORBIDDEN' })
      expect(await gated.authorizeDownload(who, attachment.fileId)).toMatchObject({ ok: false, code: 'FORBIDDEN' })
      expect(await gated.authorizeDownload(who, fileId)).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    }
    // 被狀態閘門擋下的人是以訪客的身分問政策，角色帶不進去（待審的管理員不會因為是管理員而多拿到東西）。
    expect(seen.filter((a) => a.kind !== 'anonymous')).toEqual([])
    // 不存在的檔：同一句話。
    expect(await gated.authorizeDownload(pendingUser, '0199a1b2-c3d4-7e5f-8a9b-000000000000')).toMatchObject({ ok: false, code: 'FORBIDDEN' })
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

describe('publicRead：訪客走同一條政策也放行＝此刻對所有人公開（V4，設計方案 §3.4）', () => {
  // 海報與公告附件的政策用假的，形狀照真的政策（poster-policy、attachment-policy）：
  // 誰看得到只看「這個檔現在是哪一種」，真的資料關聯由各自的整合測試與 e2e 證明。首頁大圖用真的政策。
  type Visibility = 'everyone' | 'members' | 'admins' | 'students'
  const visibility = new Map<string, Visibility>()
  const calls: { purpose: FilePurpose; actor: ResolvedActor; facts: FileFacts }[] = []
  const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'))
  let pngStorage: FsFileStorage

  const byVisibility = (purpose: FilePurpose) => (a: ResolvedActor, f: FileFacts) => {
    calls.push({ purpose, actor: a, facts: f })
    const v = visibility.get(f.id)
    if (v === 'everyone') return true
    if (a.kind !== 'authenticated') return false
    if (v === 'members') return true
    if (v === 'students') return a.roles.includes('student') || a.roles.includes('admin')
    return v === 'admins' && a.roles.includes('admin')
  }

  beforeAll(async () => {
    const hero = createHeroPhotoPolicy(() => app)
    pngStorage = new FsFileStorage({
      root: () => root,
      environmentMaxBytes: () => 100 * 1024 * 1024,
      ticketSecret: () => SECRET,
      policies: {
        poster: byVisibility('poster'),
        attachment: byVisibility('attachment'),
        photo: (a, f) => {
          calls.push({ purpose: 'photo', actor: a, facts: f })
          return hero(a, f)
        },
      },
      publicReadPurposes: ['photo'],
      db: () => app,
    })
  })

  async function storedPng(purpose: FilePurpose, name: string): Promise<string> {
    const rules: UploadRules = { purpose, allowedTypes: ['png'], maxBytes: 1024, scope: { kind: 'global' } }
    const issued = await pngStorage.issueUploadTicket(adminId, { fileName: name, declaredMime: 'image/png' }, rules)
    if (!issued.ok) throw new Error(issued.message)
    const uploaded = await pngStorage.upload(adminId, issued.receipt.ticket, streamOf(PNG), PNG.length)
    if (!uploaded.ok) throw new Error(uploaded.message)
    return issued.receipt.fileId
  }

  async function download(who: ResolvedActor, fileId: string) {
    calls.splice(0)
    const result = await pngStorage.authorizeDownload(who, fileId)
    if (!result.ok) return { result, calls: calls.splice(0) }
    await result.receipt.body.cancel()
    return { result, receipt: result.receipt, calls: calls.splice(0) }
  }

  const admin = () => actor(adminId, ['admin'])
  const student = () => actor(studentId, ['student'])

  it('海報：發布中有獎項的對所有人公開；沒獎項（只給登入者）與草稿（只給系辦）不是公開', async () => {
    const award = await storedPng('poster', 'award.png')
    const noAward = await storedPng('poster', 'no-award.png')
    const draft = await storedPng('poster', 'draft.png')
    visibility.set(award, 'everyone').set(noAward, 'members').set(draft, 'admins')

    for (const who of [admin(), student()]) {
      const got = await download(who, award)
      expect(got.receipt).toMatchObject({ publicRead: true, mime: 'image/png' })
      expect(isCacheableDownload(got.receipt!)).toBe(true)
    }
    const visitor = await download(ANONYMOUS, award)
    expect(visitor.receipt).toMatchObject({ publicRead: true, mime: 'image/png' })

    for (const who of [admin(), student()]) {
      const got = await download(who, noAward)
      expect(got.receipt?.publicRead).toBe(false)
      expect(isCacheableDownload(got.receipt!)).toBe(false)
    }
    expect((await download(ANONYMOUS, noAward)).result).toMatchObject({ ok: false, code: 'UNAUTHENTICATED' })

    const draftAdmin = await download(admin(), draft)
    expect(draftAdmin.receipt?.publicRead).toBe(false)
    expect((await download(student(), draft)).result).toMatchObject({ ok: false, code: 'FORBIDDEN' })
  })

  it('公告附件：對象「公開訪客」的公開；對象「本屆學生」的（就算是 PNG）不是公開', async () => {
    const publicCover = await storedPng('attachment', 'cover.png')
    const studentOnly = await storedPng('attachment', 'students.png')
    visibility.set(publicCover, 'everyone').set(studentOnly, 'students')

    expect((await download(student(), publicCover)).receipt?.publicRead).toBe(true)
    const privatePng = await download(student(), studentOnly)
    expect(privatePng.receipt).toMatchObject({ publicRead: false, mime: 'image/png' })
    expect(isCacheableDownload(privatePng.receipt!)).toBe(false)
    expect((await download(admin(), studentOnly)).receipt?.publicRead).toBe(false)
    expect((await download(ANONYMOUS, studentOnly)).result).toMatchObject({ ok: false, code: 'UNAUTHENTICATED' })
  })

  it('首頁大圖（真的政策）：現任那張公開；換圖後舊圖對誰都拿不到', async () => {
    const current = await storedPng('photo', 'hero-now.png')
    const old = await storedPng('photo', 'hero-old.png')
    await db.sql(
      `insert into home_settings (id, hero_file_id, updated_by_user_id) values (1, $1, $2)
       on conflict (id) do update set hero_file_id = excluded.hero_file_id`,
      [old, adminId],
    )
    expect((await download(ANONYMOUS, old)).receipt?.publicRead).toBe(true)
    await db.sql('update home_settings set hero_file_id = $1 where id = 1', [current])

    for (const who of [ANONYMOUS, admin(), student(), actor(studentId, ['student'], 'pending')]) {
      expect((await download(who, current)).receipt?.publicRead).toBe(true)
    }
    expect((await download(ANONYMOUS, old)).result).toMatchObject({ ok: false, code: 'UNAUTHENTICATED' })
    expect((await download(admin(), old)).result).toMatchObject({ ok: false, code: 'FORBIDDEN' })
  })

  it('登入者多問一次政策：以訪客身分、同一份檔案事實（不重查）；訪客與比照訪客的人不多問', async () => {
    const award = await storedPng('poster', 'award-2.png')
    visibility.set(award, 'everyone')

    const loggedIn = await download(student(), award)
    expect(loggedIn.calls.map((c) => c.actor.kind)).toEqual(['authenticated', 'anonymous'])
    expect(loggedIn.calls[1]!.actor).toBe(ANONYMOUS)
    expect(loggedIn.calls[1]!.facts).toBe(loggedIn.calls[0]!.facts)

    expect((await download(ANONYMOUS, award)).calls).toHaveLength(1)

    const hero = await storedPng('photo', 'hero-gated.png')
    await db.sql('update home_settings set hero_file_id = $1 where id = 1', [hero])
    const gated = await download(actor(studentId, ['student'], 'pending'), hero)
    expect(gated.receipt?.publicRead).toBe(true)
    expect(gated.calls.map((c) => c.actor)).toEqual([ANONYMOUS])
  })

  it('不放行的人不會被多問一次（拒絕路徑的查詢形狀不變）', async () => {
    const draft = await storedPng('poster', 'draft-2.png')
    visibility.set(draft, 'admins')
    const denied = await download(student(), draft)
    expect(denied.result).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(denied.calls).toHaveLength(1)
  })
})

describe('頭像：收檔轉換與換掉的檔（SH-9，設計方案 §2.2 ▶R2-5）', () => {
  const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'))
  const avatarRules: UploadRules = { purpose: 'avatar', allowedTypes: ['png'], maxBytes: 2 * 1024 * 1024, scope: { kind: 'global' } }
  const pngRules: UploadRules = { purpose: 'submission', allowedTypes: ['png'], maxBytes: 1024, scope: { kind: 'global' } }
  const OUTPUT = Buffer.from('RIFF\x00\x00\x00\x00WEBPfake-avatar-output', 'latin1')
  let transformed: FsFileStorage
  let failing: FsFileStorage

  function options(transform: (input: Buffer) => Promise<{ bytes: Buffer; mime: string }>) {
    return {
      root: () => root,
      environmentMaxBytes: () => 100 * 1024 * 1024,
      ticketSecret: () => SECRET,
      policies: {
        avatar: (a: ResolvedActor) => a.kind === 'authenticated' && a.status === 'active',
        submission: (a: ResolvedActor) => a.kind === 'authenticated' && a.status === 'active',
      },
      db: () => app,
      transforms: { avatar: transform },
    }
  }

  beforeAll(() => {
    transformed = new FsFileStorage(options(async () => ({ bytes: OUTPUT, mime: 'image/webp' })))
    failing = new FsFileStorage(
      options(async () => {
        throw new Error('sharp: Input buffer contains unsupported image format')
      }),
    )
  })

  async function uploaded(store: FsFileStorage, rules: UploadRules) {
    const issued = await store.issueUploadTicket(studentId, { fileName: 'me.png', declaredMime: 'image/png' }, rules)
    if (!issued.ok) throw new Error(issued.message)
    return { fileId: issued.receipt.fileId, result: await store.upload(studentId, issued.receipt.ticket, streamOf(PNG), PNG.length) }
  }

  it('有轉換的用途：存下來的是輸出，size／checksum／mime 都以輸出重算；其他用途照原樣存', async () => {
    const avatar = await uploaded(transformed, avatarRules)
    const sha = createHash('sha256').update(OUTPUT).digest('hex')
    expect(avatar.result).toMatchObject({ ok: true, receipt: { sizeBytes: OUTPUT.length, checksum: sha, mimeDetected: 'image/webp' } })
    const row = await fileRow(avatar.fileId)
    expect(row).toMatchObject({ status: 'stored', checksum: sha, mime_detected: 'image/webp' })
    expect(Number(row.size_bytes)).toBe(OUTPUT.length)
    expect(await fs.readFile(path.join(root, String(row.storage_key)))).toEqual(OUTPUT)

    const plain = await uploaded(transformed, pngRules)
    expect(plain.result).toMatchObject({ ok: true, receipt: { sizeBytes: PNG.length, mimeDetected: 'image/png' } })
  })

  it('轉換丟錯（sharp 解不開）：FILE_TYPE_REJECTED，列維持 uploading、暫存刪掉；下載仍是 FORBIDDEN（不是 404）', async () => {
    const before = await tmpEntries()
    const bad = await uploaded(failing, avatarRules)
    expect(bad.result).toMatchObject({ ok: false, code: 'FILE_TYPE_REJECTED' })
    expect(await fileRow(bad.fileId)).toMatchObject({ status: 'uploading', checksum: null })
    expect(await tmpEntries()).toEqual(before)
    expect(await failing.authorizeDownload(actor(studentId, ['student']), bad.fileId)).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await failing.authorizeDownload(actor(adminId, ['admin']), bad.fileId)).toMatchObject({ ok: false, code: 'FORBIDDEN' })
  })

  it('soft_deleted／purged 的頭像 → FILE_GONE（登入者）；訪客仍是 UNAUTHENTICATED、待審的人仍是 FORBIDDEN', async () => {
    for (const status of ['soft_deleted', 'purged'] as const) {
      const avatar = await uploaded(transformed, avatarRules)
      expect((await transformed.authorizeDownload(actor(adminId, ['admin']), avatar.fileId)).ok).toBe(true)
      await db.sql(`update stored_files set status = $2, soft_deleted_at = now() where id = $1`, [avatar.fileId, status])
      for (const who of [actor(adminId, ['admin']), actor(studentId, ['student'])]) {
        expect(await transformed.authorizeDownload(who, avatar.fileId)).toMatchObject({ ok: false, code: 'FILE_GONE' })
      }
      expect(await transformed.authorizeDownload(ANONYMOUS, avatar.fileId)).toMatchObject({ ok: false, code: 'UNAUTHENTICATED' })
      expect(await transformed.authorizeDownload(actor(studentId, ['student'], 'pending'), avatar.fileId)).toMatchObject({
        ok: false,
        code: 'FORBIDDEN',
      })
    }
  })

  it('soft_deleted 的非頭像檔仍是 FORBIDDEN（私有檔「不存在」與「不是你的」同一句話）', async () => {
    const plain = await uploaded(transformed, pngRules)
    expect((await transformed.authorizeDownload(actor(studentId, ['student']), plain.fileId)).ok).toBe(true)
    await db.sql(`update stored_files set status = 'soft_deleted', soft_deleted_at = now() where id = $1`, [plain.fileId])
    expect(await transformed.authorizeDownload(actor(studentId, ['student']), plain.fileId)).toMatchObject({ ok: false, code: 'FORBIDDEN' })
  })
})

describe('系辦刪掉沒人用的檔（C1-16；AC-15，①設計方案 §1.6）', () => {
  let command: PgFileAdminCommand
  const admin = () => actor(adminId, ['admin'])

  beforeAll(() => {
    command = new PgFileAdminCommand({
      db: () => app,
      audit: new PgAuditWriter(),
      ledger: new PgOperationLedger(() => app),
      businessClock: { now: async () => new Date() },
    })
  })

  async function storedFile() {
    const ticket = await ticketFor(adminId)
    const result = await storage.upload(adminId, ticket.ticket, streamOf(CSV), CSV.length)
    if (!result.ok) throw new Error(result.message)
    return ticket.fileId
  }

  async function auditRows(fileId: string) {
    return (await db.sql(`select action, target_type, actor_user_id, payload from audit_events where target_id = $1`, [fileId])).rows
  }

  it('沒有引用：標 soft_deleted、記 soft_deleted_at、稽核 file.delete 一筆；之後下載被拒', async () => {
    const fileId = await storedFile()
    expect((await storage.authorizeDownload(admin(), fileId)).ok).toBe(true)

    const result = await command.deleteUnreferenced(admin(), fileId, crypto.randomUUID())
    expect(result).toMatchObject({ ok: true, receipt: { fileId, name: '名單.csv' } })

    const row = await fileRow(fileId)
    expect(row.status).toBe('soft_deleted')
    expect(row.soft_deleted_at).toBeInstanceOf(Date)
    const audits = await auditRows(fileId)
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ action: 'file.delete', target_type: 'stored_file', actor_user_id: adminId })
    expect(audits[0]!.payload).toMatchObject({ name: '名單.csv', purpose: 'roster_csv' })
    expect(await storage.authorizeDownload(admin(), fileId)).toMatchObject({ ok: false, code: 'FORBIDDEN' })
  })

  it('還有引用：CONFLICT 帶處數，檔案、引用、稽核都不動（不拿 release 代替）', async () => {
    const fileId = await storedFile()
    const ref = { refType: 'roster_version' as const, refId: crypto.randomUUID() }
    expect((await inTx((tx) => storage.attach(tx, fileId, ref, { ownerUserId: adminId, purpose: 'roster_csv' }))).ok).toBe(true)

    const result = await command.deleteUnreferenced(admin(), fileId, crypto.randomUUID())
    expect(result).toMatchObject({ ok: false, code: 'CONFLICT' })
    expect(!result.ok && result.message).toContain('還有 1 處在用')

    expect(await fileRow(fileId)).toMatchObject({ status: 'stored', soft_deleted_at: null })
    const refs = await db.sql('select released_at from file_references where file_id = $1', [fileId])
    expect(refs.rows).toEqual([{ released_at: null }])
    expect(await auditRows(fileId)).toEqual([])
  })

  it('首頁大圖（不寫 file_references，由 home_settings 指著）也算一處在用：CONFLICT，檔案不動', async () => {
    const fileId = await storedFile()
    await db.sql(
      `insert into home_settings (id, hero_file_id, updated_by_user_id) values (1, $1, $2)
       on conflict (id) do update set hero_file_id = excluded.hero_file_id`,
      [fileId, adminId],
    )
    try {
      const result = await command.deleteUnreferenced(admin(), fileId, crypto.randomUUID())
      expect(result).toMatchObject({ ok: false, code: 'CONFLICT' })
      expect(!result.ok && result.message).toContain('還有 1 處在用')
      expect((await fileRow(fileId)).status).toBe('stored')
    } finally {
      await db.sql('update home_settings set hero_file_id = null where id = 1')
    }
  })

  it('引用都解除了（released_at 有值）才算沒人用，可以刪', async () => {
    const fileId = await storedFile()
    const ref = { refType: 'roster_version' as const, refId: crypto.randomUUID() }
    await inTx((tx) => storage.attach(tx, fileId, ref, { ownerUserId: adminId, purpose: 'roster_csv' }))
    await inTx((tx) => storage.release(tx, fileId, ref))
    expect((await command.deleteUnreferenced(admin(), fileId, crypto.randomUUID())).ok).toBe(true)
    expect((await fileRow(fileId)).status).toBe('soft_deleted')
  })

  it('同一個請求編號重送：回原回執，不再寫一次稽核；已刪的檔換新編號再刪 → VALIDATION_FAILED', async () => {
    const fileId = await storedFile()
    const requestId = crypto.randomUUID()
    const first = await command.deleteUnreferenced(admin(), fileId, requestId)
    const again = await command.deleteUnreferenced(admin(), fileId, requestId)
    expect(first.ok && again.ok && again.receipt.serverTime).toBe(first.ok && first.receipt.serverTime)
    expect(await auditRows(fileId)).toHaveLength(1)
    expect(await command.deleteUnreferenced(admin(), fileId, crypto.randomUUID())).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
  })

  it('不是系辦、待審的系辦、訪客都不能刪；檔案不動', async () => {
    const fileId = await storedFile()
    expect(await command.deleteUnreferenced(actor(studentId, ['student']), fileId, crypto.randomUUID())).toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
    })
    expect(await command.deleteUnreferenced(actor(adminId, ['admin'], 'pending'), fileId, crypto.randomUUID())).toMatchObject({
      ok: false,
      code: 'ACCOUNT_PENDING',
    })
    expect(await command.deleteUnreferenced(ANONYMOUS, fileId, crypto.randomUUID())).toMatchObject({ ok: false, code: 'UNAUTHENTICATED' })
    expect((await fileRow(fileId)).status).toBe('stored')
  })

  it('檔案編號、請求編號格式不對 → VALIDATION_FAILED；不存在的檔 → VALIDATION_FAILED', async () => {
    expect(await command.deleteUnreferenced(admin(), 'nope', crypto.randomUUID())).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(await command.deleteUnreferenced(admin(), crypto.randomUUID(), 'nope')).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(await command.deleteUnreferenced(admin(), crypto.randomUUID(), crypto.randomUUID())).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
    })
  })
})
