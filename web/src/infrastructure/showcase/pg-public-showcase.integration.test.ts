import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { assertTestDatabaseReachable, createIsolatedDatabase, poolAsRole, type IsolatedDatabase } from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'
import type { ResolvedActor } from '@/application/accounts'
import { PgAuditWriter } from '@/infrastructure/ops/audit-writer'
import { FsFileStorage } from '@/infrastructure/ops/file-storage'
import { PgOperationLedger } from '@/infrastructure/ops/operation-ledger'
import { PgPublicShowcaseQuery } from '@/infrastructure/showcase/pg-public-showcase'
import { PgShowcaseCommand } from '@/infrastructure/showcase/pg-showcase'
import { createPosterPolicy } from '@/infrastructure/showcase/poster-policy'

/**
 * 前台補頁：優秀專題（公開）、歷屆一覽（登入後）、專題詳情的查詢，以及已發布海報的下載政策。
 *
 * 全部以正式執行角色 `fju_app` 讀（GRANT 少了 SELECT 這裡直接紅）。「發布」目前只有示範資料會做（S12 才有用例），
 * 所以這裡以 owner 直接照 spec 的形狀寫：從草稿凍結一列 `showcase_versions`，條目改成發布中並指向它。
 *
 * 驗：未發布（草稿）與撤稿的不外洩；訪客只拿到白名單欄位、拿不到組員與老師、也不能用老師名字搜；
 * 發布後再改草稿，前台仍是發布那一版；歷屆一覽要能正常使用平台的登入者；海報只有「發布中目前版本」那張公開。
 */

let owner: IsolatedDatabase
let app: Pool
let root: string
let storage: FsFileStorage
let command: PgShowcaseCommand
let query: PgPublicShowcaseQuery
let admin: string
const businessClock = { now: async () => new Date('2026-12-01T02:00:00Z') }
const ANON: ResolvedActor = { kind: 'anonymous' }

function actor(userId: string, roles: ('admin' | 'teacher' | 'student')[], status: 'active' | 'pending' = 'active'): ResolvedActor {
  return { kind: 'authenticated', userId, roles, status, mustChangePassword: false, cohortMemberships: [] }
}

