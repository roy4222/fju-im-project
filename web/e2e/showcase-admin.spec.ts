import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { sharedTestSession, toPlaywrightCookie } from './session'

/**
 * 第三波 W2：系辦在「精選」發布（勾同意）、設獎項、下架、重新發布、刪除；看得到歷屆作品（AC-10～AC-14）。
 * 第三波 W15（AC-39）：首頁順序、補登歷屆作品（沒有組別）、封存屆別作品改內容與海報後「發布更新」；刪除後同組可再建草稿。
 *
 * 資料：一個進行中的屆別（G01，走畫面建草稿、上傳海報、發布）＋一個**已封存**的屆別放一件已發布、有獎項的歷屆作品
 * （照示範資料的形狀用 owner 直接寫）。每筆都帶這次的戳記，只找自己的。訪客用另一個沒有 cookie 的分頁看前台。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const CODE = `W2-${stamp}`
const OLD_CODE = `W2H-${stamp}`
const TITLE = `${stamp} 校園無障礙地圖`
const OLD_TITLE = `${stamp} 歷屆得獎作品`
const AWARD = '第 43 屆專題競賽第一名'

/** 1×1 的真 PNG（瀏覽器畫得出來，用來確認海報不是破圖）。 */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')

let pool: Pool
let cohortId: string
let oldEntryId: string
let entryId: string
let posterFileId: string

async function one(sql: string, values: unknown[] = []): Promise<string> {
  return String((await pool.query(sql, values)).rows[0]!.id)
}

test.beforeAll(async () => {
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備與核對資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })
  const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
  const admin = (await sharedTestSession(context, 'admin')).userId
  await context.dispose()
  cohortId = await one(
    `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
     values (gen_random_uuid(), $1, $1, 'active', '2099-06-30', 'system') returning id`,
    [CODE],
  )
  await pool.query(
    `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
     values (gen_random_uuid(), $1, 'G01', 'general', now(), now(), 'system')`,
    [cohortId],
  )

  // 歷屆作品：封存屆別、已發布、有獎項（示範資料 `seedHistory` 的形狀）。
  const oldCohort = await one(
    `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
     values (gen_random_uuid(), $1, $1, 'active', '2020-06-30', 'system') returning id`,
    [OLD_CODE],
  )
  const oldGroup = await one(
    `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
     values (gen_random_uuid(), $1, 'G09', 'general', now(), now(), 'system') returning id`,
    [oldCohort],
  )
  oldEntryId = await one(
    `insert into showcase_entries (id, cohort_id, group_id, status, award_level, award_label, created_by_user_id)
     values (gen_random_uuid(), $1, $2, 'draft', 'excellent', '歷屆校級優秀專題', $3) returning id`,
    [oldCohort, oldGroup, admin],
  )
  await pool.query(
    `insert into showcase_drafts (entry_id, title, summary, summary_checksum)
     values ($1, $2, '歷屆摘要', encode(sha256(convert_to('歷屆摘要', 'UTF8')), 'hex'))`,
    [oldEntryId, OLD_TITLE],
  )
  const version = await one(
    `insert into showcase_versions (id, entry_id, version_no, title, summary, summary_checksum, authorization_kind, authorization_ref,
                                    pii_check, created_by_user_id, created_real_at)
     select gen_random_uuid(), entry_id, 1, title, summary, summary_checksum, 'external', gen_random_uuid(), '{"passed": true}'::jsonb, $2, now()
       from showcase_drafts where entry_id = $1 returning id`,
    [oldEntryId, admin],
  )
  await pool.query(`update showcase_entries set status = 'published', current_version_id = $2, revision = 2 where id = $1`, [oldEntryId, version])
  await pool.query(`update cohorts set status = 'archived' where id = $1`, [oldCohort])
})

test.afterAll(async () => {
  await pool?.end()
})

async function asAdmin(page: Page) {
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie((await sharedTestSession(page.request, 'admin')).cookie, BASE_URL)])
}

/** 訪客：同一個瀏覽器、另開一個沒有 cookie 的 context。 */
async function asGuest(page: Page): Promise<Page> {
  const context = await page.context().browser()!.newContext({ baseURL: BASE_URL })
  return context.newPage()
}

const card = (page: Page, text: string) => page.getByTestId('showcase-draft').filter({ hasText: text })
/** 那件作品的「公開」區（發布、下架、重新發布共用一句回饋）。 */
const lifecycle = (page: Page, text: string) => card(page, text).getByRole('group', { name: '公開' })
const row = (page: Page, text: string) => page.getByRole('region', { name: '作品一覽' }).getByRole('row').filter({ hasText: text })

