import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { assertTestDatabaseReachable, createIsolatedDatabase, poolAsRole, type IsolatedDatabase } from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'
import type { ResolvedActor } from '@/application/accounts'
import { PgAuditWriter, sha256 } from '@/infrastructure/ops/audit-writer'
import { FsFileStorage } from '@/infrastructure/ops/file-storage'
import { PgOperationLedger } from '@/infrastructure/ops/operation-ledger'
import { PgShowcaseCommand, PgShowcaseQuery, summaryChecksum } from '@/infrastructure/showcase/pg-showcase'
import { createPosterPolicy } from '@/infrastructure/showcase/poster-policy'

/**
 * 票 25／S11-03：管理員替一組建精選草稿（題目、摘要、海報、影片連結；不發布）。
 *
 * 全部以正式執行角色 `fju_app` 連線（欄級 GRANT 寫錯的話這裡直接紅）。
 * 驗：建立後兩表各一列、授權參照是空的；同組第二份被拒；摘要 checksum 對前後空白穩定；海報只收圖片、
 * 換圖 release 舊引用；兩位管理員同時改，後存的 `CONFLICT`；非管理員 `FORBIDDEN`；同請求編號重送回原回執；
 * 不寫 `showcase_versions`；海報下載：管理員、該組組員與主指導可以，別組學生不行。
 */

let owner: IsolatedDatabase
let app: Pool
let root: string
let storage: FsFileStorage
let command: PgShowcaseCommand
let query: PgShowcaseQuery
let a1: string
let a2: string
const businessClock = { now: async () => new Date('2026-12-01T02:00:00Z') }

function actor(userId: string, roles: ('admin' | 'teacher' | 'student')[]): ResolvedActor {
  return { kind: 'authenticated', userId, roles, status: 'active', mustChangePassword: false, cohortMemberships: [] }
}