let seq = 0
async function newUser(name: string, role: 'admin' | 'teacher' | 'student'): Promise<string> {
  seq += 1
  const row = await owner.sql(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), $1, $2, true, now(), 'active') returning id`,
    [name, `pub${seq}-${randomUUID().slice(0, 8)}@example.com`],
  )
  const id = String(row.rows[0]!.id)
  await owner.sql(
    `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at) values (gen_random_uuid(), $1, $2, $1, now())`,
    [id, role],
  )
  return id
}

async function newCohort(code: string): Promise<string> {
  const row = await owner.sql(
    `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
     values (gen_random_uuid(), $1, $1, 'active', '2027-06-30', 'system') returning id`,
    [code],
  )
  return String(row.rows[0]!.id)
}

async function newGroup(cohortId: string, code: string, memberNames: string[], advisorName: string) {
  const group = await owner.sql(
    `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
     values (gen_random_uuid(), $1, $2, 'general', now(), now(), 'system') returning id`,
    [cohortId, code],
  )
  const groupId = String(group.rows[0]!.id)
  const members: string[] = []
  for (const name of memberNames) {
    const id = await newUser(name, 'student')
    members.push(id)
    await owner.sql(
      `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind) values (gen_random_uuid(), $1, $2, $3, now(), 'system')`,
      [groupId, cohortId, id],
    )
  }
  const teacher = await newUser(advisorName, 'teacher')
  await owner.sql(
    `insert into advisor_assignments (id, group_id, teacher_user_id, source, valid_from, assigned_by_user_id, reason)
     values (gen_random_uuid(), $1, $2, 'admin', now(), $3, '指派')`,
    [groupId, teacher, admin],
  )
  return { groupId, members, teacher }
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
const PNG2 = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x53])

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

async function uploadPoster(entryId: string, bytes: Uint8Array): Promise<string> {
  const ticket = await command.requestPosterUpload(actor(admin, ['admin']), {
    entryId,
    fileName: 'poster.png',
    declaredMime: 'image/png',
    declaredSize: bytes.length,
  })
  if (!ticket.ok) throw new Error(ticket.message)
  const stored = await storage.upload(admin, ticket.receipt.ticket, streamOf(bytes), bytes.length)
  if (!stored.ok) throw new Error(stored.message)
  return stored.receipt.fileId
}

/** 管理員建草稿並存內容（走正式用例）。 */
async function draft(groupId: string, fields: { title: string; summary: string; poster?: Uint8Array }) {
  const created = await command.createDraft(actor(admin, ['admin']), { groupId }, randomUUID())
  if (!created.ok) throw new Error(created.message)
  const entryId = created.receipt.entryId
  const posterFileId = fields.poster ? await uploadPoster(entryId, fields.poster) : null
  const saved = await command.updateDraft(
    actor(admin, ['admin']),
    { entryId, revision: 1, title: fields.title, summary: fields.summary, videoUrl: 'https://youtu.be/demo', posterFileId },
    randomUUID(),
  )
  if (!saved.ok) throw new Error(saved.message)
  return { entryId, posterFileId }
}

/** 照 spec 的形狀「發布」：從草稿凍結一版，條目指向它（S12 的發布用例還沒有）。 */
async function publish(entryId: string) {
  const version = await owner.sql(
    `insert into showcase_versions (id, entry_id, version_no, title, summary, summary_checksum, video_url,
                                    poster_file_id, poster_checksum, authorization_kind, authorization_ref, pii_check,
                                    created_by_user_id, created_real_at)
     select gen_random_uuid(), d.entry_id,
            (select coalesce(max(version_no), 0) + 1 from showcase_versions where entry_id = d.entry_id),
            d.title, d.summary, d.summary_checksum, d.video_url, d.poster_file_id, d.poster_checksum,
            'external', gen_random_uuid(), '{"passed": true}'::jsonb, $2, now()
       from showcase_drafts d where d.entry_id = $1
     returning id`,
    [entryId, admin],
  )
  await owner.sql(`update showcase_entries set status = 'published', current_version_id = $2 where id = $1`, [
    entryId,
    version.rows[0]!.id,
  ])
}

async function download(who: ResolvedActor, fileId: string) {
  const result = await storage.authorizeDownload(who, fileId)
  if (result.ok) await result.receipt.body.cancel()
  return result.ok ? 'ok' : result.code
}

let s1: Awaited<ReturnType<typeof newGroup>>
let published: { entryId: string; posterFileId: string | null }
let other: { entryId: string; posterFileId: string | null }
let drafted: { entryId: string; posterFileId: string | null }
let withdrawn: { entryId: string; posterFileId: string | null }

beforeAll(async () => {
  await assertTestDatabaseReachable()
  owner = await createIsolatedDatabase({ label: 'public_showcase', setup: migratedSchema })
  app = await poolAsRole(owner, 'fju_app')
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'fju-public-showcase-'))
  admin = await newUser('系辦', 'admin')
  storage = new FsFileStorage({
    root: () => root,
    environmentMaxBytes: () => 100 * 1024 * 1024,
    ticketSecret: () => 'public-showcase-secret-public-showcase-secret',
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
  query = new PgPublicShowcaseQuery(() => app)

  const c114 = await newCohort('114')
  const c113 = await newCohort('113')
  const c112 = await newCohort('112')
  s1 = await newGroup(c114, 'G01', ['王小明', '李小華'], '陳指導')
  const s2 = await newGroup(c113, 'G03', ['張同學'], '林老師')
  const s3 = await newGroup(c114, 'G02', ['草稿組員'], '草稿老師')
  const s4 = await newGroup(c112, 'G05', ['撤稿組員'], '撤稿老師')

  published = await draft(s1.groupId, { title: '城市微光', summary: '公共資訊可讀性改善', poster: PNG })
  await publish(published.entryId)
  other = await draft(s2.groupId, { title: '安心路徑', summary: '校園友善空間指南' })
  await publish(other.entryId)
  drafted = await draft(s3.groupId, { title: '機密草稿題目', summary: '還沒發布的摘要', poster: PNG2 })
  withdrawn = await draft(s4.groupId, { title: '已撤稿作品', summary: '撤掉了' })
  await publish(withdrawn.entryId)
  await owner.sql(`update showcase_entries set status = 'withdrawn' where id = $1`, [withdrawn.entryId])
})

afterAll(async () => {
  await app?.end()
  await owner?.close()
  await fs.rm(root, { recursive: true, force: true })
})

describe('優秀專題（公開）', () => {
  it('訪客只看到發布中的；草稿與撤稿的一筆都不出現，回應裡也找不到它們的字', async () => {
    const cards = await query.featured()
    expect(cards.map((c) => c.title)).toEqual(['城市微光', '安心路徑'])
    const json = JSON.stringify(cards)
    expect(json).not.toMatch(/機密草稿題目|還沒發布的摘要|已撤稿作品/)
  })

  it('只有白名單欄位：沒有組員、老師、授權參照、個資檢查', async () => {
    const [card] = await query.featured({ cohort: '114' })
    expect(Object.keys(card!).sort()).toEqual(
      ['cohortCode', 'groupCode', 'id', 'posterFileId', 'publishedAt', 'summary', 'title', 'videoUrl'].sort(),
    )
    expect(card).toMatchObject({ cohortCode: '114', groupCode: 'G01', videoUrl: 'https://youtu.be/demo' })
    expect(card!.posterFileId).toBe(published.posterFileId)
    expect(JSON.stringify(card)).not.toMatch(/王小明|陳指導|external|passed/)
  })

  it('屆別篩選、關鍵字（題目、摘要、組別）、排序；訪客不能用指導老師名字搜', async () => {
    expect((await query.featured({ cohort: '113' })).map((c) => c.title)).toEqual(['安心路徑'])
    expect((await query.featured({ q: '可讀性' })).map((c) => c.title)).toEqual(['城市微光'])
    expect((await query.featured({ q: 'g03' })).map((c) => c.title)).toEqual(['安心路徑'])
    expect(await query.featured({ q: '陳指導' })).toEqual([])
    expect(await query.featured({ q: '100%_' })).toEqual([])
    expect((await query.featured({ sort: 'cohort-asc' })).map((c) => c.cohortCode)).toEqual(['113', '114'])
  })

  it('屆別 pill 只列有發布作品的屆（撤稿的 112 不算）', async () => {
    expect(await query.cohorts()).toEqual(['114', '113'])
  })

  it('發布後再改草稿：前台仍是發布那一版', async () => {
    const saved = await command.updateDraft(
      actor(admin, ['admin']),
      { entryId: published.entryId, revision: 2, title: '改過還沒發布的題目', summary: '新摘要', videoUrl: '', posterFileId: published.posterFileId },
      randomUUID(),
    )
    expect(saved.ok).toBe(true)
    const [card] = await query.featured({ cohort: '114' })
    expect(card).toMatchObject({ title: '城市微光', summary: '公共資訊可讀性改善' })
  })
})

describe('歷屆專題一覽（登入後）', () => {
  it('訪客、待審帳號 need_login，一筆都不回', async () => {
    expect(await query.archive(ANON)).toEqual({ access: 'need_login' })
    expect(await query.archive(actor(s1.members[0]!, ['student'], 'pending'))).toEqual({ access: 'need_login' })
  })

  it('登入者看到目前有效的組員與主指導；離組的人不再掛在作品上；可以用老師名字搜', async () => {
    const viewer = actor(await newUser('別組學生', 'student'), ['student'])
    const before = await query.archive(viewer)
    expect(before.access).toBe('visible')
    if (before.access !== 'visible') return
    const card = before.cards.find((c) => c.id === published.entryId)!
    expect(card).toMatchObject({ advisorName: '陳指導', memberNames: ['王小明', '李小華'] })
    expect(before.cards.map((c) => c.id)).not.toContain(drafted.entryId)

    await owner.sql(`update group_memberships set valid_to = now(), removal_reason = '換組' where user_id = $1`, [s1.members[1]])
    const after = await query.archive(viewer)
    if (after.access !== 'visible') throw new Error('should be visible')
    expect(after.cards.find((c) => c.id === published.entryId)!.memberNames).toEqual(['王小明'])

    const byTeacher = await query.archive(viewer, { q: '林老師' })
    expect(byTeacher.access === 'visible' && byTeacher.cards.map((c) => c.title)).toEqual(['安心路徑'])
  })
})

describe('專題詳情', () => {
  it('訪客看得到發布中的作品，但組員與老師是 null；前後件照列表順序', async () => {
    const page = await query.entry(ANON, published.entryId)
    expect(page.access).toBe('visible')
    if (page.access !== 'visible') return
    expect(page.people).toBeNull()
    expect(page.item.title).toBe('城市微光')
    expect(page.prev).toBeNull()
    expect(page.next).toEqual({ id: other.entryId, title: '安心路徑' })
    expect(JSON.stringify(page)).not.toMatch(/王小明|陳指導/)
  })

  it('登入者多看到組員與主指導；待審帳號仍當訪客', async () => {
    const member = await query.entry(actor(s1.teacher, ['teacher']), published.entryId)
    expect(member.access === 'visible' && member.people?.advisorName).toBe('陳指導')
    const pending = await query.entry(actor(s1.members[0]!, ['student'], 'pending'), published.entryId)
    expect(pending.access === 'visible' && pending.people).toBeNull()
  })

  it('草稿、不存在、亂寫的 ID 一律 not_found；撤稿的 withdrawn（不帶內容）', async () => {
    expect(await query.entry(ANON, drafted.entryId)).toEqual({ access: 'not_found' })
    expect(await query.entry(actor(admin, ['admin']), drafted.entryId)).toEqual({ access: 'not_found' })
    expect(await query.entry(ANON, randomUUID())).toEqual({ access: 'not_found' })
    expect(await query.entry(ANON, 'not-a-uuid')).toEqual({ access: 'not_found' })
    expect(await query.entry(ANON, withdrawn.entryId)).toEqual({ access: 'withdrawn' })
  })
})

describe('海報下載政策', () => {
  it('發布中目前版本的海報：訪客也能看；草稿上的海報：訪客 401、別組學生 403', async () => {
    expect(await download(ANON, published.posterFileId!)).toBe('ok')
    expect(await download(ANON, drafted.posterFileId!)).toBe('UNAUTHENTICATED')
    expect(await download(actor(await newUser('路人學生', 'student'), ['student']), drafted.posterFileId!)).toBe('FORBIDDEN')
  })

  it('撤稿之後同一張海報就不再公開', async () => {
    await owner.sql(`update showcase_entries set status = 'withdrawn' where id = $1`, [published.entryId])
    try {
      expect(await download(ANON, published.posterFileId!)).toBe('UNAUTHENTICATED')
    } finally {
      await owner.sql(`update showcase_entries set status = 'published' where id = $1`, [published.entryId])
    }
  })
})