test('AC-10：預設「全部（含歷屆）」，看得到封存屆別的歷屆作品；狀態與獎項欄有值；沒有閘門字樣；仍說草稿不會公開', async ({ page }) => {
  await asAdmin(page)
  await page.goto('/dashboard/admin/showcase')
  await expect(page.getByRole('navigation', { name: '選擇屆別' }).getByRole('link', { name: '全部（含歷屆）' })).toHaveAttribute('aria-current', 'page')
  await expect(row(page, OLD_TITLE).getByTestId('entry-status')).toHaveText('公開中')
  await expect(row(page, OLD_TITLE).getByTestId('entry-award')).toHaveText('歷屆校級優秀專題')
  await expect(page.getByText('尚無授權')).toHaveCount(0)
  await expect(page.getByText('公開閘門')).toHaveCount(0)
  await expect(page.getByText('草稿不會公開')).toBeVisible()
  // W15：封存屆別的作品管理員也能改內容；下架與獎項照樣能按。
  await expect(card(page, OLD_TITLE).getByText('這一屆已封存，內容只能查看')).toHaveCount(0)
  await expect(card(page, OLD_TITLE).getByLabel('摘要')).toBeEnabled()
  await expect(card(page, OLD_TITLE).getByRole('button', { name: '下架' })).toBeEnabled()
})

test('AC-11、AC-12：建草稿＋海報；沒勾同意不能發布；勾了發布 → 公開中、紀錄是誰勾的；設獎項後訪客的優秀專題看得到', async ({ page }) => {
  await asAdmin(page)
  await page.goto(`/dashboard/admin/showcase?cohort=${cohortId}`)
  const create = page.getByRole('form', { name: '建立成果展示草稿' })
  await create.getByLabel('組別').selectOption({ label: 'G01' })
  await create.getByRole('button', { name: '建立草稿' }).click()
  await expect(create.getByRole('status')).toContainText('已替 G01 建立成果展示草稿')

  const g01 = card(page, 'G01')
  await g01.getByLabel('題目').fill(TITLE)
  await g01.getByLabel('摘要').fill('幫輪椅使用者找到校園裡的無障礙路線。')
  await g01.getByLabel('選擇海報圖檔').setInputFiles({ name: 'poster.png', mimeType: 'image/png', buffer: PNG })
  await expect(g01.getByTestId('poster-name')).toContainText('poster.png')
  await g01.getByRole('button', { name: '儲存草稿' }).click()
  await expect(g01.getByRole('status')).toContainText('G01 的成果展示草稿已儲存')

  const publish = g01.getByRole('button', { name: '發布', exact: true })
  await expect(publish).toBeDisabled()
  await expect(g01.getByText('要先勾選上面的同意，才能發布。')).toBeVisible()
  await g01.getByLabel(/已取得這組同學同意公開/).check()
  await publish.click()
  await expect(lifecycle(page, 'G01').getByRole('status')).toContainText('已發布（第 1 版）')
  await expect(row(page, TITLE).getByTestId('entry-status')).toHaveText('公開中')

  const admin = await sharedTestSession(page.request, 'admin')
  const db = await pool.query(
    `select e.id, v.poster_file_id, v.authorization_kind, v.authorization_ref::text as ref, v.pii_check
       from showcase_entries e join showcase_versions v on v.id = e.current_version_id
      where e.cohort_id = $1`,
    [cohortId],
  )
  const version = db.rows[0]!
  entryId = version.id
  posterFileId = version.poster_file_id
  expect(version.authorization_kind).toBe('external')
  expect(version.ref).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  expect(version.pii_check).toMatchObject({ status: 'admin_attested', by: admin.userId })
  const audit = await pool.query(`select actor_user_id, payload from audit_events where target_id = $1 and action = 'showcase.published'`, [entryId])
  expect(audit.rows).toHaveLength(1)
  expect(audit.rows[0]).toMatchObject({ actor_user_id: admin.userId, payload: { consentBy: admin.userId } })

  // 沒獎項：訪客的優秀專題沒有它；登入後歷屆一覽看得到、海報不是破圖。
  const guest = await asGuest(page)
  await guest.goto(`/projects/featured?q=${encodeURIComponent(stamp)}`)
  await expect(guest.getByText(TITLE)).toHaveCount(0)
  await page.goto(`/projects?q=${encodeURIComponent(stamp)}`)
  await expect(page.getByText(TITLE).first()).toBeVisible()
  await page.goto(`/projects/${entryId}`)
  await expect(page.getByRole('img', { name: '成果海報' })).toHaveJSProperty('naturalWidth', 1)

  // 設獎項 → 訪客的優秀專題出現，顯示獎項名稱，海報訪客看得到。
  await page.goto(`/dashboard/admin/showcase?cohort=${cohortId}`)
  const awardForm = card(page, 'G01').getByRole('form', { name: /的獎項/ })
  await awardForm.getByLabel('獎項等級').selectOption('excellent')
  await awardForm.getByLabel(/獎項名稱/).fill(AWARD)
  await awardForm.getByRole('button', { name: '儲存獎項' }).click()
  await expect(awardForm.getByRole('status')).toContainText(AWARD)
  await expect(row(page, TITLE).getByTestId('entry-award')).toHaveText(AWARD)

  await guest.goto(`/projects/featured?q=${encodeURIComponent(TITLE)}`)
  await expect(guest.getByText(TITLE).first()).toBeVisible()
  // 卡片上的徽章滑過看得到獎項全名；詳情頁直接寫出來。
  await expect(guest.getByTestId('award-badge').first()).toHaveAttribute('title', AWARD)
  await guest.goto(`/projects/${entryId}`)
  await expect(guest.getByText(AWARD).first()).toBeVisible()
  await expect(guest.getByRole('img', { name: '成果海報' })).toHaveJSProperty('naturalWidth', 1)
  expect((await guest.request.get(`/api/files/${posterFileId}`)).status()).toBe(200)
  await guest.context().close()
})

