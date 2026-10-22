import { createHmac, randomUUID } from 'node:crypto'
import { expect, request as playwrightRequest, test, type APIRequestContext, type APIResponse } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, sharedTestSession, type TestSession } from './session'

/**
 * ⑤-02（#635 跟進；AC-11～AC-14）：帳號狀態被擋的登入者（待審、必須改密）比照訪客下載檔案。
 *
 * 正式組裝的 `PUBLIC_READ_PURPOSES`（首頁大圖、公告封面與附件、精選海報）裡、訪客政策放行的檔：200；
 * 不在清單裡的用途（另一組的繳交檔）：403 JSON「無法存取」、`private, no-store`（被擋的人比照訪客，不多拿）。
 *
 * 位元組走真的上傳端點（同 `avatar-download.spec.ts` 的簽票作法），公告、作品、首頁設定用 owner 連線直接寫
 * （同 `image-attrs.spec.ts`、`file-download-pages.spec.ts`）。首頁設定是全站共用的，結束時恢復原值。
 * 要 `IDENTITY_CACHE_TTL_SECONDS=0`：改完帳號狀態下一個請求就要生效。
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

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')
const PDF = Buffer.from('%PDF-1.4\n% e2e C5-02 公開附件\n')

let pool: Pool
let admin: TestSession
let pending: TestSession
let mustChange: TestSession
let heroId: string
let attachmentId: string
let posterId: string
let submissionId: string
let originalHero: { hero_file_id: string | null } | undefined

async function one(sql: string, values: unknown[] = []): Promise<string> {
  return String((await pool.query(sql, values)).rows[0]!.id)
}

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

/** 建 `uploading` 列、簽票，再把位元組 POST 到真的上傳端點；回 `stored` 的檔案 id。 */
async function upload(purpose: string, cohortId: string | null, fileName: string, type: 'png' | 'pdf', bytes: Buffer): Promise<string> {
  const fileId = randomUUID()
  const now = new Date()
  const key = `files/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${fileId}`
  await pool.query(
    `insert into stored_files
       (id, owner_user_id, scope, cohort_id, purpose, original_name, mime_declared, extension, status, storage_key, uploaded_real_at, updated_by_user_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'uploading', $9, now(), $2)`,
    [fileId, admin.userId, cohortId ? 'cohort' : 'global', cohortId, purpose, fileName, type === 'png' ? 'image/png' : 'application/pdf', type, key],
  )
  const ticket = issueTicket({ fileId, userId: admin.userId, type, maxBytes: 1024 * 1024, expiresAt: Date.now() + 10 * 60_000 })
  const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
  const response = await context.post(`/api/files/upload?ticket=${encodeURIComponent(ticket)}`, {
    headers: { cookie: admin.cookie, origin: new URL(BASE_URL).origin, 'content-type': 'application/octet-stream' },
    data: bytes,
  })
  expect(response.status(), await response.text()).toBe(201)
  await context.dispose()
  return fileId
}

async function fetchFile(as: TestSession, id: string): Promise<APIResponse> {
  const context = track(await playwrightRequest.newContext({ baseURL: BASE_URL }))
  const response = await context.get(`/api/files/${encodeURIComponent(id)}`, { headers: { cookie: as.cookie } })
  await response.body()
  return response
}

function headersOf(response: APIResponse): string {
  const h = response.headers()
  return `HTTP ${response.status()} content-type=${h['content-type']} cache-control=${h['cache-control']}`
}

