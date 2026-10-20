import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createIsolatedDatabase, TEST_DATABASE_URL, type IsolatedDatabase } from './db'
import { migratedSchema } from './migrations'

// 只替 Next 請求環境提供 headers；session、身分解析、命令與查詢都使用真的實作與 PostgreSQL。
const request = vi.hoisted(() => ({ headers: new Headers() }))
vi.mock('next/headers', () => ({ headers: async () => request.headers }))

const BASE_URL = 'http://127.0.0.1:3000'
const PASSWORD = 'Sec-1-Correct-Password-9'
const DENIED = { ok: false, message: '只有系辦可以在前台編輯；請重新登入。' }
const ORIGINAL_TEXT = { title: '原本標題', description: '原本說明' }

let db: IsolatedDatabase
let pool: Pool
let filesRoot: string
let adminId: string
let cookie: string
let teacherId: string
let cohortId: string
let itemId: string
let currentActor: typeof import('@/app/_ui/guard').currentActor
let frontEditContextAction: typeof import('@/app/dashboard/admin/affairs/front-edit-context-action').frontEditContextAction
let opportunityFeContextAction: typeof import('@/app/dashboard/_industry/front-edit/actions').opportunityFeContextAction
let siteActions: typeof import('@/app/_ui/front-edit/forms/actions')

async function oneId(sql: string, values: unknown[] = []) {
  return String((await db.sql(sql, values)).rows[0]!.id)
}