test('AC-13：歷屆作品（封存屆別）下架 → 訪客看到已下架、優秀專題沒有它；重新發布後回來', async ({ page }) => {
  await asAdmin(page)
  await page.goto('/dashboard/admin/showcase')
  await card(page, OLD_TITLE).getByRole('button', { name: '下架' }).click()
  await expect(lifecycle(page, OLD_TITLE).getByRole('status')).toContainText('已下架')
  await expect(row(page, OLD_TITLE).getByTestId('entry-status')).toHaveText('已下架')

  const guest = await asGuest(page)
  await guest.goto(`/projects/${oldEntryId}`)
  await expect(guest.getByText('這則作品已下架')).toBeVisible()
  await guest.goto(`/projects/featured?q=${encodeURIComponent(stamp)}`)
  await expect(guest.getByText(OLD_TITLE)).toHaveCount(0)

  await card(page, OLD_TITLE).getByRole('button', { name: '重新發布' }).click()
  await expect(lifecycle(page, OLD_TITLE).getByRole('status')).toContainText('已重新發布')
  await guest.goto(`/projects/${oldEntryId}`)
  await expect(guest.getByRole('heading', { name: OLD_TITLE })).toBeVisible()
  await guest.context().close()
})

test('AC-14：公開中不能刪（說要先下架）；下架後刪除 → 看板沒有、網址找不到、系辦也打不開海報、操作紀錄有一筆', async ({ page }) => {
  await asAdmin(page)
  await page.goto(`/dashboard/admin/showcase?cohort=${cohortId}`)
  const g01 = card(page, 'G01')
  const remove = g01.getByRole('button', { name: '刪除這件作品' })
  await expect(remove).toBeDisabled()
  await expect(g01.getByText('請先按「下架」')).toBeVisible()

  await g01.getByRole('button', { name: '下架' }).click()
  await expect(lifecycle(page, 'G01').getByRole('status')).toContainText('已下架')
  await expect(remove).toBeEnabled()
  await remove.click()
  const dialog = page.getByRole('dialog', { name: '刪除作品' })
  await expect(dialog).toContainText('不能恢復')
  await dialog.getByRole('button', { name: '刪除這件作品' }).click()
  await expect(page.getByTestId('showcase-draft').filter({ hasText: TITLE })).toHaveCount(0)
  await expect(row(page, TITLE)).toHaveCount(0)

  await page.goto(`/projects/${entryId}`)
  await expect(page.getByText('找不到這個頁面')).toBeVisible()
  expect((await page.request.get(`/api/files/${posterFileId}`)).status()).toBe(403)
  const audit = await pool.query(`select payload from audit_events where target_id = $1 and action = 'showcase.deleted'`, [entryId])
  expect(audit.rows).toHaveLength(1)
  expect(audit.rows[0]!.payload).toMatchObject({ previousStatus: 'withdrawn', title: TITLE })

  // W2b：刪掉之後同一組可以再建草稿。
  await page.goto(`/dashboard/admin/showcase?cohort=${cohortId}`)
  const create = page.getByRole('form', { name: '建立成果展示草稿' })
  await create.getByLabel('組別').selectOption({ label: 'G01' })
  await create.getByRole('button', { name: '建立草稿' }).click()
  await expect(create.getByRole('status')).toContainText('已替 G01 建立成果展示草稿')
})

