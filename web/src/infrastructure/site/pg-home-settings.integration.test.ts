import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { assertTestDatabaseReachable, createIsolatedDatabase, poolAsRole, type IsolatedDatabase } from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'
import type { ResolvedActor } from '@/application/accounts'
import { PUBLIC_READ_PURPOSES } from '@/composition/download-policy'
import { HOME_STALE_MESSAGE, resolveHome } from '@/application/site'
import { PgAuditWriter } from '@/infrastructure/ops/audit-writer'
import { FsFileStorage } from '@/infrastructure/ops/file-storage'
import { PgOperationLedger } from '@/infrastructure/ops/operation-ledger'
import { createPosterPolicy } from '@/infrastructure/showcase/poster-policy'
import { createHeroPhotoPolicy } from '@/infrastructure/site/hero-photo-policy'
import { PgHomeSettingsCommand, PgHomeSettingsQuery } from '@/infrastructure/site/pg-home-settings'

/**
 * 第三波 W3：首頁設定（設計方案 §3；AC-16～AC-19 的資料層）。
 *
 * 全部以正式執行角色 `fju_app` 連線（W0 的權限矩陣漏給 `home_settings` 的話這裡直接紅）。
 * 驗：第一次存新增設定列、之後更新；版本過期 `CONFLICT`（另一個分頁）；同請求編號重送回原回執；
 * 恢復預設清成 null 不刪列；稽核 `home.updated`；非管理員 `FORBIDDEN`；
 * 首頁大圖（`photo`）只有目前指到的那一張對訪客公開，換圖、恢復預設後舊圖「無法存取」（管理員也一樣）；
 * 別人上傳的、不是首頁大圖用途的檔不能拿來當首頁大圖。
 */

let owner: IsolatedDatabase
let app: Pool
let root: string
let storage: FsFileStorage
let command: PgHomeSettingsCommand
let query: PgHomeSettingsQuery
let a1: string
let a2: string
let student: string
const businessClock = { now: async () => new Date('2026-10-12T02:00:00Z') }
const anonymous: ResolvedActor = { kind: 'anonymous' }

function actor(userId: string, roles: ('admin' | 'teacher' | 'student')[]): ResolvedActor {
  return { kind: 'authenticated', userId, roles, status: 'active', mustChangePassword: false, cohortMemberships: [] }
}