beforeAll(async () => {
  db = await createIsolatedDatabase({ label: 'sec-1', setup: migratedSchema })
  filesRoot = await mkdtemp(path.join(tmpdir(), 'rv-sec-1-files-'))
  const url = new URL(TEST_DATABASE_URL)
  url.searchParams.set('options', `-c search_path=${db.schemaName}`)
  vi.resetModules()
  vi.stubEnv('DATABASE_URL', url.toString())
  vi.stubEnv('BETTER_AUTH_SECRET', 'sec-1-integration-secret-only-32chars')
  vi.stubEnv('BETTER_AUTH_URL', BASE_URL)
  // 測試直接調整帳號狀態；不讓前一案的身分快取遮蔽下一案的資料。
  vi.stubEnv('IDENTITY_CACHE_TTL_SECONDS', '0')
  vi.stubEnv('FILES_ROOT', filesRoot)

  const { authRouteHandlers } = await import('@/infrastructure/auth/wrapper')
  const email = `sec-1-${randomUUID()}@example.com`
  const call = (route: string, body: unknown) => authRouteHandlers.POST(new Request(`${BASE_URL}/api/auth/${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE_URL },
    body: JSON.stringify(body),
  }))
  expect((await call('sign-up/email', { email, password: PASSWORD, name: '系辦' })).status).toBe(200)
  adminId = await oneId('select id from users where email = $1', [email])
  await db.sql(`update users set status = 'active', email_verified = true where id = $1`, [adminId])
  await db.sql(`insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at)
    values (gen_random_uuid(), $1, 'admin', $1, now())`, [adminId])
  const signedIn = await call('sign-in/email', { email, password: PASSWORD })
  expect(signedIn.status).toBe(200)
  cookie = (signedIn.headers.get('set-cookie') ?? '').split(';')[0]!
  expect(cookie).toContain('session_token=')
  expect((await db.sql('select id from sessions where user_id = $1', [adminId])).rowCount).toBeGreaterThan(0)

  teacherId = await oneId(`insert into users (id, name, email, email_verified, updated_at, status)
    values (gen_random_uuid(), '測試老師', 'sec-1-teacher@example.com', true, now(), 'active') returning id`)
  await db.sql(`insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at)
    values (gen_random_uuid(), $1, 'teacher', $2, now())`, [teacherId, adminId])
  cohortId = await oneId(`insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
    values (gen_random_uuid(), 'SEC-1', 'SEC-1', 'active', '2027-06-30', 'system') returning id`)
  itemId = await oneId(`insert into managed_items
    (id, cohort_id, placement, audience_kind, title, body_html, revision, created_by_kind)
    values (gen_random_uuid(), $1, 'news', 'public', '尚未發布的公告', '<p>不得外洩的全文</p>', 3, 'system') returning id`, [cohortId])

  currentActor = (await import('@/app/_ui/guard')).currentActor
  frontEditContextAction = (await import('@/app/dashboard/admin/affairs/front-edit-context-action')).frontEditContextAction
  opportunityFeContextAction = (await import('@/app/dashboard/_industry/front-edit/actions')).opportunityFeContextAction
  siteActions = await import('@/app/_ui/front-edit/forms/actions')
  pool = (await import('@/infrastructure/db/client')).getPool()
})

beforeEach(async () => {
  request.headers = new Headers({ cookie })
  await db.sql(`update users set status = 'active', must_change_password = false where id = $1`, [adminId])
  await db.sql(`update role_assignments set revoked_real_at = null where user_id = $1`, [adminId])
  await db.sql(`insert into site_texts (key, value, revision, updated_by_user_id)
    values ('quick_card_1', $1::jsonb, 1, $2)
    on conflict (key) do update set value = excluded.value, revision = 1`, [JSON.stringify(ORIGINAL_TEXT), adminId])
})

afterAll(async () => {
  await pool?.end()
  await db?.close()
  if (filesRoot) await rm(filesRoot, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

async function requirePasswordChange() {
  await db.sql('update users set must_change_password = true where id = $1', [adminId])
  expect(await currentActor()).toMatchObject({
    kind: 'authenticated', userId: adminId, roles: ['admin'], status: 'active', mustChangePassword: true,
  })
}

describe('SEC-1-1：真 session 直接呼叫 context action', () => {
  it('必須改密的系辦拿不到項目全文或 revision', async () => {
    await requirePasswordChange()
    expect(await frontEditContextAction({ cohortId, itemId })).toEqual(DENIED)
  })

  it('必須改密的系辦拿不到老師名單或登入信箱', async () => {
    await requirePasswordChange()
    expect(await opportunityFeContextAction({ id: null })).toEqual(DENIED)
  })

  it.each(['pending', 'disabled'] as const)('%s 系辦的兩個 context action 都拒絕', async (status) => {
    await db.sql('update users set status = $2 where id = $1', [adminId, status])
    expect(await frontEditContextAction({ cohortId, itemId })).toEqual(DENIED)
    expect(await opportunityFeContextAction({ id: null })).toEqual(DENIED)
  })

  it('沒有 admin 角色的有效 session 也被拒絕', async () => {
    await db.sql('update role_assignments set revoked_real_at = now() where user_id = $1', [adminId])
    expect(await currentActor()).toMatchObject({ kind: 'authenticated', roles: [] })
    expect(await frontEditContextAction({ cohortId, itemId })).toEqual(DENIED)
    expect(await opportunityFeContextAction({ id: null })).toEqual(DENIED)
  })

  it('沒有 session 時拒絕', async () => {
    request.headers = new Headers()
    expect(await frontEditContextAction({ cohortId, itemId })).toEqual(DENIED)
    expect(await opportunityFeContextAction({ id: null })).toEqual(DENIED)
  })
})

describe('SEC-1-2：正常系辦仍取得完整脈絡、可以存檔', () => {
  it('項目全文、revision 與老師登入信箱維持可用', async () => {
    expect(await currentActor()).toMatchObject({ kind: 'authenticated', roles: ['admin'], mustChangePassword: false })
    const item = await frontEditContextAction({ cohortId, itemId })
    expect(item).toMatchObject({
      ok: true, cohortId, avatarUrls: [],
      detail: { id: itemId, title: '尚未發布的公告', bodyHtml: '<p>不得外洩的全文</p>', revision: 3 },
      options: { groups: [] },
    })
    const opportunity = await opportunityFeContextAction({ id: null })
    expect(opportunity).toMatchObject({
      ok: true, current: null,
      teachers: [{ userId: teacherId, name: '測試老師', loginEmail: 'sec-1-teacher@example.com' }],
      labels: { fields: { companyName: expect.any(String) }, limits: { companyName: expect.any(Number) } },
    })
  })

  it('正常系辦存站內文字成功並增加 revision', async () => {
    const fields = { title: '新標題', description: '新說明' }
    expect(await siteActions.saveSiteTextAction({ key: 'quick_card_1', fields, revision: 1, requestId: randomUUID() }))
      .toEqual({ ok: true, revision: 2 })
    expect((await db.sql(`select value, revision from site_texts where key = 'quick_card_1'`)).rows)
      .toEqual([{ value: fields, revision: 2 }])
  })
})

describe('SEC-1 裁定：寫入 action 早退且不動資料', () => {
  it('必須改密的系辦直接 saveSiteTextAction 被拒，內容與 revision 不變', async () => {
    await requirePasswordChange()
    const before = (await db.sql('select * from site_texts order by key')).rows
    const result = await siteActions.saveSiteTextAction({
      key: 'quick_card_1', fields: { title: '不准寫入', description: '不准寫入' }, revision: 1, requestId: randomUUID(),
    })
    expect(result).toMatchObject({ ok: false, message: expect.any(String) })
    expect(result).not.toHaveProperty('revision')
    expect((await db.sql('select * from site_texts order by key')).rows).toEqual(before)
  })

  it('必須改密的系辦不能存首頁橫幅或取得上傳憑證', async () => {
    await requirePasswordChange()
    const beforeHome = (await db.sql('select * from home_settings')).rows
    const beforeFiles = (await db.sql('select * from stored_files order by id')).rows
    expect(await siteActions.saveHeroAction({
      revision: 0, requestId: randomUUID(), heroFileId: '', heroAlt: '', line1: '不准寫入', line2: '',
    })).toMatchObject({ ok: false, message: expect.any(String) })
    const upload = await siteActions.requestHeroUploadAction({ fileName: 'hero.jpg', declaredMime: 'image/jpeg', declaredSize: 10 })
    expect(upload).toMatchObject({ ok: false, message: expect.any(String) })
    expect(upload).not.toHaveProperty('ticket')
    expect((await db.sql('select * from home_settings')).rows).toEqual(beforeHome)
    expect((await db.sql('select * from stored_files order by id')).rows).toEqual(beforeFiles)
  })
})