test('AC-39：首頁順序；補登歷屆作品（沒有組別）；封存屆別作品改摘要＋換海報，存草稿前台不變、發布更新後換新且舊版本保留', async ({ page }) => {
  await asAdmin(page)
  await page.goto('/dashboard/admin/showcase')

  // ① 首頁順序。
  const home = card(page, OLD_TITLE).getByRole('form', { name: /的首頁順序/ })
  await home.getByLabel(/首頁順序/).fill('1')
  await home.getByRole('button', { name: '儲存順序' }).click()
  await expect(home.getByRole('status')).toContainText('首頁順序已設為 1')
  await expect(row(page, OLD_TITLE).getByRole('cell').nth(5)).toHaveText('1')

  // ② 補登歷屆作品：選封存的屆別、填題目；組別顯示「（歷屆補登）」。
  const BACK_TITLE = `${stamp} 補登的歷屆作品`
  const backfill = page.getByRole('form', { name: '補登歷屆作品' })
  await backfill.getByLabel('屆別').selectOption({ label: `${OLD_CODE}（已封存）` })
  await backfill.getByLabel('作品題目').fill(BACK_TITLE)
  await backfill.getByRole('button', { name: '補登作品' }).click()
  await expect(backfill.getByRole('status')).toContainText(`已補登 ${OLD_CODE} 屆「${BACK_TITLE}」`)
  await expect(row(page, BACK_TITLE).getByRole('cell').nth(2)).toHaveText('（歷屆補登）')

  // ③ 封存屆別作品：改摘要、換海報、存草稿 → 訪客仍是舊摘要；發布更新 → 訪客看到新摘要與新海報。
  const old = card(page, OLD_TITLE)
  await old.getByLabel('摘要').fill('發布更新後的新摘要')
  await old.getByLabel('選擇海報圖檔').setInputFiles({ name: 'new-poster.png', mimeType: 'image/png', buffer: PNG })
  await expect(old.getByTestId('poster-name')).toContainText('new-poster.png')
  await old.getByRole('button', { name: '儲存草稿' }).click()
  await expect(old.getByRole('form', { name: 'G09 的成果展示草稿' }).getByRole('status')).toContainText('G09 的成果展示草稿已儲存')
  await expect(old.getByTestId('unpublished-changes')).toBeVisible()

  const guest = await asGuest(page)
  await guest.goto(`/projects/${oldEntryId}`)
  await expect(guest.getByText('歷屆摘要')).toBeVisible()
  await expect(guest.getByText('發布更新後的新摘要')).toHaveCount(0)

  // 發布更新和發布一樣要先勾同意（Q31）。
  const update = lifecycle(page, OLD_TITLE).getByRole('button', { name: '發布更新' })
  await expect(update).toBeDisabled()
  await lifecycle(page, OLD_TITLE).getByLabel(/已取得這組同學同意公開/).check()
  await update.click()
  await expect(lifecycle(page, OLD_TITLE).getByRole('status')).toContainText('已發布更新（第 2 版）')
  // 同意只算這一次：成功後勾選清空、按鈕回到停用（下一次要重新勾）。
  await old.getByLabel('摘要').fill('再改一次的摘要')
  await old.getByRole('button', { name: '儲存草稿' }).click()
  await expect(old.getByTestId('unpublished-changes')).toBeVisible()
  await expect(lifecycle(page, OLD_TITLE).getByLabel(/已取得這組同學同意公開/)).not.toBeChecked()
  await expect(update).toBeDisabled()
  await guest.goto(`/projects/${oldEntryId}`)
  await expect(guest.getByText('發布更新後的新摘要')).toBeVisible()
  await expect(guest.getByRole('img', { name: '成果海報' })).toHaveJSProperty('naturalWidth', 1)
  await guest.context().close()

  const versions = await pool.query(`select version_no, summary, poster_file_id from showcase_versions where entry_id = $1 order by version_no`, [oldEntryId])
  expect(versions.rows.map((r) => [r.version_no, r.summary])).toEqual([
    [1, '歷屆摘要'],
    [2, '發布更新後的新摘要'],
  ])
  expect(versions.rows[0]!.poster_file_id).toBeNull()
  expect(versions.rows[1]!.poster_file_id).not.toBeNull()
  const admin = await sharedTestSession(page.request, 'admin')
  const v2 = await pool.query(`select pii_check from showcase_versions where entry_id = $1 and version_no = 2`, [oldEntryId])
  expect(v2.rows[0]!.pii_check).toMatchObject({ status: 'admin_attested', by: admin.userId })
  const entry = await pool.query(`select status, home_position from showcase_entries where id = $1`, [oldEntryId])
  expect(entry.rows[0]).toEqual({ status: 'published', home_position: 1 })
})
