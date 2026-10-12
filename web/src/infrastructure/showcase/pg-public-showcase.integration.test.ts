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
 *
 * 票 39（0011）：優秀專題只有**有獎項等級**的。另放一件已發布、沒標等級的（`plain`，115 屆）：訪客的列表、詳情、
 * 上一件／下一件、屆別 pill、海報都碰不到它；登入者在歷屆一覽看得到。獎項由 `fju_app` 直接寫（驗 GRANT 補欄）。
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
const PNG3 = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x54])

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
let plain: { entryId: string; posterFileId: string | null }

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
  const c115 = await newCohort('115')
  s1 = await newGroup(c114, 'G01', ['王小明', '李小華'], '陳指導')
  const s2 = await newGroup(c113, 'G03', ['張同學'], '林老師')
  const s3 = await newGroup(c114, 'G02', ['草稿組員'], '草稿老師')
  const s4 = await newGroup(c112, 'G05', ['撤稿組員'], '撤稿老師')
  const s5 = await newGroup(c115, 'G04', ['一般組員'], '一般老師')

  published = await draft(s1.groupId, { title: '城市微光', summary: '公共資訊可讀性改善', poster: PNG })
  await publish(published.entryId)
  other = await draft(s2.groupId, { title: '安心路徑', summary: '校園友善空間指南' })
  await publish(other.entryId)
  drafted = await draft(s3.groupId, { title: '機密草稿題目', summary: '還沒發布的摘要', poster: PNG2 })
  withdrawn = await draft(s4.groupId, { title: '已撤稿作品', summary: '撤掉了' })
  await publish(withdrawn.entryId)
  await owner.sql(`update showcase_entries set status = 'withdrawn' where id = $1`, [withdrawn.entryId])
  plain = await draft(s5.groupId, { title: '菜市場帳本', summary: '沒得獎的一般作品', poster: PNG3 })
  await publish(plain.entryId)

  // 獎項等級（0011）：以執行角色 fju_app 寫，GRANT 少了補欄這裡直接紅。撤稿的也標，證明撤稿照樣不出現。
  const award = (entryId: string, level: string, label: string | null) =>
    app.query(`update showcase_entries set award_level = $2, award_label = $3 where id = $1`, [entryId, level, label])
  await award(published.entryId, 'excellent', '114 學年度校級優秀專題')
  await award(other.entryId, 'merit', null)
  await award(withdrawn.entryId, 'excellent', '112 學年度校級優秀專題')
})

afterAll(async () => {
  await app?.end()
  await owner?.close()
  await fs.rm(root, { recursive: true, force: true })
})

