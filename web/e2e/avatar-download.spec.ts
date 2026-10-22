import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { expect, request as playwrightRequest, test, type APIRequestContext, type APIResponse } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * SH-9：上傳頭像的下載權限、快取與換圖（AC-SH-46、AC-SH-72、AC-SH-84；AC-SH-47 的「重設後」段）。
 *
 * 位元組走**真的上傳端點** `POST /api/files/upload?ticket=`（正式建置裡的 sharp 縮圖、清 EXIF），下載走真的
 * `/api/files/<id>`。換上去／重設這一步還沒有畫面（「我的帳號」VB-10、系辦 AD-B2 才掛），所以這裡用 owner 連線
 * 照 `PgAvatarCommand` 的同一組寫入（舊檔標刪、釋放引用、改兩欄）；用例本身的規則在 `avatar-store.integration.test.ts`。
 * 上傳票券同理：照 `avatarUploadTicket` 建 `uploading` 列，用與 app 相同的 `BETTER_AUTH_SECRET` 簽票（`upload-ticket.ts`）。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'

/** 這份開的 request context 每個測試結束就 dispose（#816）；回應要在測試裡讀 body，所以不在抓完就關。 */
const openRequests: APIRequestContext[] = []
function track(context: APIRequestContext): APIRequestContext {
  openRequests.push(context)
  return context
}
test.afterEach(async () => {
  await Promise.all(openRequests.splice(0).map((context) => context.dispose()))
})

const ownerUrl = process.env.DATABASE_URL_OWNER
const FIXTURE = new URL('../test/fixtures/exif.jpg', import.meta.url)

test.describe.configure({ mode: 'serial' })

let pool: Pool
let student: TestSession
let teacher: TestSession
let admin: TestSession

/** 同 `src/infrastructure/ops/upload-ticket.ts` 的 `issueTicket`（那支是 server-only，e2e 不能 import）。 */
function issueTicket(claims: { fileId: string; userId: string; type: string; maxBytes: number; expiresAt: number }): string {
  const secret = process.env.BETTER_AUTH_SECRET
  if (!secret) throw new Error('e2e 需要與 app 相同的 BETTER_AUTH_SECRET 才能簽上傳票券')
  const key = createHmac('sha256', secret).update('fju:file-upload-ticket:v1').digest()
  const payload = Buffer.from(
    JSON.stringify({ f: claims.fileId, u: claims.userId, t: claims.type, m: claims.maxBytes, e: claims.expiresAt }),
    'utf8',
  ).toString('base64url')
  return `${payload}.${createHmac('sha256', key).update(payload).digest('base64url')}`
}

/** 照 `avatarUploadTicket` 建列、簽票，再把位元組 POST 到真的上傳端點。 */
async function uploadAvatar(as: TestSession, bytes: Buffer, fileName: string, type: 'jpg' | 'png', mime: string) {
  const fileId = randomUUID()
  const now = new Date()
  const key = `files/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${fileId}`
  await pool.query(
    `insert into stored_files
       (id, owner_user_id, scope, purpose, original_name, mime_declared, extension, status, storage_key, uploaded_real_at, updated_by_user_id)
     values ($1, $2, 'global', 'avatar', $3, $4, $5, 'uploading', $6, now(), $2)`,
    [fileId, as.userId, fileName, mime, fileName.split('.').pop(), key],
  )
  const ticket = issueTicket({ fileId, userId: as.userId, type, maxBytes: 2 * 1024 * 1024, expiresAt: Date.now() + 10 * 60_000 })
  const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
  const response = await context.post(`/api/files/upload?ticket=${encodeURIComponent(ticket)}`, {
    headers: { cookie: as.cookie, origin: new URL(BASE_URL).origin, 'content-type': 'application/octet-stream' },
    data: bytes,
  })
  const body = (await response.json()) as { ok: boolean; code?: string; checksum?: string }
  await context.dispose()
  return { fileId, status: response.status(), body }
}

/** 同 `PgAvatarCommand.updateAvatar({ fileId })` 的寫入：舊檔標刪＋釋放引用、新檔加引用、改欄位。 */
async function setAvatar(userId: string, fileId: string | null, preset: number | null = null) {
  const old = (await pool.query<{ id: string | null }>('select avatar_file_id as id from user_profiles where user_id = $1', [userId])).rows[0]?.id
  if (old && old !== fileId) {
    await pool.query(`update stored_files set status = 'soft_deleted', soft_deleted_at = now() where id = $1 and status = 'stored'`, [old])
    await pool.query(`update file_references set released_at = now() where file_id = $1 and released_at is null`, [old])
  }
  if (fileId) {
    await pool.query(`insert into file_references (id, file_id, ref_type, ref_id) values (gen_random_uuid(), $1, 'avatar', $2)`, [fileId, userId])
  }
  await pool.query('update user_profiles set avatar_file_id = $2, avatar_preset = $3 where user_id = $1', [userId, fileId, preset])
}

async function fetchAvatar(as: TestSession | null, id: string, headers: Record<string, string> = {}): Promise<APIResponse> {
  const context = track(await playwrightRequest.newContext({ baseURL: BASE_URL }))
  const response = await context.get(`/api/files/${id}`, { headers: as ? { ...headers, cookie: as.cookie } : headers, maxRedirects: 0 })
  await response.body().catch(() => undefined)
  return response
}