let seq = 0
async function newUser(name: string, role: 'admin' | 'teacher' | 'student'): Promise<string> {
  seq += 1
  const row = await owner.sql(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), $1, $2, true, now(), 'active') returning id`,
    [name, `sc${seq}-${randomUUID().slice(0, 8)}@example.com`],
  )
  const id = String(row.rows[0]!.id)
  await owner.sql(
    `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at) values (gen_random_uuid(), $1, $2, $1, now())`,
    [id, role],
  )
  return id
}

async function scenario(status: 'active' | 'archived' = 'active') {
  seq += 1
  const cohort = await owner.sql(
    `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
     values (gen_random_uuid(), $1, $1, $2, '2027-06-30', 'system') returning id`,
    [`S11-${seq}`, status],
  )
  const cohortId = String(cohort.rows[0]!.id)
  const student = await newUser('組員', 'student')
  const outsider = await newUser('別組學生', 'student')
  const teacher = await newUser('指導老師', 'teacher')
  const group = await owner.sql(
    `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
     values (gen_random_uuid(), $1, 'G01', 'general', now(), now(), 'system') returning id`,
    [cohortId],
  )
  const groupId = String(group.rows[0]!.id)
  await owner.sql(
    `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind) values (gen_random_uuid(), $1, $2, $3, now(), 'system')`,
    [groupId, cohortId, student],
  )
  await owner.sql(
    `insert into advisor_assignments (id, group_id, teacher_user_id, source, valid_from, assigned_by_user_id, reason)
     values (gen_random_uuid(), $1, $2, 'admin', now(), $3, '指派')`,
    [groupId, teacher, a1],
  )
  return { cohortId, groupId, student, outsider, teacher }
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
const PNG2 = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x53])
const PDF = new TextEncoder().encode('%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n')

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

async function uploadPoster(adminId: string, entryId: string, name: string, bytes: Uint8Array, mime: string) {
  const ticket = await command.requestPosterUpload(actor(adminId, ['admin']), {
    entryId,
    fileName: name,
    declaredMime: mime,
    declaredSize: bytes.length,
  })
  if (!ticket.ok) return ticket
  return storage.upload(adminId, ticket.receipt.ticket, streamOf(bytes), bytes.length)
}

async function mustCreate(groupId: string) {
  const created = await command.createDraft(actor(a1, ['admin']), { groupId }, randomUUID())
  if (!created.ok) throw new Error(`${created.code} ${created.message}`)
  return created.receipt
}

async function download(who: ResolvedActor, fileId: string) {
  const result = await storage.authorizeDownload(who, fileId)
  if (result.ok) await result.receipt.body.cancel()
  return result.ok ? 'ok' : result.code
}

beforeAll(async () => {
  await assertTestDatabaseReachable()
  owner = await createIsolatedDatabase({ label: 'showcase', setup: migratedSchema })
  app = await poolAsRole(owner, 'fju_app')
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'fju-showcase-files-'))
  a1 = await newUser('系辦一', 'admin')
  a2 = await newUser('系辦二', 'admin')
  storage = new FsFileStorage({
    root: () => root,
    environmentMaxBytes: () => 100 * 1024 * 1024,
    ticketSecret: () => 'showcase-secret-showcase-secret-showcase',
    policies: { poster: createPosterPolicy(() => app) },
    db: () => app,
  })
  command = new PgShowcaseCommand({
    audit: new PgAuditWriter(),
    ledger: new PgOperationLedger(() => app),
    files: storage,
    businessClock,
    pool: () => app,
  })
  query = new PgShowcaseQuery({ pool: () => app })
})

afterAll(async () => {
  await app?.end()
  await owner?.close()
  await fs.rm(root, { recursive: true, force: true })
})

describe('建立精選草稿', () => {
  it('建立後條目與草稿各一列、狀態草稿、沒有授權參照；同組第二份 CONFLICT；同請求編號重送回原回執', async () => {
    const s = await scenario()
    const requestId = randomUUID()
    const created = await command.createDraft(actor(a1, ['admin']), { groupId: s.groupId }, requestId)
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.receipt).toMatchObject({ groupCode: 'G01', revision: 1 })

    const rows = await owner.sql(
      `select e.status, d.title, d.summary, d.summary_checksum, d.authorization_kind, d.authorization_ref, d.revision
         from showcase_entries e join showcase_drafts d on d.entry_id = e.id where e.group_id = $1`,
      [s.groupId],
    )
    expect(rows.rows).toEqual([
      {
        status: 'draft',
        title: '',
        summary: '',
        summary_checksum: sha256(''),
        authorization_kind: null,
        authorization_ref: null,
        revision: 1,
      },
    ])

    const replay = await command.createDraft(actor(a1, ['admin']), { groupId: s.groupId }, requestId)
    expect(replay.ok && replay.receipt.entryId).toBe(created.receipt.entryId)

    const second = await command.createDraft(actor(a2, ['admin']), { groupId: s.groupId }, randomUUID())
    expect(second).toMatchObject({ ok: false, code: 'CONFLICT' })
    expect(second.ok ? '' : second.message).toMatch(/已經有精選草稿/)
    expect((await owner.sql('select count(*)::int as n from showcase_entries where group_id = $1', [s.groupId])).rows[0]!.n).toBe(1)
  })

  it('學生、老師 FORBIDDEN；解散的組 GROUP_DISSOLVED；封存的屆 COHORT_ARCHIVED；都沒寫任何列', async () => {
    const s = await scenario()
    expect(await command.createDraft(actor(s.student, ['student']), { groupId: s.groupId }, randomUUID())).toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
    })
    expect(await command.createDraft(actor(s.teacher, ['teacher']), { groupId: s.groupId }, randomUUID())).toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
    })
    await owner.sql(`update groups set status = 'dissolved', dissolved_real_at = now(), dissolve_reason = '測試' where id = $1`, [
      s.groupId,
    ])
    expect(await command.createDraft(actor(a1, ['admin']), { groupId: s.groupId }, randomUUID())).toMatchObject({
      ok: false,
      code: 'GROUP_DISSOLVED',
    })
    const archived = await scenario('archived')
    expect(await command.createDraft(actor(a1, ['admin']), { groupId: archived.groupId }, randomUUID())).toMatchObject({
      ok: false,
      code: 'COHORT_ARCHIVED',
    })
    expect(
      (await owner.sql('select count(*)::int as n from showcase_entries where group_id = any($1::uuid[])', [[s.groupId, archived.groupId]]))
        .rows[0]!.n,
    ).toBe(0)
  })
})

describe('編輯精選草稿', () => {
  it('存題目、摘要、影片連結與 PNG 海報；重新讀回都在；摘要 checksum 對前後空白與換行穩定、不同摘要不同', async () => {
    const s = await scenario()
    const { entryId } = await mustCreate(s.groupId)
    const poster = await uploadPoster(a1, entryId, 'poster.png', PNG, 'image/png')
    expect(poster.ok).toBe(true)
    if (!poster.ok) return
    const saved = await command.updateDraft(
      actor(a1, ['admin']),
      { entryId, revision: 1, title: '  智慧校園導覽  ', summary: '第一段\r\n第二段  ', videoUrl: 'https://youtu.be/demo', posterFileId: poster.receipt.fileId },
      randomUUID(),
    )
    expect(saved).toMatchObject({ ok: true, receipt: { revision: 2, posterChanged: true } })

    const board = await query.adminBoard(actor(a1, ['admin']), s.cohortId)
    expect(board.ok).toBe(true)
    if (!board.ok) return
    const draft = board.receipt.drafts[0]!
    expect(draft).toMatchObject({
      title: '智慧校園導覽',
      summary: '第一段\n第二段',
      videoUrl: 'https://youtu.be/demo',
      poster: { fileId: poster.receipt.fileId, name: 'poster.png', checksum: poster.receipt.checksum },
      revision: 2,
      frozenInVersions: 0,
    })
    expect(board.receipt.groups).toEqual([{ id: s.groupId, code: 'G01', entryId }])

    const stored = await owner.sql('select summary_checksum, poster_checksum from showcase_drafts where entry_id = $1', [entryId])
    expect(stored.rows[0]).toEqual({ summary_checksum: summaryChecksum('第一段\n第二段'), poster_checksum: poster.receipt.checksum })
    expect(summaryChecksum('  第一段\r\n第二段 \n')).toBe(summaryChecksum('第一段\n第二段'))
    expect(summaryChecksum('第一段\n第三段')).not.toBe(summaryChecksum('第一段\n第二段'))
    // 本票不寫發布版本。
    expect((await owner.sql('select count(*)::int as n from showcase_versions')).rows[0]!.n).toBe(0)
  })

  it('海報換成非圖片被拒（上傳憑證就擋；硬塞別的用途的檔也擋），原海報保留；換 PNG 後舊引用 release、新引用有效', async () => {
    const s = await scenario()
    const { entryId } = await mustCreate(s.groupId)
    const first = await uploadPoster(a1, entryId, 'a.png', PNG, 'image/png')
    if (!first.ok) throw new Error(first.message)
    const r1 = await command.updateDraft(
      actor(a1, ['admin']),
      { entryId, revision: 1, title: 'T', summary: 'S', videoUrl: '', posterFileId: first.receipt.fileId },
      randomUUID(),
    )
    expect(r1.ok).toBe(true)

    // 1) 副檔名與宣告的類型就不對：連上傳憑證都拿不到。
    expect(await uploadPoster(a1, entryId, 'report.pdf', PDF, 'application/pdf')).toMatchObject({ ok: false, code: 'FILE_TYPE_REJECTED' })
    // 2) 假裝是 PNG 的 PDF：內容檢查擋掉。
    const disguised = await uploadPoster(a1, entryId, 'fake.png', PDF, 'image/png')
    expect(disguised.ok).toBe(false)
    // 3) 別的用途（繳交）的檔案 id 直接塞進來：attach 驗用途，被拒。
    const other = await owner.sql(
      `insert into stored_files (id, owner_user_id, scope, cohort_id, purpose, original_name, size_bytes, mime_declared, mime_detected,
                                 extension, checksum, status, storage_key, uploaded_real_at, finalized_at)
       values (gen_random_uuid(), $1, 'cohort', $2, 'submission', 'x.pdf', 10, 'application/pdf', 'application/pdf', 'pdf', $3,
               'stored', $4, now(), now()) returning id`,
      [a1, s.cohortId, 'e'.repeat(64), `k-${randomUUID()}`],
    )
    const sneaky = await command.updateDraft(
      actor(a1, ['admin']),
      { entryId, revision: 2, title: 'T', summary: 'S', videoUrl: '', posterFileId: String(other.rows[0]!.id) },
      randomUUID(),
    )
    expect(sneaky).toMatchObject({ ok: false, code: 'FILE_NOT_OWNED' })
    const kept = await owner.sql('select poster_file_id, revision from showcase_drafts where entry_id = $1', [entryId])
    expect(kept.rows[0]).toEqual({ poster_file_id: first.receipt.fileId, revision: 2 })

    const second = await uploadPoster(a1, entryId, 'b.png', PNG2, 'image/png')
    if (!second.ok) throw new Error(second.message)
    const r2 = await command.updateDraft(
      actor(a1, ['admin']),
      { entryId, revision: 2, title: 'T', summary: 'S', videoUrl: '', posterFileId: second.receipt.fileId },
      randomUUID(),
    )
    expect(r2).toMatchObject({ ok: true, receipt: { posterChanged: true, revision: 3 } })
    const refs = await owner.sql(
      `select file_id, released_at is not null as released from file_references
        where ref_type = 'showcase_draft' and ref_id = $1 order by created_at`,
      [entryId],
    )
    expect(refs.rows).toEqual([
      { file_id: first.receipt.fileId, released: true },
      { file_id: second.receipt.fileId, released: false },
    ])
    const saved = await owner.sql('select poster_checksum from showcase_drafts where entry_id = $1', [entryId])
    expect(saved.rows[0]!.poster_checksum).toBe(second.receipt.checksum)
  })

  it('A2 先存、A1 用舊版本號再存 → CONFLICT「請重新載入」，內容是 A2 的；影片連結不是網址被拒', async () => {
    const s = await scenario()
    const { entryId } = await mustCreate(s.groupId)
    const byA2 = await command.updateDraft(
      actor(a2, ['admin']),
      { entryId, revision: 1, title: 'A2 的題目', summary: '', videoUrl: '', posterFileId: null },
      randomUUID(),
    )
    expect(byA2.ok).toBe(true)
    const byA1 = await command.updateDraft(
      actor(a1, ['admin']),
      { entryId, revision: 1, title: 'A1 的題目', summary: '', videoUrl: '', posterFileId: null },
      randomUUID(),
    )
    expect(byA1).toMatchObject({ ok: false, code: 'CONFLICT' })
    expect(byA1.ok ? '' : byA1.message).toMatch(/重新載入/)
    expect((await owner.sql('select title from showcase_drafts where entry_id = $1', [entryId])).rows[0]!.title).toBe('A2 的題目')

    const badUrl = await command.updateDraft(
      actor(a1, ['admin']),
      { entryId, revision: 2, title: 'x', summary: '', videoUrl: 'javascript:alert(1)', posterFileId: null },
      randomUUID(),
    )
    expect(badUrl).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', details: { field: 'videoUrl' } })
  })

  it('非管理員直接呼叫編輯、要上傳憑證、讀精選頁都是 FORBIDDEN，草稿沒變', async () => {
    const s = await scenario()
    const { entryId } = await mustCreate(s.groupId)
    const student = actor(s.student, ['student'])
    expect(
      await command.updateDraft(student, { entryId, revision: 1, title: '偷改', summary: '', videoUrl: '', posterFileId: null }, randomUUID()),
    ).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(
      await command.requestPosterUpload(student, { entryId, fileName: 'a.png', declaredMime: 'image/png', declaredSize: 16 }),
    ).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await query.adminBoard(actor(s.teacher, ['teacher']), s.cohortId)).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect((await owner.sql('select title, revision from showcase_drafts where entry_id = $1', [entryId])).rows[0]).toEqual({
      title: '',
      revision: 1,
    })
  })
})

describe('海報下載', () => {
  it('管理員、該組組員與主指導可以；別組學生、沒被引用的（剛上傳還沒存）不行', async () => {
    const s = await scenario()
    const { entryId } = await mustCreate(s.groupId)
    const poster = await uploadPoster(a1, entryId, 'p.png', PNG, 'image/png')
    if (!poster.ok) throw new Error(poster.message)
    // 還沒存進草稿：連管理員都拿不到（沒有有效引用）。
    expect(await download(actor(a1, ['admin']), poster.receipt.fileId)).toBe('FORBIDDEN')
    await command.updateDraft(
      actor(a1, ['admin']),
      { entryId, revision: 1, title: 'T', summary: '', videoUrl: '', posterFileId: poster.receipt.fileId },
      randomUUID(),
    )
    expect(await download(actor(a1, ['admin']), poster.receipt.fileId)).toBe('ok')
    expect(await download(actor(s.student, ['student']), poster.receipt.fileId)).toBe('ok')
    expect(await download(actor(s.teacher, ['teacher']), poster.receipt.fileId)).toBe('ok')
    expect(await download(actor(s.outsider, ['student']), poster.receipt.fileId)).toBe('FORBIDDEN')
  })
})
