import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Pool } from 'pg'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ANONYMOUS, type ResolvedActor } from '@/application/accounts'
import { PgAvatarCommand } from '@/infrastructure/accounts/avatar-store'
import { avatarImageTransform } from '@/infrastructure/ops/avatar-image'
import { PgAuditWriter } from '@/infrastructure/ops/audit-writer'
import { FsFileStorage } from '@/infrastructure/ops/file-storage'
import { assertTestDatabaseReachable, createIsolatedDatabase, poolAsRole, type IsolatedDatabase } from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'

/**
 * 頭像用例（SH-9；AC-SH-44～47、AC-SH-84 的上傳段、Q109）。
 *
 * 真的 PostgreSQL（以 `fju_app` 連線：證明 GRANT 夠用）＋真的檔案系統＋真的 sharp（`avatarImageTransform`）。
 * 上傳走跟 `/api/files/upload` 同一條 `FsFileStorage.upload`，只是不經 HTTP。
 */

let db: IsolatedDatabase
let app: Pool
let root: string
let files: FsFileStorage
let command: PgAvatarCommand
let adminId: string
let teacherId: string
let studentId: string
let otherId: string
let noProfileId: string

const SECRET = 'integration-secret-integration-secret'
const FIXTURE = new URL('../../../test/fixtures/exif.jpg', import.meta.url)

function actor(userId: string, roles: ('admin' | 'student' | 'teacher')[], status: 'active' | 'pending' = 'active'): ResolvedActor {
  return { kind: 'authenticated', userId, roles, status, mustChangePassword: false, cohortMemberships: [] }
}
const student = () => actor(studentId, ['student'])
const admin = () => actor(adminId, ['admin'])

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.sql(sql, params)).rows[0] as T
}

async function profile(userId: string) {
  return one<{ avatar_preset: number | null; avatar_file_id: string | null }>(
    'select avatar_preset, avatar_file_id from user_profiles where user_id = $1',
    [userId],
  )
}

/** 照畫面的順序：取票 → 上傳位元組 → 回傳上傳結果與檔案編號（還沒換上去）。 */
async function upload(who: ResolvedActor, bytes: Uint8Array, fileName: string, declaredMime: string) {
  const ticket = await command.avatarUploadTicket(who, { fileName, declaredMime, declaredSize: bytes.length })
  if (!ticket.ok) return { ticket, uploaded: null, fileId: null }
  const userId = who.kind === 'authenticated' ? who.userId : ''
  const uploaded = await files.upload(userId, ticket.receipt.ticket, streamOf(bytes), bytes.length)
  return { ticket, uploaded, fileId: ticket.receipt.fileId }
}

async function uploadFixture(who: ResolvedActor = student()): Promise<string> {
  const { uploaded, fileId } = await upload(who, await fs.readFile(FIXTURE), 'IMG_0001.JPG', 'image/jpeg')
  if (!uploaded?.ok || !fileId) throw new Error(`上傳失敗：${JSON.stringify(uploaded)}`)
  return fileId
}

async function auditRows(action: string, targetId: string) {
  return (
    await db.sql(
      `select actor_user_id, role, reason, payload from audit_events where action = $1 and target_id = $2 order by real_at, id`,
      [action, targetId],
    )
  ).rows as { actor_user_id: string; role: string | null; reason: string | null; payload: Record<string, unknown> }[]
}

beforeAll(async () => {
  await assertTestDatabaseReachable()
  db = await createIsolatedDatabase({ label: 'avatars', setup: migratedSchema })
  app = await poolAsRole(db, 'fju_app')
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'fju-avatars-'))

  const insertUser = async (email: string, withProfile = true) => {
    const r = await db.sql(
      `insert into users (id, name, email, email_verified, updated_at, status)
       values (gen_random_uuid(), $1, $1, false, now(), 'active') returning id`,
      [email],
    )
    const id = String(r.rows[0]!.id)
    if (withProfile) {
      await db.sql(
        `insert into user_profiles (user_id, display_name, name_normalized, contact_email) values ($1, $2, $2, $2)`,
        [id, email],
      )
    }
    return id
  }
  adminId = await insertUser('admin@example.com')
  teacherId = await insertUser('teacher@example.com')
  studentId = await insertUser('student@example.com')
  otherId = await insertUser('other@example.com')
  noProfileId = await insertUser('no-profile@example.com', false)

  files = new FsFileStorage({
    root: () => root,
    environmentMaxBytes: () => 100 * 1024 * 1024,
    ticketSecret: () => SECRET,
    policies: { avatar: (a) => a.kind === 'authenticated' && a.status === 'active' },
    db: () => app,
    transforms: { avatar: avatarImageTransform },
  })
  command = new PgAvatarCommand({ db: () => app, audit: new PgAuditWriter(), files })
})