test.beforeAll(async () => {
  test.setTimeout(120_000)
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備與核對資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })
  const context = await playwrightRequest.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { origin: new URL(BASE_URL).origin } })
  student = await createTestSession(context, 'student')
  teacher = await sharedTestSession(context, 'teacher')
  admin = await sharedTestSession(context, 'admin')
  await context.dispose()
  await pool.query(
    `insert into user_profiles (user_id, display_name, name_normalized, contact_email) values ($1, '頭像學生', '頭像學生', $2)
     on conflict (user_id) do nothing`,
    [student.userId, student.email],
  )
})

test.afterAll(async () => {
  await pool?.end()
})

let first: string
let firstEtag: string

test('上傳 EXIF JPEG → WebP；三種登入者 200（private, no-cache＋ETag）、訪客 401、帶 ETag 回來問 304', async () => {
  const uploaded = await uploadAvatar(student, await fs.readFile(FIXTURE), 'IMG_0001.JPG', 'jpg', 'image/jpeg')
  expect(uploaded.status).toBe(201)
  first = uploaded.fileId
  await setAvatar(student.userId, first)

  for (const who of [student, teacher, admin]) {
    const response = await fetchAvatar(who, first)
    expect(response.status()).toBe(200)
    const headers = response.headers()
    expect(headers['cache-control']).toBe('private, no-cache')
    expect(headers['etag']).toBe(`"${uploaded.body.checksum}"`)
    expect(headers['content-type']).toBe('image/webp')
    expect(Number(headers['content-length'])).toBeLessThanOrEqual(60 * 1024)
  }
  firstEtag = `"${uploaded.body.checksum}"`
  const visitor = await fetchAvatar(null, first)
  expect(visitor.status()).toBe(401)
  const again = await fetchAvatar(teacher, first, { 'if-none-match': firstEtag })
  expect(again.status()).toBe(304)
  expect(again.headers()['cache-control']).toBe('private, no-cache')
})

test('瀏覽器暖快取後換圖：選單換成新圖；舊網址帶舊 ETag 回來問拿到 404（不是 304）', async ({ page }) => {
  await page.context().addCookies([toPlaywrightCookie(student.cookie, BASE_URL)])
  // 帳號選單只在後台（前台沒有，C2-14）。
  await page.goto('/dashboard/student')
  const menuAvatar = page.getByRole('button', { name: '帳號選單' }).locator('img')
  await expect(menuAvatar).toHaveAttribute('src', `/api/files/${first}`)
  await expect.poll(() => menuAvatar.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(256)
  // 這一次由瀏覽器自己的 HTTP 快取決定要不要帶 If-None-Match（no-cache：存著、但每次回來問）。
  expect(await page.evaluate(async (url) => (await fetch(url)).status, `/api/files/${first}`)).toBe(200)

  const second = await uploadAvatar(student, await fs.readFile(FIXTURE), 'IMG_0002.JPG', 'jpg', 'image/jpeg')
  expect(second.status).toBe(201)
  await setAvatar(student.userId, second.fileId)

  await page.reload()
  await expect(menuAvatar).toHaveAttribute('src', `/api/files/${second.fileId}`)
  expect(await page.evaluate(async (url) => (await fetch(url)).status, `/api/files/${first}`)).toBe(404)

  const gone = await fetchAvatar(student, first, { 'if-none-match': firstEtag })
  expect(gone.status()).toBe(404)
  const document = await fetchAvatar(student, first, { 'sec-fetch-dest': 'document' })
  expect(document.status()).toBe(404)
  expect(document.headers()['location']).toBeUndefined()
  const json = await track(await playwrightRequest.newContext({ baseURL: BASE_URL })).get(`/api/files/${first}`, { headers: { cookie: admin.cookie } })
  expect(json.status()).toBe(404)
  expect(await json.json()).toMatchObject({ ok: false, code: 'FILE_GONE' })

  // 系辦重設（AC-SH-47／84 b）：兩欄清空 → 選單回到 hash 預設圖；上傳的那張也 404。
  await setAvatar(student.userId, null)
  await page.reload()
  await expect(menuAvatar).toHaveAttribute('src', /^\/avatars\/\d{3}\.webp$/)
  expect((await fetchAvatar(student, second.fileId, { 'if-none-match': `"${second.body.checksum}"` })).status()).toBe(404)
})

test('檔頭偽造成 PNG 的亂碼：上傳 415 FILE_TYPE_REJECTED，列維持 uploading，下載 403、頭像不變', async () => {
  const before = (await pool.query('select avatar_file_id from user_profiles where user_id = $1', [student.userId])).rows[0]
  const fake = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(4096)])
  const uploaded = await uploadAvatar(student, fake, 'fake.png', 'png', 'image/png')
  expect(uploaded.status).toBe(415)
  expect(uploaded.body).toMatchObject({ ok: false, code: 'FILE_TYPE_REJECTED' })
  expect((await pool.query('select status from stored_files where id = $1', [uploaded.fileId])).rows[0]).toEqual({ status: 'uploading' })
  expect((await fetchAvatar(student, uploaded.fileId)).status()).toBe(403)
  expect((await pool.query('select avatar_file_id from user_profiles where user_id = $1', [student.userId])).rows[0]).toEqual(before)
})