describe('優秀專題（公開）', () => {
  it('訪客只看到發布中、有獎項等級的；草稿、撤稿、沒標等級的一筆都不出現，回應裡也找不到它們的字', async () => {
    const cards = await query.featured()
    expect(cards.map((c) => c.title)).toEqual(['城市微光', '安心路徑'])
    const json = JSON.stringify(cards)
    expect(json).not.toMatch(/機密草稿題目|還沒發布的摘要|已撤稿作品|菜市場帳本|沒得獎的一般作品/)
    // 呼叫端就算沒傳 awardOnly、甚至想傳 false，優秀專題也只有得獎的。
    expect((await query.featured({ awardOnly: false })).map((c) => c.title)).toEqual(['城市微光', '安心路徑'])
    expect(await query.featured({ q: '菜市場' })).toEqual([])
  })

  it('獎項等級與全名在卡片上；排序：優秀專題優先、佳作優先', async () => {
    const cards = await query.featured()
    expect(cards.map((c) => [c.title, c.award, c.awardLabel])).toEqual([
      ['城市微光', 'excellent', '114 學年度校級優秀專題'],
      ['安心路徑', 'merit', null],
    ])
    expect((await query.featured({ sort: 'excellent' })).map((c) => c.award)).toEqual(['excellent', 'merit'])
    expect((await query.featured({ sort: 'merit' })).map((c) => c.award)).toEqual(['merit', 'excellent'])
  })

  it('DB 擋非法的獎項：不認得的等級、有全名卻沒等級', async () => {
    await expect(app.query(`update showcase_entries set award_level = 'gold' where id = $1`, [plain.entryId])).rejects.toThrow(
      /showcase_entries_award_level_check/,
    )
    await expect(app.query(`update showcase_entries set award_label = '佳作' where id = $1`, [plain.entryId])).rejects.toThrow(
      /showcase_entries_award_label_check/,
    )
  })

  it('只有白名單欄位：沒有組員、老師、授權參照、個資檢查', async () => {
    const [card] = await query.featured({ cohort: '114' })
    expect(Object.keys(card!).sort()).toEqual(
      ['award', 'awardLabel', 'cohortCode', 'groupCode', 'id', 'posterFileId', 'publishedAt', 'summary', 'title', 'videoUrl'].sort(),
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

  it('屆別 pill 只列有發布作品的屆（撤稿的 112 不算）；優秀專題頁只算有獎項等級的（只有沒得獎作品的 115 不算）', async () => {
    expect(await query.cohorts()).toEqual(['115', '114', '113'])
    expect(await query.cohorts({ featuredOnly: true })).toEqual(['114', '113'])
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

  it('歷屆一覽是全部已發布的（含沒得獎的）；只看得獎、得獎優先', async () => {
    const viewer = actor(await newUser('看一覽的學生', 'student'), ['student'])
    const all = await query.archive(viewer)
    expect(all.access === 'visible' && all.cards.map((c) => [c.title, c.award])).toEqual([
      ['菜市場帳本', null],
      ['城市微光', 'excellent'],
      ['安心路徑', 'merit'],
    ])
    const awarded = await query.archive(viewer, { awardOnly: true })
    expect(awarded.access === 'visible' && awarded.cards.map((c) => c.title)).toEqual(['城市微光', '安心路徑'])
    const ranked = await query.archive(viewer, { sort: 'award' })
    expect(ranked.access === 'visible' && ranked.cards.map((c) => c.title)).toEqual(['城市微光', '安心路徑', '菜市場帳本'])
  })

  it('屆別帶名稱（系1）：卡片與 pill 都拿得到「第 43 屆」這類名稱；公開卡仍不帶', async () => {
    await owner.sql(`update cohorts set name = '第 43 屆' where code = '115'`)
    try {
      const viewer = actor(await newUser('看屆別的學生', 'student'), ['student'])
      const all = await query.archive(viewer)
      expect(all.access === 'visible' && all.cards.map((c) => [c.cohortCode, c.cohortName])).toEqual([
        ['115', '第 43 屆'],
        ['114', '114'],
        ['113', '113'],
      ])
      expect(await query.cohortChoices()).toEqual([
        { code: '115', name: '第 43 屆' },
        { code: '114', name: '114' },
        { code: '113', name: '113' },
      ])
      expect(await query.cohortChoices({ featuredOnly: true })).toEqual([
        { code: '114', name: '114' },
        { code: '113', name: '113' },
      ])
      expect((await query.featured()).every((c) => !('cohortName' in c))).toBe(true)
    } finally {
      await owner.sql(`update cohorts set name = code where code = '115'`)
    }
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

  it('沒得獎的作品：訪客與待審帳號 need_login（不帶題目）；能正常使用平台的登入者看得到；前後件照看的人的列表', async () => {
    expect(await query.entry(ANON, plain.entryId)).toEqual({ access: 'need_login' })
    expect(await query.entry(actor(s1.members[0]!, ['student'], 'pending'), plain.entryId)).toEqual({ access: 'need_login' })
    const student = actor(await newUser('看詳情的學生', 'student'), ['student'])
    const seen = await query.entry(student, plain.entryId)
    expect(seen.access === 'visible' && seen.item).toMatchObject({ title: '菜市場帳本', award: null })
    // 登入者的上一件／下一件走整個歷屆一覽（115 的沒得獎作品在最前）；訪客只在優秀專題之間跳。
    const memberView = await query.entry(student, published.entryId)
    expect(memberView.access === 'visible' && memberView.prev).toEqual({ id: plain.entryId, title: '菜市場帳本' })
    const guestView = await query.entry(ANON, published.entryId)
    expect(guestView.access === 'visible' && guestView.prev).toBeNull()
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

  it('沒得獎作品的海報：訪客拿不到（跟詳情一樣要登入）；能正常使用平台的登入者可以', async () => {
    expect(await download(ANON, plain.posterFileId!)).toBe('UNAUTHENTICATED')
    expect(await download(actor(await newUser('看海報的學生', 'student'), ['student']), plain.posterFileId!)).toBe('ok')
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

describe('第三波 W2：用發布指令發布、首頁輪播順序、刪除', () => {
  async function headRevision(entryId: string) {
    return (await owner.sql('select revision from showcase_entries where id = $1', [entryId])).rows[0]!.revision as number
  }

  it('用 publish 指令發布的作品：沒獎項時訪客看不到、海報要登入；設獎項後優秀專題出現、海報訪客看得到（同 :397 的斷言）', async () => {
    const g = await newGroup(await newCohort('116'), 'G07', ['發布組員'], '發布老師')
    const made = await draft(g.groupId, { title: '用指令發布的作品', summary: '系辦勾同意後發布', poster: PNG })
    const published = await command.publish(actor(admin, ['admin']), { entryId: made.entryId, revision: await headRevision(made.entryId), consent: true }, randomUUID())
    expect(published.ok).toBe(true)

    expect((await query.featured()).map((c) => c.title)).not.toContain('用指令發布的作品')
    expect(await query.entry(ANON, made.entryId)).toEqual({ access: 'need_login' })
    const viewer = actor(await newUser('看新作品的學生', 'student'), ['student'])
    const archive = await query.archive(viewer)
    expect(archive.access === 'visible' && archive.cards.map((c) => c.title)).toContain('用指令發布的作品')
    expect(await download(ANON, made.posterFileId!)).toBe('UNAUTHENTICATED')
    expect(await download(viewer, made.posterFileId!)).toBe('ok')

    const awarded = await command.setAward(
      actor(admin, ['admin']),
      { entryId: made.entryId, revision: await headRevision(made.entryId), level: 'excellent', label: '第 43 屆專題競賽第一名' },
      randomUUID(),
    )
    expect(awarded.ok).toBe(true)
    const card = (await query.featured()).find((c) => c.id === made.entryId)
    expect(card).toMatchObject({ title: '用指令發布的作品', award: 'excellent', awardLabel: '第 43 屆專題競賽第一名', posterFileId: made.posterFileId })
    expect(await download(ANON, made.posterFileId!)).toBe('ok')

    // 下架：網址顯示已下架、優秀專題沒有它、海報不再公開；重新發布後回來。
    await command.withdraw(actor(admin, ['admin']), { entryId: made.entryId, revision: await headRevision(made.entryId) }, randomUUID())
    expect(await query.entry(ANON, made.entryId)).toEqual({ access: 'withdrawn' })
    expect((await query.featured()).map((c) => c.id)).not.toContain(made.entryId)
    expect(await download(ANON, made.posterFileId!)).toBe('UNAUTHENTICATED')
    await command.republish(actor(admin, ['admin']), { entryId: made.entryId, revision: await headRevision(made.entryId) }, randomUUID())
    expect((await query.featured()).map((c) => c.id)).toContain(made.entryId)
    expect(await download(ANON, made.posterFileId!)).toBe('ok')

    // 刪除（先下架）：詳情找不到（不是「已下架」）、各列表沒有它、海報連管理員都打不開。
    await command.withdraw(actor(admin, ['admin']), { entryId: made.entryId, revision: await headRevision(made.entryId) }, randomUUID())
    const deleted = await command.delete(actor(admin, ['admin']), { entryId: made.entryId, revision: await headRevision(made.entryId) }, randomUUID())
    expect(deleted.ok).toBe(true)
    expect(await query.entry(ANON, made.entryId)).toEqual({ access: 'not_found' })
    expect(await query.entry(actor(admin, ['admin']), made.entryId)).toEqual({ access: 'not_found' })
    expect(await download(actor(admin, ['admin']), made.posterFileId!)).toBe('FORBIDDEN')
    expect(await query.cohorts()).not.toContain('116')
  })

  it('首頁輪播（featured 不指定排序）：首頁順序小到大、沒填的排後面；指定「屆別」排序時不受影響', async () => {
    expect((await query.featured()).map((c) => c.title)).toEqual(['城市微光', '安心路徑'])
    await app.query('update showcase_entries set home_position = 1 where id = $1', [other.entryId])
    try {
      expect((await query.featured()).map((c) => c.title)).toEqual(['安心路徑', '城市微光'])
      expect((await query.featured({ sort: 'cohort' })).map((c) => c.title)).toEqual(['城市微光', '安心路徑'])
      await app.query('update showcase_entries set home_position = 2 where id = $1', [published.entryId])
      await app.query('update showcase_entries set home_position = 3 where id = $1', [other.entryId])
      expect((await query.featured()).map((c) => c.title)).toEqual(['城市微光', '安心路徑'])
    } finally {
      await app.query('update showcase_entries set home_position = null where id = any($1::uuid[])', [[other.entryId, published.entryId]])
    }
  })
})

describe('W15（AC-39）：首頁順序、歷屆補登、編輯已發布與封存屆別作品並發布更新', () => {
  async function archivedCohort(code: string): Promise<string> {
    const id = await newCohort(code)
    await owner.sql(`update cohorts set status = 'archived' where id = $1`, [id])
    return id
  }

  async function headRevision(entryId: string): Promise<number> {
    return (await owner.sql('select revision from showcase_entries where id = $1', [entryId])).rows[0]!.revision as number
  }

  async function draftRevision(entryId: string): Promise<number> {
    return (await owner.sql('select revision from showcase_drafts where entry_id = $1', [entryId])).rows[0]!.revision as number
  }

  async function versionCount(entryId: string): Promise<number> {
    return (await owner.sql('select count(*)::int as n from showcase_versions where entry_id = $1', [entryId])).rows[0]!.n as number
  }

  /** ③④ 共用：改摘要、換海報、存草稿 → 訪客仍看到舊的；發布更新 → 訪客看到新的、多一筆版本、舊版本還在。 */
  async function editAndPublishUpdate(entryId: string, oldSummary: string, oldPoster: string | null) {
    const before = await owner.sql('select id, summary, poster_file_id from showcase_versions where entry_id = $1 order by version_no', [entryId])
    const newPoster = await uploadPoster(entryId, PNG3)
    const title = ((await owner.sql('select title from showcase_drafts where entry_id = $1', [entryId])).rows[0]!.title as string) || '題目'
    const saved = await command.updateDraft(
      actor(admin, ['admin']),
      { entryId, revision: await draftRevision(entryId), title, summary: '更新後的摘要', videoUrl: '', posterFileId: newPoster },
      randomUUID(),
    )
    expect(saved).toMatchObject({ ok: true, receipt: { posterChanged: true } })

    // 只存草稿：訪客看到的還是舊摘要、舊海報；新海報訪客打不開。
    let page = await query.entry(ANON, entryId)
    expect(page).toMatchObject({ access: 'visible', item: { summary: oldSummary, posterFileId: oldPoster } })
    expect(await download(ANON, newPoster)).not.toBe('ok')

    const updated = await command.publishUpdate(actor(admin, ['admin']), { entryId, revision: await headRevision(entryId) }, randomUUID())
    expect(updated).toMatchObject({ ok: true, receipt: { versionNo: before.rows.length + 1 } })
    page = await query.entry(ANON, entryId)
    expect(page).toMatchObject({ access: 'visible', item: { summary: '更新後的摘要', posterFileId: newPoster } })
    expect(await download(ANON, newPoster)).toBe('ok')
    // 多一筆版本、舊版本原封不動、狀態仍是公開中。
    expect(await versionCount(entryId)).toBe(before.rows.length + 1)
    const after = await owner.sql('select id, summary, poster_file_id from showcase_versions where id = any($1::uuid[]) order by version_no', [
      before.rows.map((r) => r.id),
    ])
    expect(after.rows).toEqual(before.rows)
    expect((await owner.sql('select status from showcase_entries where id = $1', [entryId])).rows[0]).toEqual({ status: 'published' })
  }

  it('AC-39 ①～⑤：第 3 件首頁順序設 1 → 輪播第一張；補登無組別作品並發布；封存與補登作品存草稿前台不變、發布更新後換新且舊版本保留；老師改封存作品 COHORT_ARCHIVED', async () => {
    // 前置：3 件有獎項的公開作品，其中一件屬封存屆別（建好之後才封存，像歷屆作品）。
    const c117 = await newCohort('117')
    const g1 = await newGroup(c117, 'G11', ['甲'], '甲老師')
    const g2 = await newGroup(c117, 'G12', ['乙'], '乙老師')
    const c110 = await newCohort('110')
    const g3 = await newGroup(c110, 'G13', ['丙'], '丙老師')
    const made: { entryId: string; posterFileId: string | null }[] = []
    for (const [g, title] of [
      [g1, '第一件'],
      [g2, '第二件'],
      [g3, '封存屆的作品'],
    ] as const) {
      const d = await draft(g.groupId, { title, summary: `${title}的舊摘要`, poster: PNG })
      await command.publish(actor(admin, ['admin']), { entryId: d.entryId, revision: await headRevision(d.entryId), consent: true }, randomUUID())
      await command.setAward(actor(admin, ['admin']), { entryId: d.entryId, revision: await headRevision(d.entryId), level: 'merit', label: null }, randomUUID())
      made.push(d)
    }
    await owner.sql(`update cohorts set status = 'archived' where id = $1`, [c110])
    const [, , third] = made as [typeof made[0], typeof made[0], typeof made[0]]

    // ① 第 3 件的首頁順序設 1 → 首頁輪播第一張變成它。
    const positioned = await command.setHomePosition(actor(admin, ['admin']), { entryId: third.entryId, revision: await headRevision(third.entryId), position: '1' }, randomUUID())
    expect(positioned).toMatchObject({ ok: true, receipt: { homePosition: 1 } })
    expect((await query.featured())[0]!.id).toBe(third.entryId)

    // ② 補登一件歷屆作品（不選組別，封存屆別）並發布、設獎項 → 優秀專題頁有它、詳情沒有組別。
    const c105 = await archivedCohort('105')
    const backfilled = await command.createBackfill(actor(admin, ['admin']), { cohortId: c105, title: ' 歷屆補登的作品 ' }, randomUUID())
    expect(backfilled).toMatchObject({ ok: true, receipt: { cohortCode: '105', title: '歷屆補登的作品', revision: 1 } })
    if (!backfilled.ok) return
    const backId = backfilled.receipt.entryId
    const backPoster = await uploadPoster(backId, PNG2)
    expect(
      await command.updateDraft(
        actor(admin, ['admin']),
        { entryId: backId, revision: 1, title: '歷屆補登的作品', summary: '補登的舊摘要', videoUrl: '', posterFileId: backPoster },
        randomUUID(),
      ),
    ).toMatchObject({ ok: true, receipt: { groupCode: null, revision: 2 } })
    expect(await command.publish(actor(admin, ['admin']), { entryId: backId, revision: await headRevision(backId), consent: true }, randomUUID())).toMatchObject({ ok: true })
    await command.setAward(actor(admin, ['admin']), { entryId: backId, revision: await headRevision(backId), level: 'excellent', label: '歷屆優秀' }, randomUUID())
    const card = (await query.featured()).find((c) => c.id === backId)
    expect(card).toMatchObject({ title: '歷屆補登的作品', cohortCode: '105', groupCode: null })

    // ③ 封存屆別的作品：改摘要、換海報、存草稿 → 訪客仍是舊的；發布更新後換新。
    await editAndPublishUpdate(third.entryId, '封存屆的作品的舊摘要', third.posterFileId)
    // ④ 無組別的補登作品重複 ③。
    await editAndPublishUpdate(backId, '補登的舊摘要', backPoster)

    // ⑤ 老師（非管理員）試改封存屆別作品 → 仍被擋 COHORT_ARCHIVED，草稿沒動。
    const teacher = await newUser('非管理員老師', 'teacher')
    const revision = await draftRevision(third.entryId)
    expect(
      await command.updateDraft(
        actor(teacher, ['teacher']),
        { entryId: third.entryId, revision, title: '老師想改', summary: '', videoUrl: '', posterFileId: null },
        randomUUID(),
      ),
    ).toMatchObject({ ok: false, code: 'COHORT_ARCHIVED' })
    expect(await draftRevision(third.entryId)).toBe(revision)

    await command.setHomePosition(actor(admin, ['admin']), { entryId: third.entryId, revision: await headRevision(third.entryId), position: '' }, randomUUID())
  })
})