afterAll(async () => {
  await app?.end()
  await db?.close()
  if (root) await fs.rm(root, { recursive: true, force: true })
})

describe('上傳並換上去（AC-SH-44）', () => {
  it('EXIF JPEG → 存成 256×256 WebP（轉正、無 EXIF／ICC）；avatar_file_id 指向它、有頭像引用、稽核 account.avatar_update', async () => {
    const fileId = await uploadFixture()
    const row = await one<Record<string, unknown>>('select * from stored_files where id = $1', [fileId])
    expect(row).toMatchObject({ purpose: 'avatar', status: 'stored', scope: 'global', owner_user_id: studentId, mime_detected: 'image/webp' })
    const stored = await fs.readFile(path.join(root, String(row.storage_key)))
    expect(Number(row.size_bytes)).toBe(stored.length)
    expect(row.checksum).toBe(createHash('sha256').update(stored).digest('hex'))
    expect(stored.length).toBeLessThanOrEqual(40 * 1024)
    const meta = await sharp(stored).metadata()
    expect(meta).toMatchObject({ format: 'webp', width: 256, height: 256 })
    expect(meta.exif).toBeUndefined()
    expect(meta.icc).toBeUndefined()
    expect(meta.orientation).toBeUndefined()

    expect(await command.updateAvatar(student(), { fileId })).toMatchObject({ ok: true })
    expect((await profile(studentId)).avatar_file_id).toBe(fileId)
    expect(
      await one('select count(*)::int as n from file_references where file_id = $1 and ref_type = $2 and ref_id = $3 and released_at is null', [
        fileId,
        'avatar',
        studentId,
      ]),
    ).toEqual({ n: 1 })
    const audits = await auditRows('account.avatar_update', studentId)
    expect(audits.at(-1)).toMatchObject({ actor_user_id: studentId, payload: { to: { avatarFileId: fileId } } })
  })

  it('換第二張：舊檔同一交易標刪、引用釋放、舊網址 FILE_GONE；新檔任何登入者拿得到、訪客 401（AC-SH-46、Q109）', async () => {
    const first = await uploadFixture()
    expect((await command.updateAvatar(student(), { fileId: first })).ok).toBe(true)
    const second = await uploadFixture()
    expect((await command.updateAvatar(student(), { fileId: second })).ok).toBe(true)

    expect(await one('select status, soft_deleted_at is not null as deleted from stored_files where id = $1', [first])).toEqual({
      status: 'soft_deleted',
      deleted: true,
    })
    expect(await one('select count(*)::int as n from file_references where file_id = $1 and released_at is null', [first])).toEqual({ n: 0 })
    expect((await profile(studentId)).avatar_file_id).toBe(second)

    for (const who of [student(), actor(otherId, ['student']), actor(teacherId, ['teacher']), admin()]) {
      expect(await files.authorizeDownload(who, first)).toMatchObject({ ok: false, code: 'FILE_GONE' })
      const got = await files.authorizeDownload(who, second)
      expect(got).toMatchObject({ ok: true, receipt: { purpose: 'avatar', mime: 'image/webp', publicRead: false } })
      if (got.ok) await got.receipt.body.cancel()
    }
    expect(await files.authorizeDownload(ANONYMOUS, second)).toMatchObject({ ok: false, code: 'UNAUTHENTICATED' })
    expect(await files.authorizeDownload(ANONYMOUS, first)).toMatchObject({ ok: false, code: 'UNAUTHENTICATED' })
  })

  it('同一張重送：成功但不重複寫稽核', async () => {
    const fileId = await uploadFixture()
    expect((await command.updateAvatar(student(), { fileId })).ok).toBe(true)
    const before = (await auditRows('account.avatar_update', studentId)).length
    expect((await command.updateAvatar(student(), { fileId })).ok).toBe(true)
    expect((await auditRows('account.avatar_update', studentId)).length).toBe(before)
  })

  it('換成預設圖：preset 寫進去、上傳檔清掉並標刪', async () => {
    const fileId = await uploadFixture()
    expect((await command.updateAvatar(student(), { fileId })).ok).toBe(true)
    expect((await command.updateAvatar(student(), { preset: 7 })).ok).toBe(true)
    expect(await profile(studentId)).toEqual({ avatar_preset: 7, avatar_file_id: null })
    expect(await one('select status from stored_files where id = $1', [fileId])).toEqual({ status: 'soft_deleted' })
  })
})