let seq = 0
async function newUser(name: string, role: 'admin' | 'teacher' | 'student'): Promise<string> {
  seq += 1
  const row = await owner.sql(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), $1, $2, true, now(), 'active') returning id`,
    [name, `home${seq}-${randomUUID().slice(0, 8)}@example.com`],
  )
  const id = String(row.rows[0]!.id)
  await owner.sql(
    `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at) values (gen_random_uuid(), $1, $2, $1, now())`,
    [id, role],
  )
  return id
}

const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1])
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
const PDF = new TextEncoder().encode('%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n')

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

async function uploadHero(adminId: string, name: string, bytes: Uint8Array, mime: string): Promise<string> {
  const ticket = await command.requestHeroUpload(actor(adminId, ['admin']), { fileName: name, declaredMime: mime, declaredSize: bytes.length })
  if (!ticket.ok) throw new Error(`${ticket.code} ${ticket.message}`)
  const stored = await storage.upload(adminId, ticket.receipt.ticket, streamOf(bytes), bytes.length)
  if (!stored.ok) throw new Error(`${stored.code} ${stored.message}`)
  return stored.receipt.fileId
}

async function download(who: ResolvedActor, fileId: string) {
  const result = await storage.authorizeDownload(who, fileId)
  if (result.ok) await result.receipt.body.cancel()
  return result.ok ? 'ok' : result.code
}

async function currentRevision(): Promise<number> {
  return (await query.current())?.revision ?? 0
}

async function mustSave(input: { heroFileId?: string | null; heroAlt?: string; line1?: string; line2?: string }, adminId = a1) {
  const saved = await command.save(
    actor(adminId, ['admin']),
    { heroFileId: input.heroFileId ?? null, heroAlt: input.heroAlt ?? '', line1: input.line1 ?? '', line2: input.line2 ?? '', revision: await currentRevision() },
    randomUUID(),
  )
  if (!saved.ok) throw new Error(`${saved.code} ${saved.message}`)
  return saved.receipt
}

beforeAll(async () => {
  await assertTestDatabaseReachable()
  owner = await createIsolatedDatabase({ label: 'home_settings', setup: migratedSchema })
  app = await poolAsRole(owner, 'fju_app')
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'fju-home-files-'))
  a1 = await newUser('系辦一', 'admin')
  a2 = await newUser('系辦二', 'admin')
  student = await newUser('學生', 'student')
  storage = new FsFileStorage({
    root: () => root,
    environmentMaxBytes: () => 100 * 1024 * 1024,
    ticketSecret: () => 'home-secret-home-secret-home-secret-home',
    policies: { photo: createHeroPhotoPolicy(() => app), poster: createPosterPolicy(() => app) },
    // 同正式組裝（`composition/ops.ts`）：讀同一份公開讀取例外清單。
    publicReadPurposes: PUBLIC_READ_PURPOSES,
    db: () => app,
  })
  command = new PgHomeSettingsCommand({
    audit: new PgAuditWriter(),
    ledger: new PgOperationLedger(() => app),
    files: storage,
    businessClock,
    pool: () => app,
  })
  query = new PgHomeSettingsQuery({ reader: () => app })
})

// 單列設定：每個案例從「還沒存過」開始（owner 才刪得掉；app 角色沒有 delete）。
beforeEach(async () => {
  await owner.sql('delete from home_settings')
})

afterAll(async () => {
  await app?.end()
  await owner?.close()
  await fs.rm(root, { recursive: true, force: true })
})

describe('存檔', () => {
  it('還沒存過時首頁用預設；第一次存新增設定列（版本 1），之後更新（版本 2）；記稽核 home.updated', async () => {
    expect(await query.current()).toBeNull()
    expect(resolveHome(await query.current()).line1).toBe('輔仁大學資訊管理學系專題管理平台')

    const first = await mustSave({ line1: '新標語', line2: '第二行' })
    expect(first).toMatchObject({ revision: 1, reset: false, heroChanged: false })
    const second = await mustSave({ line1: '再改一次', line2: '第二行' })
    expect(second.revision).toBe(2)

    const now = await query.current()
    expect(now).toMatchObject({ heroFileId: null, heroAlt: null, line1: '再改一次', line2: '第二行', revision: 2, updatedByName: '系辦一' })
    expect(resolveHome(now)).toMatchObject({ line1: '再改一次', line2: '第二行', heroSrc: '/placeholder/campus.jpg' })

    const audit = await owner.sql(
      `select action, target_type, scope, actor_user_id, payload from audit_events where action = 'home.updated' order by real_at, id`,
    )
    expect(audit.rows).toHaveLength(2)
    expect(audit.rows[1]).toMatchObject({
      target_type: 'home_settings',
      scope: 'global',
      actor_user_id: a1,
      payload: { revision: 2, reset: false, line1: '再改一次', line2: '第二行' },
    })
  })

  it('另一個分頁先存過：帶舊版本存檔被擋「這份設定剛被改過」，內容不變', async () => {
    await mustSave({ line1: '分頁一' })
    const stale = await command.save(
      actor(a2, ['admin']),
      { heroFileId: null, heroAlt: '', line1: '分頁二', line2: '', revision: 0 },
      randomUUID(),
    )
    expect(stale).toMatchObject({ ok: false, code: 'CONFLICT', message: HOME_STALE_MESSAGE })
    expect((await query.current())?.line1).toBe('分頁一')

    const staleReset = await command.reset(actor(a2, ['admin']), { revision: 0 }, randomUUID())
    expect(staleReset).toMatchObject({ ok: false, code: 'CONFLICT' })
  })

  it('兩個分頁同時第一次存：只有一個成功，另一個 CONFLICT', async () => {
    const both = await Promise.all(
      ['甲', '乙'].map((line1) =>
        command.save(actor(a1, ['admin']), { heroFileId: null, heroAlt: '', line1, line2: '', revision: 0 }, randomUUID()),
      ),
    )
    expect(both.filter((r) => r.ok)).toHaveLength(1)
    expect(both.filter((r) => !r.ok)).toEqual([expect.objectContaining({ code: 'CONFLICT', message: HOME_STALE_MESSAGE })])
    expect((await query.current())?.revision).toBe(1)
  })

  it('同一個請求編號重送：回第一次的回執，不再改一次', async () => {
    const requestId = randomUUID()
    const input = { heroFileId: null, heroAlt: '', line1: '只改一次', line2: '', revision: 0 }
    const first = await command.save(actor(a1, ['admin']), input, requestId)
    const again = await command.save(actor(a1, ['admin']), input, requestId)
    expect(first.ok && again.ok).toBe(true)
    if (!first.ok || !again.ok) return
    expect(again.receipt.revision).toBe(first.receipt.revision)
    expect((await query.current())?.revision).toBe(1)
  })

  it('字數超過上限、有圖沒寫圖片說明：VALIDATION_FAILED 並指出欄位', async () => {
    const tooLong = await command.save(actor(a1, ['admin']), { heroFileId: null, heroAlt: '', line1: '字'.repeat(41), line2: '', revision: 0 }, randomUUID())
    expect(tooLong).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', details: { field: 'line1' } })
    const hero = await uploadHero(a1, 'campus.jpg', JPG, 'image/jpeg')
    const noAlt = await command.save(actor(a1, ['admin']), { heroFileId: hero, heroAlt: ' ', line1: '', line2: '', revision: 0 }, randomUUID())
    expect(noAlt).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', details: { field: 'heroAlt' } })
    expect(await query.current()).toBeNull()
  })

  it('非管理員不能存、不能恢復預設、不能要上傳憑證', async () => {
    const who = actor(student, ['student'])
    expect(await command.save(who, { heroFileId: null, heroAlt: '', line1: 'x', line2: '', revision: 0 }, randomUUID())).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await command.reset(who, { revision: 0 }, randomUUID())).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await command.requestHeroUpload(who, { fileName: 'a.jpg', declaredMime: 'image/jpeg', declaredSize: 10 })).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await command.save(anonymous, { heroFileId: null, heroAlt: '', line1: 'x', line2: '', revision: 0 }, randomUUID())).toMatchObject({ ok: false })
  })
})

describe('首頁大圖', () => {
  it('上傳只收 PNG／JPG、5 MiB 以內；檔案是 global 的首頁大圖用途', async () => {
    const pdf = await command.requestHeroUpload(actor(a1, ['admin']), { fileName: 'a.pdf', declaredMime: 'application/pdf', declaredSize: PDF.length })
    expect(pdf.ok).toBe(false)
    const big = await command.requestHeroUpload(actor(a1, ['admin']), { fileName: 'a.jpg', declaredMime: 'image/jpeg', declaredSize: 5 * 1024 * 1024 + 1 })
    expect(big.ok).toBe(false)
    const fileId = await uploadHero(a1, 'campus.png', PNG, 'image/png')
    const row = await owner.sql('select purpose, scope, cohort_id, status from stored_files where id = $1', [fileId])
    expect(row.rows[0]).toEqual({ purpose: 'photo', scope: 'global', cohort_id: null, status: 'stored' })
  })

  it('存檔後只有目前那一張對訪客公開；換成圖 B 後圖 A 回「無法存取」；剛上傳還沒存的也拿不到（AC-18）', async () => {
    const a = await uploadHero(a1, 'a.jpg', JPG, 'image/jpeg')
    // 還沒存：誰都拿不到（設定頁用瀏覽器本地預覽）。
    expect(await download(anonymous, a)).toBe('UNAUTHENTICATED')
    expect(await download(actor(a1, ['admin']), a)).toBe('FORBIDDEN')

    const saved = await mustSave({ heroFileId: a, heroAlt: '利瑪竇大樓外觀' })
    expect(saved.heroChanged).toBe(true)
    expect(resolveHome(await query.current())).toMatchObject({ heroSrc: `/api/files/${a}`, heroAlt: '利瑪竇大樓外觀' })
    expect(await download(anonymous, a)).toBe('ok')
    expect(await download(actor(student, ['student']), a)).toBe('ok')

    const b = await uploadHero(a1, 'b.png', PNG, 'image/png')
    await mustSave({ heroFileId: b, heroAlt: '圖 B' })
    expect(await download(anonymous, b)).toBe('ok')
    expect(await download(anonymous, a)).toBe('UNAUTHENTICATED')
    expect(await download(actor(student, ['student']), a)).toBe('FORBIDDEN')
    expect(await download(actor(a1, ['admin']), a)).toBe('FORBIDDEN')

    const audit = await owner.sql(`select payload from audit_events where action = 'home.updated' order by real_at desc, id desc limit 1`)
    expect(audit.rows[0]!.payload).toMatchObject({ heroFileId: b, previousHeroFileId: a })
  })

  it('待審、必須改密的帳號開首頁也看得到目前的大圖（比照訪客）；舊圖、還沒存的圖照舊無法存取', async () => {
    const pendingUser: ResolvedActor = { kind: 'authenticated', userId: student, roles: ['student'], status: 'pending', mustChangePassword: false, cohortMemberships: [] }
    const mustChange: ResolvedActor = { kind: 'authenticated', userId: student, roles: ['student'], status: 'active', mustChangePassword: true, cohortMemberships: [] }
    const a = await uploadHero(a1, 'a.jpg', JPG, 'image/jpeg')
    await mustSave({ heroFileId: a, heroAlt: '圖 A' })
    const b = await uploadHero(a1, 'b.png', PNG, 'image/png')
    for (const who of [pendingUser, mustChange]) {
      expect(await download(who, a)).toBe('ok')
      expect(await download(who, b)).toBe('FORBIDDEN')
    }
    await mustSave({ heroFileId: b, heroAlt: '圖 B' })
    for (const who of [pendingUser, mustChange]) {
      expect(await download(who, b)).toBe('ok')
      expect(await download(who, a)).toBe('FORBIDDEN')
    }
  })

  it('恢復預設：四欄清成 null、列還在、版本往上加；原本那張圖不再公開；首頁回預設', async () => {
    const a = await uploadHero(a1, 'a.jpg', JPG, 'image/jpeg')
    await mustSave({ heroFileId: a, heroAlt: '說明', line1: '自訂', line2: '自訂二' })
    const reset = await command.reset(actor(a1, ['admin']), { revision: await currentRevision() }, randomUUID())
    expect(reset).toMatchObject({ ok: true, receipt: { revision: 2, reset: true, heroChanged: true } })
    const now = await query.current()
    expect(now).toMatchObject({ heroFileId: null, heroAlt: null, line1: null, line2: null, revision: 2 })
    expect(resolveHome(now)).toEqual(resolveHome(null))
    expect(await download(anonymous, a)).toBe('UNAUTHENTICATED')
    const audit = await owner.sql(`select payload from audit_events where action = 'home.updated' order by real_at desc, id desc limit 1`)
    expect(audit.rows[0]!.payload).toMatchObject({ reset: true, previousHeroFileId: a })
  })

  it('不能拿別人上傳的圖、或不是首頁大圖用途的檔來當首頁大圖', async () => {
    const others = await uploadHero(a2, 'other.jpg', JPG, 'image/jpeg')
    const notMine = await command.save(actor(a1, ['admin']), { heroFileId: others, heroAlt: 'x', line1: '', line2: '', revision: 0 }, randomUUID())
    expect(notMine).toMatchObject({ ok: false, code: 'FILE_NOT_OWNED', details: { field: 'hero' } })

    // 公告附件之類的別種用途：直接建一筆 stored 的 poster 檔。
    const poster = await owner.sql(
      `insert into stored_files (id, owner_user_id, scope, purpose, original_name, mime_declared, extension, status, storage_key,
                                 uploaded_real_at, updated_by_user_id, size_bytes, checksum, mime_detected)
       values (gen_random_uuid(), $1, 'global', 'poster', 'p.png', 'image/png', 'png', 'stored', 'x/p', now(), $1, 16, 'abc', 'image/png')
       returning id`,
      [a1],
    )
    const wrongPurpose = await command.save(
      actor(a1, ['admin']),
      { heroFileId: String(poster.rows[0]!.id), heroAlt: 'x', line1: '', line2: '', revision: 0 },
      randomUUID(),
    )
    expect(wrongPurpose).toMatchObject({ ok: false, code: 'FILE_NOT_OWNED' })
    expect(await query.current()).toBeNull()
  })

  it('沿用目前的圖、只改標語：不用重新驗檔（另一位管理員也能改字）', async () => {
    const a = await uploadHero(a1, 'a.jpg', JPG, 'image/jpeg')
    await mustSave({ heroFileId: a, heroAlt: '說明' })
    const byOther = await mustSave({ heroFileId: a, heroAlt: '說明', line1: '系辦二改的' }, a2)
    expect(byOther.heroChanged).toBe(false)
    expect(await download(anonymous, a)).toBe('ok')
  })
})