test.beforeAll(async () => {
  test.setTimeout(120_000)
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })
  // 每個身分各開一個 request context：同一個 context 帶著前一個 session 的 cookie 再註冊，會被當成跨站請求擋掉。
  const sessionOf = async <T>(make: (api: APIRequestContext) => Promise<T>): Promise<T> => {
    const api = await playwrightRequest.newContext({ baseURL: BASE_URL })
    try {
      return await make(api)
    } finally {
      await api.dispose()
    }
  }
  admin = await sessionOf((api) => sharedTestSession(api, 'admin'))
  // 待審：註冊完沒核准（`createTestSession(…, null)` 不改狀態）。必須改密：一般學生再打開旗標。
  pending = await sessionOf((api) => createTestSession(api, null))
  mustChange = await sessionOf((api) => createTestSession(api, 'student'))
  await pool.query('update users set must_change_password = true where id = $1', [mustChange.userId])
  expect((await pool.query('select status from users where id = $1', [pending.userId])).rows[0]).toEqual({ status: 'pending' })

  const cohortId = await one(
    `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
     values (gen_random_uuid(), $1, $1, 'active', '2027-06-30', 'system') returning id`,
    [`PR${stamp}`],
  )
  const groupId = await one(
    `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
     values (gen_random_uuid(), $1, 'G01', 'general', now(), now(), 'system') returning id`,
    [cohortId],
  )

  // （a）首頁大圖：現任那張。
  heroId = await upload('photo', null, `${stamp}-hero.png`, 'png', PNG)
  originalHero = (await pool.query<{ hero_file_id: string | null }>('select hero_file_id from home_settings where id = 1')).rows[0]
  await pool.query(
    `insert into home_settings (id, hero_file_id, updated_by_user_id) values (1, $1, $2)
     on conflict (id) do update set hero_file_id = excluded.hero_file_id`,
    [heroId, admin.userId],
  )

  // （b）公開公告（對象「公開訪客」、發布中）的 PDF 附件。
  attachmentId = await upload('attachment', null, `${stamp}-公開附件.pdf`, 'pdf', PDF)
  const newsId = await one(
    `insert into managed_items (id, cohort_id, placement, audience_kind, title, summary, category, created_by_kind, created_by_user_id)
     values (gen_random_uuid(), $1, 'news', 'public', $2, '公開讀取', '系務公告', 'user', $3) returning id`,
    [cohortId, `${stamp} 公開公告`, admin.userId],
  )
  const contentId = await one(
    `insert into item_versions (id, item_id, version_no, title, summary, body_html, category, created_by_user_id)
     values (gen_random_uuid(), $1, 1, $2, '公開讀取', '', '系務公告', $3) returning id`,
    [newsId, `${stamp} 公開公告`, admin.userId],
  )
  const schemaId = await one(
    `insert into form_schema_versions (id, item_id, version_no, schema, created_by_user_id)
     values (gen_random_uuid(), $1, 1, '{"fields":[]}', $2) returning id`,
    [newsId, admin.userId],
  )
  await pool.query(
    `update managed_items set status = 'published', actual_opened_at = now(), current_content_version_id = $2, current_schema_version_id = $3
      where id = $1`,
    [newsId, contentId, schemaId],
  )
  await pool.query(`insert into file_references (id, file_id, ref_type, ref_id) values (gen_random_uuid(), $1, 'item_attachment', $2)`, [
    attachmentId,
    newsId,
  ])

  // （c）已發布、有獎項等級的作品海報（優秀專題，訪客看得到）。
  posterId = await upload('poster', null, `${stamp}-poster.png`, 'png', PNG)
  const entryId = await one(
    `insert into showcase_entries (id, cohort_id, group_id, status, created_by_user_id) values (gen_random_uuid(), $1, $2, 'draft', $3) returning id`,
    [cohortId, groupId, admin.userId],
  )
  await pool.query(
    `insert into showcase_drafts (entry_id, title, summary, summary_checksum, video_url)
     values ($1, $2, '公開讀取', encode(sha256(convert_to('公開讀取', 'UTF8')), 'hex'), null)`,
    [entryId, `${stamp} 海報作品`],
  )
  const versionId = await one(
    `insert into showcase_versions (id, entry_id, version_no, title, summary, summary_checksum, video_url, authorization_kind,
                                    authorization_ref, pii_check, poster_file_id, poster_checksum, created_by_user_id, created_real_at)
     select gen_random_uuid(), entry_id, 1, title, summary, summary_checksum, video_url, 'external', gen_random_uuid(),
            '{"passed": true}'::jsonb, $2, (select checksum from stored_files where id = $2), $3, now()
       from showcase_drafts where entry_id = $1 returning id`,
    [entryId, posterId, admin.userId],
  )
  await pool.query(
    `update showcase_entries set status = 'published', current_version_id = $2, award_level = 'excellent', award_label = '校級優秀專題'
      where id = $1`,
    [entryId, versionId],
  )
  await pool.query(`insert into file_references (id, file_id, ref_type, ref_id) values (gen_random_uuid(), $1, 'showcase_version', $2)`, [
    posterId,
    versionId,
  ])

  // （d）另一組（這兩個帳號都不在裡面）的繳交檔：不在公開讀取清單。
  submissionId = await upload('submission', cohortId, `${stamp}-繳交.pdf`, 'pdf', PDF)
})

test.afterAll(async () => {
  if (pool) {
    if (originalHero) await pool.query('update home_settings set hero_file_id = $1 where id = 1', [originalHero.hero_file_id])
    else await pool.query('delete from home_settings where id = 1')
    await pool.end()
  }
})

for (const [label, who] of [
  ['待審', () => pending],
  ['必須改密', () => mustChange],
] as const) {
  test(`${label}：首頁大圖 200（public, max-age=300）、公開公告附件與精選海報 200（AC-11～AC-13）`, async () => {
    const hero = await fetchFile(who(), heroId)
    console.log(`[${label}] 首頁大圖 ${headersOf(hero)}`)
    expect(hero.status()).toBe(200)
    expect(hero.headers()['cache-control']).toBe('public, max-age=300, must-revalidate')

    const attachment = await fetchFile(who(), attachmentId)
    console.log(`[${label}] 公開公告附件 ${headersOf(attachment)}`)
    expect(attachment.status()).toBe(200)
    expect(attachment.headers()['content-type']).toContain('application/pdf')

    const poster = await fetchFile(who(), posterId)
    console.log(`[${label}] 精選海報 ${headersOf(poster)}`)
    expect(poster.status()).toBe(200)
  })

  test(`${label}：另一組的繳交檔 403 JSON「無法存取」、private, no-store（AC-14）`, async () => {
    const denied = await fetchFile(who(), submissionId)
    console.log(`[${label}] 另一組繳交檔 ${headersOf(denied)}`)
    expect(denied.status()).toBe(403)
    expect(denied.headers()['cache-control']).toBe('private, no-store')
    expect(await denied.json()).toMatchObject({ ok: false, code: 'FORBIDDEN', message: expect.stringContaining('無法存取') })
  })
}