describe('上傳的拒絕路徑（AC-SH-45、AC-SH-84）', () => {
  it('2.1 MB：發票時就擋（FILE_TOO_LARGE，訊息寫 2 MB）', async () => {
    const result = await command.avatarUploadTicket(student(), { fileName: 'big.png', declaredMime: 'image/png', declaredSize: 2.1 * 1024 * 1024 })
    expect(result).toMatchObject({ ok: false, code: 'FILE_TOO_LARGE' })
    expect(!result.ok && result.message).toContain('2 MB')
  })

  it('實際送超過 2 MiB（宣告說謊）也擋', async () => {
    const ticket = await command.avatarUploadTicket(student(), { fileName: 'liar.png', declaredMime: 'image/png', declaredSize: 100 })
    if (!ticket.ok) throw new Error(ticket.message)
    const big = new Uint8Array(2 * 1024 * 1024 + 1)
    big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(await files.upload(studentId, ticket.receipt.ticket, streamOf(big), big.length)).toMatchObject({ ok: false, code: 'FILE_TOO_LARGE' })
  })

  it('PDF：副檔名 .pdf 發票就擋；改名成 .png 看檔頭擋（FILE_TYPE_REJECTED）', async () => {
    expect(await command.avatarUploadTicket(student(), { fileName: 'cv.pdf', declaredMime: 'application/pdf', declaredSize: 10 })).toMatchObject({
      ok: false,
      code: 'FILE_TYPE_REJECTED',
    })
    const pdf = Buffer.from('%PDF-1.4\n% not an image\n')
    const renamed = await upload(student(), pdf, 'cv.png', 'image/png')
    expect(renamed.uploaded).toMatchObject({ ok: false, code: 'FILE_TYPE_REJECTED' })
  })

  it('WebP 收（同樣縮成 256×256）', async () => {
    const webp = await sharp({ create: { width: 500, height: 300, channels: 3, background: '#22aa66' } }).webp().toBuffer()
    const { uploaded, fileId } = await upload(student(), webp, 'me.webp', 'image/webp')
    expect(uploaded).toMatchObject({ ok: true, receipt: { mimeDetected: 'image/webp' } })
    const row = await one<{ storage_key: string }>('select storage_key from stored_files where id = $1', [fileId])
    expect(await sharp(await fs.readFile(path.join(root, row.storage_key))).metadata()).toMatchObject({ width: 256, height: 256 })
  })

  it('檔頭偽造成 PNG、後面亂碼：sharp 解不開 → FILE_TYPE_REJECTED；列維持 uploading、下載 403、頭像不變', async () => {
    const keep = await uploadFixture()
    expect((await command.updateAvatar(student(), { fileId: keep })).ok).toBe(true)

    const fake = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(4096)])
    const { uploaded, fileId } = await upload(student(), fake, 'fake.png', 'image/png')
    expect(uploaded).toMatchObject({ ok: false, code: 'FILE_TYPE_REJECTED' })
    expect(await one('select status from stored_files where id = $1', [fileId])).toEqual({ status: 'uploading' })
    expect(await files.authorizeDownload(student(), fileId!)).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    // 拿這個沒成功的檔去換：檔案還沒 stored，換不了。
    expect(await command.updateAvatar(student(), { fileId: fileId! })).toMatchObject({ ok: false, code: 'FILE_NOT_READY' })
    expect((await profile(studentId)).avatar_file_id).toBe(keep)
  })
})

describe('換頭像的檢查', () => {
  it('別人的檔、非頭像用途的檔：FILE_NOT_OWNED；頭像不變', async () => {
    const mine = await uploadFixture()
    expect((await command.updateAvatar(student(), { fileId: mine })).ok).toBe(true)
    const theirs = await uploadFixture(actor(otherId, ['student']))
    expect(await command.updateAvatar(student(), { fileId: theirs })).toMatchObject({ ok: false, code: 'FILE_NOT_OWNED' })

    const other = await files.issueUploadTicket(
      studentId,
      { fileName: 'a.png', declaredMime: 'image/png' },
      { purpose: 'submission', allowedTypes: ['png'], maxBytes: 1024, scope: { kind: 'global' } },
    )
    if (!other.ok) throw new Error(other.message)
    expect(await command.updateAvatar(student(), { fileId: other.receipt.fileId })).toMatchObject({ ok: false, code: 'FILE_NOT_OWNED' })
    expect(await command.updateAvatar(student(), { fileId: 'not-a-uuid' })).toMatchObject({ ok: false, code: 'FILE_NOT_OWNED' })
    expect((await profile(studentId)).avatar_file_id).toBe(mine)
    expect(await one('select status from stored_files where id = $1', [mine])).toEqual({ status: 'stored' })
  })

  it('預設圖編號 0、101、小數、兩個都給：VALIDATION_FAILED', async () => {
    for (const input of [{ preset: 0 }, { preset: 101 }, { preset: 2.5 }, { preset: 3, fileId: 'x' }]) {
      expect(await command.updateAvatar(student(), input as never)).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    }
  })

  it('訪客、待審：不能換也不能取票；沒有個人資料的帳號：CONFLICT', async () => {
    expect(await command.updateAvatar(ANONYMOUS, { preset: 3 })).toMatchObject({ ok: false, code: 'UNAUTHENTICATED' })
    expect(await command.avatarUploadTicket(ANONYMOUS, { fileName: 'a.png', declaredMime: 'image/png' })).toMatchObject({
      ok: false,
      code: 'UNAUTHENTICATED',
    })
    const pending = actor(studentId, ['student'], 'pending')
    expect(await command.updateAvatar(pending, { preset: 3 })).toMatchObject({ ok: false, code: 'ACCOUNT_PENDING' })
    expect(await command.updateAvatar(actor(noProfileId, ['admin']), { preset: 3 })).toMatchObject({ ok: false, code: 'CONFLICT' })
  })
})

describe('系辦重設（AC-SH-47）', () => {
  it('兩欄清成 null、上傳檔標刪、稽核 account.avatar_reset 帶操作者與理由；舊網址 FILE_GONE', async () => {
    const fileId = await uploadFixture()
    expect((await command.updateAvatar(student(), { preset: 7 })).ok).toBe(true)
    expect((await command.updateAvatar(student(), { fileId })).ok).toBe(true)
    expect(await profile(studentId)).toEqual({ avatar_preset: 7, avatar_file_id: fileId })

    expect(await command.resetAvatar(admin(), studentId, '  不當圖片  ')).toMatchObject({ ok: true })
    expect(await profile(studentId)).toEqual({ avatar_preset: null, avatar_file_id: null })
    expect(await one('select status from stored_files where id = $1', [fileId])).toEqual({ status: 'soft_deleted' })
    expect(await files.authorizeDownload(student(), fileId)).toMatchObject({ ok: false, code: 'FILE_GONE' })
    expect((await auditRows('account.avatar_reset', studentId)).at(-1)).toMatchObject({
      actor_user_id: adminId,
      role: 'admin',
      reason: '不當圖片',
      payload: { reason: '不當圖片', avatarPreset: 7, avatarFileId: fileId },
    })
  })

  it('學生、老師呼叫 → FORBIDDEN；理由空白或超過 200 字 → VALIDATION_FAILED；什麼都沒改', async () => {
    expect((await command.updateAvatar(actor(otherId, ['student']), { preset: 9 })).ok).toBe(true)
    const before = (await auditRows('account.avatar_reset', otherId)).length
    expect(await command.resetAvatar(student(), otherId, '不當圖片')).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await command.resetAvatar(actor(teacherId, ['teacher']), otherId, '不當圖片')).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await command.resetAvatar(admin(), otherId, '   ')).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(await command.resetAvatar(admin(), otherId, '字'.repeat(201))).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(await command.resetAvatar(admin(), 'not-a-user', '不當圖片')).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(await profile(otherId)).toEqual({ avatar_preset: 9, avatar_file_id: null })
    expect((await auditRows('account.avatar_reset', otherId)).length).toBe(before)
    expect(await command.resetAvatar(admin(), otherId, '字'.repeat(200))).toMatchObject({ ok: true })
  })
})
