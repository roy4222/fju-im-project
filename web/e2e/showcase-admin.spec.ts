import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { sharedTestSession, toPlaywrightCookie } from './session'

/**
 * 第三波 W2：系辦在「精選」發布（勾同意）、設獎項、下架、重新發布、刪除；看得到歷屆作品（AC-10～AC-14）。
 * 第三波 W15（AC-39）：首頁順序、補登歷屆作品（沒有組別）、封存屆別作品改內容與海報後「發布更新」；刪除後同組可再建草稿。
 * C 階段 C1-09（AC-14）：畫面改成清單＋編輯視窗——每件一列，「編輯」開一個視窗一次存齊（題目、摘要、影片、海報、獎項、
 * 首頁順序、公開／下架），「新增」下拉有「作品」「補登歷屆作品」「榮譽」，沒有危險操作區；actions 不變、只換選擇器。
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
/** 同一個封存屆別的第二件已發布、有獎項的作品（首頁輪播拖曳排序用，C1-09）。 */
const OLD2_TITLE = `${stamp} 歷屆佳作`
const AWARD = '第 43 屆專題競賽第一名'

/** 1×1 的真 PNG（瀏覽器畫得出來，用來確認海報不是破圖）。 */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')

let pool: Pool
let cohortId: string
let oldEntryId: string
let oldCohortId: string
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
  const oldCohort = (oldCohortId = await one(
    `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
     values (gen_random_uuid(), $1, $1, 'active', '2020-06-30', 'system') returning id`,
    [OLD_CODE],
  ))
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

  // 第二件（G08、佳作、沒排首頁順序）：同樣的形狀。
  const oldGroup2 = await one(
    `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
     values (gen_random_uuid(), $1, 'G08', 'general', now(), now(), 'system') returning id`,
    [oldCohort],
  )
  const old2 = await one(
    `insert into showcase_entries (id, cohort_id, group_id, status, award_level, created_by_user_id)
     values (gen_random_uuid(), $1, $2, 'draft', 'merit', $3) returning id`,
    [oldCohort, oldGroup2, admin],
  )
  await pool.query(
    `insert into showcase_drafts (entry_id, title, summary, summary_checksum)
     values ($1, $2, '佳作摘要', encode(sha256(convert_to('佳作摘要', 'UTF8')), 'hex'))`,
    [old2, OLD2_TITLE],
  )
  const version2 = await one(
    `insert into showcase_versions (id, entry_id, version_no, title, summary, summary_checksum, authorization_kind, authorization_ref,
                                    pii_check, created_by_user_id, created_real_at)
     select gen_random_uuid(), entry_id, 1, title, summary, summary_checksum, 'external', gen_random_uuid(), '{"passed": true}'::jsonb, $2, now()
       from showcase_drafts where entry_id = $1 returning id`,
    [old2, admin],
  )
  await pool.query(`update showcase_entries set status = 'published', current_version_id = $2, revision = 2 where id = $1`, [old2, version2])
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

/** 作品清單的一列。 */
const row = (page: Page, text: string) => page.getByTestId('entry-row').filter({ hasText: text })
/** 開那一列的編輯視窗。 */
async function edit(page: Page, text: string) {
  await row(page, text).getByRole('button', { name: /^編輯：/ }).click()
  const dialog = page.getByTestId('showcase-edit-dialog')
  await expect(dialog).toBeVisible()
  return dialog
}
/** 右上「新增」下拉的某一項。 */
async function newItem(page: Page, item: '作品' | '補登歷屆作品' | '榮譽') {
  await page.getByRole('button', { name: '新增', exact: true }).click()
  await page.getByRole('menuitem', { name: new RegExp(`^${item}`) }).click()
  const dialog = page.getByTestId('showcase-edit-dialog')
  await expect(dialog).toBeVisible()
  return dialog
}
/** 存好後右下角那一句（多件同時有提示時取看得到的那一個）。 */
const toast = (page: Page) => page.getByTestId('showcase-toast')

test('AC-10、AC-14：預設「全部（含歷屆）」，看得到封存屆別的歷屆作品；狀態與獎項欄有值；沒有閘門字樣與危險操作區；仍說草稿不會公開', async ({ page }) => {
  await asAdmin(page)
  await page.goto('/dashboard/admin/showcase')
  await expect(page.getByRole('navigation', { name: '選擇屆別' }).getByRole('link', { name: '全部（含歷屆）' })).toHaveAttribute('aria-current', 'page')
  await expect(row(page, OLD_TITLE).getByTestId('entry-status')).toHaveText('公開中')
  await expect(row(page, OLD_TITLE).getByTestId('entry-award')).toHaveText('歷屆校級優秀專題')
  await expect(page.getByText('尚無授權')).toHaveCount(0)
  await expect(page.getByText('公開閘門')).toHaveCount(0)
  await expect(page.getByText('草稿不會公開')).toBeVisible()
  // C1-09：沒有頂部兩塊表單、沒有每件展開的存檔鈕與紅色危險區。
  await expect(page.getByRole('group', { name: '危險操作' })).toHaveCount(0)
  await expect(page.getByRole('form', { name: '建立成果展示草稿' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '儲存獎項' })).toHaveCount(0)
  // W15：封存屆別的作品管理員也能改內容；下架照樣能按。
  const dialog = await edit(page, OLD_TITLE)
  await expect(dialog.getByText('這一屆已封存，內容只能查看')).toHaveCount(0)
  await expect(dialog.getByLabel('摘要')).toBeEnabled()
  await expect(dialog.getByRole('button', { name: '下架' })).toBeEnabled()
  await dialog.getByRole('button', { name: '取消' }).click()
  await expect(dialog).toHaveCount(0)
})

test('AC-11、AC-12：新增 › 作品建草稿；海報；沒勾同意存了也還是草稿；勾了發布 → 公開中、紀錄是誰勾的；設獎項後訪客的優秀專題看得到', async ({ page }) => {
  await asAdmin(page)
  await page.goto(`/dashboard/admin/showcase?cohort=${cohortId}`)
  const create = await newItem(page, '作品')
  await create.getByLabel('組別').selectOption({ label: 'G01' })
  await create.getByLabel('題目').fill(TITLE)
  await create.getByLabel('摘要').fill('幫輪椅使用者找到校園裡的無障礙路線。')
  await create.getByRole('button', { name: '儲存', exact: true }).click()
  await expect(toast(page)).toContainText('已替 G01 建立成果展示草稿')
  await expect(toast(page)).toContainText('G01 的成果展示草稿已儲存')
  await expect(row(page, TITLE).getByTestId('entry-status')).toHaveText('草稿')

  // 海報要在作品建好之後從「編輯」上傳；按「儲存」才換上去。
  let g01 = await edit(page, TITLE)
  await g01.getByLabel('選擇海報圖檔').setInputFiles({ name: 'poster.png', mimeType: 'image/png', buffer: PNG })
  await expect(g01.getByTestId('poster-name')).toContainText('poster.png')
  await g01.getByRole('button', { name: '儲存', exact: true }).click()
  await expect(toast(page)).toContainText('海報已更新')

  // 沒勾同意：存了也不會發布。
  g01 = await edit(page, TITLE)
  const consent = g01.getByLabel(/儲存後發布：已取得這組同學同意公開/)
  await expect(consent).not.toBeChecked()
  await g01.getByRole('button', { name: '儲存', exact: true }).click()
  await expect(toast(page)).toContainText('沒有改動')
  await expect(row(page, TITLE).getByTestId('entry-status')).toHaveText('草稿')
  g01 = await edit(page, TITLE)
  await g01.getByLabel(/儲存後發布：已取得這組同學同意公開/).check()
  await g01.getByRole('button', { name: '儲存', exact: true }).click()
  await expect(toast(page)).toContainText('已發布（第 1 版）')
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

  // 設獎項（同一個視窗、存一次）→ 訪客的優秀專題出現，顯示獎項名稱，海報訪客看得到。
  await page.goto(`/dashboard/admin/showcase?cohort=${cohortId}`)
  g01 = await edit(page, TITLE)
  await g01.getByLabel('獎項等級').selectOption('excellent')
  await g01.getByLabel(/獎項名稱/).fill(AWARD)
  await g01.getByRole('button', { name: '儲存', exact: true }).click()
  await expect(toast(page)).toContainText(AWARD)
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

test('AC-13：歷屆作品（封存屆別）下架（一顆鈕一句確認）→ 訪客看到已下架、優秀專題沒有它；重新發布後回來', async ({ page }) => {
  await asAdmin(page)
  await page.goto('/dashboard/admin/showcase')
  let dialog = await edit(page, OLD_TITLE)
  await dialog.getByRole('button', { name: '下架' }).click()
  await expect(dialog).toContainText('確定下架？')
  await dialog.getByRole('button', { name: '確認下架' }).click()
  await expect(toast(page)).toContainText('已下架')
  await expect(row(page, OLD_TITLE).getByTestId('entry-status')).toHaveText('已下架')

  const guest = await asGuest(page)
  await guest.goto(`/projects/${oldEntryId}`)
  await expect(guest.getByText('這則作品已下架')).toBeVisible()
  await guest.goto(`/projects/featured?q=${encodeURIComponent(stamp)}`)
  await expect(guest.getByText(OLD_TITLE)).toHaveCount(0)

  dialog = await edit(page, OLD_TITLE)
  await dialog.getByLabel(/儲存後重新發布/).check()
  await dialog.getByRole('button', { name: '儲存', exact: true }).click()
  await expect(toast(page)).toContainText('已重新發布')
  await guest.goto(`/projects/${oldEntryId}`)
  await expect(guest.getByRole('heading', { name: OLD_TITLE })).toBeVisible()
  await guest.context().close()
})

test('AC-14：公開中不能刪（按鈕寫要先下架）；下架後刪除 → 清單沒有、網址找不到、系辦也打不開海報、操作紀錄有一筆', async ({ page }) => {
  await asAdmin(page)
  await page.goto(`/dashboard/admin/showcase?cohort=${cohortId}`)
  await expect(row(page, TITLE).getByTestId('delete-blocked')).toHaveText('公開中，先下架才能刪')
  await expect(row(page, TITLE).getByTestId('delete-blocked')).toBeDisabled()

  const dialog = await edit(page, TITLE)
  await dialog.getByRole('button', { name: '下架' }).click()
  await dialog.getByRole('button', { name: '確認下架' }).click()
  await expect(toast(page)).toContainText('已下架')
  const remove = row(page, TITLE).getByRole('button', { name: `刪除：${TITLE}` })
  await expect(remove).toBeEnabled()
  await remove.click()
  const confirm = page.getByRole('dialog', { name: '刪除作品' })
  await expect(confirm).toContainText('不能恢復')
  await confirm.getByRole('button', { name: '刪除這件作品' }).click()
  await expect(row(page, TITLE)).toHaveCount(0)

  await page.goto(`/projects/${entryId}`)
  await expect(page.getByText('找不到這個頁面')).toBeVisible()
  expect((await page.request.get(`/api/files/${posterFileId}`)).status()).toBe(403)
  const audit = await pool.query(`select payload from audit_events where target_id = $1 and action = 'showcase.deleted'`, [entryId])
  expect(audit.rows).toHaveLength(1)
  expect(audit.rows[0]!.payload).toMatchObject({ previousStatus: 'withdrawn', title: TITLE })

  // W2b：刪掉之後同一組可以再建草稿。
  await page.goto(`/dashboard/admin/showcase?cohort=${cohortId}`)
  const create = await newItem(page, '作品')
  await create.getByLabel('組別').selectOption({ label: 'G01' })
  await create.getByRole('button', { name: '儲存', exact: true }).click()
  await expect(toast(page)).toContainText('已替 G01 建立成果展示草稿')
})

test('AC-39：首頁順序（數字與拖曳）；補登歷屆作品（沒有組別）；封存屆別作品改摘要＋換海報，存草稿前台不變、發布更新後換新且舊版本保留', async ({ page }) => {
  await asAdmin(page)
  await page.goto('/dashboard/admin/showcase')

  // ① 首頁順序：視窗裡輸入數字。
  let old = await edit(page, OLD_TITLE)
  await old.getByLabel(/首頁順序/).fill('1')
  await old.getByRole('button', { name: '儲存', exact: true }).click()
  await expect(toast(page)).toContainText('首頁順序已設為 1')
  await expect(row(page, OLD_TITLE).getByTestId('entry-home-position')).toHaveText('1')

  // ①-b 首頁輪播順序（只看這個封存屆別：OLD 排 1、OLD2 沒排）：原生拖曳把 OLD2 拖到最前面，存一次 → OLD2＝1、OLD＝2。
  await page.goto(`/dashboard/admin/showcase?cohort=${oldCohortId}`)
  const items = page.getByRole('list', { name: '首頁輪播順序' }).getByTestId('home-order-item')
  await expect(items).toHaveCount(2)
  await expect(items.nth(0)).toContainText(OLD_TITLE)
  await expect(items.nth(1)).toContainText(OLD2_TITLE)
  await items.nth(1).dragTo(items.nth(0))
  await expect(items.nth(0)).toContainText(OLD2_TITLE)
  await page.getByRole('button', { name: '儲存首頁順序' }).click()
  await expect(page.getByText('首頁順序已更新（2 件）。')).toBeVisible()
  await expect(row(page, OLD2_TITLE).getByTestId('entry-home-position')).toHaveText('1')
  await expect(row(page, OLD_TITLE).getByTestId('entry-home-position')).toHaveText('2')
  await page.goto('/dashboard/admin/showcase')

  // ② 補登歷屆作品：選封存的屆別、填題目；組別顯示「（歷屆補登）」。
  const BACK_TITLE = `${stamp} 補登的歷屆作品`
  const backfill = await newItem(page, '補登歷屆作品')
  await backfill.getByLabel('屆別').selectOption({ label: `${OLD_CODE}（${OLD_CODE}）・已封存` })
  await backfill.getByLabel('作品題目').fill(BACK_TITLE)
  await backfill.getByRole('button', { name: '儲存', exact: true }).click()
  await expect(toast(page)).toContainText(`已補登${OLD_CODE}（${OLD_CODE}）「${BACK_TITLE}」`)
  await expect(row(page, BACK_TITLE).getByTestId('entry-group')).toHaveText('（歷屆補登）')

  // ③ 封存屆別作品：改摘要、換海報、存 → 訪客仍是舊摘要；發布更新 → 訪客看到新摘要與新海報。
  old = await edit(page, OLD_TITLE)
  await old.getByLabel('摘要').fill('發布更新後的新摘要')
  await old.getByLabel('選擇海報圖檔').setInputFiles({ name: 'new-poster.png', mimeType: 'image/png', buffer: PNG })
  await expect(old.getByTestId('poster-name')).toContainText('new-poster.png')
  await old.getByRole('button', { name: '儲存', exact: true }).click()
  await expect(toast(page)).toContainText('G09 的成果展示草稿已儲存')
  old = await edit(page, OLD_TITLE)
  await expect(old.getByTestId('unpublished-changes')).toBeVisible()

  const guest = await asGuest(page)
  await guest.goto(`/projects/${oldEntryId}`)
  await expect(guest.getByText('歷屆摘要')).toBeVisible()
  await expect(guest.getByText('發布更新後的新摘要')).toHaveCount(0)

  // 發布更新和發布一樣要勾同意（Q31）。
  const update = old.getByLabel(/儲存後發布更新：已取得這組同學同意公開/)
  await expect(update).not.toBeChecked()
  await update.check()
  await old.getByRole('button', { name: '儲存', exact: true }).click()
  await expect(toast(page)).toContainText('已發布更新（第 2 版）')
  // 同意只算這一次：下次開視窗勾選是空的，只存草稿不會換上前台。
  old = await edit(page, OLD_TITLE)
  await expect(old.getByLabel(/儲存後發布更新/)).not.toBeChecked()
  await old.getByLabel('摘要').fill('再改一次的摘要')
  await old.getByRole('button', { name: '儲存', exact: true }).click()
  await expect(toast(page)).toContainText('G09 的成果展示草稿已儲存')
  old = await edit(page, OLD_TITLE)
  await expect(old.getByTestId('unpublished-changes')).toBeVisible()
  await old.getByRole('button', { name: '取消' }).click()
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
  expect(entry.rows[0]).toEqual({ status: 'published', home_position: 2 })
})

test('AC-AD-06、AC-AD-08、AC-14：成果展示與檔案頁標題「公告與作業」、同一條分頁列；作品是清單沒有表格；「新增」下拉三項；main 裡沒有「專題事務」', async ({ page }) => {
  await asAdmin(page)
  for (const [path, current] of [
    ['/dashboard/admin/showcase', '成果展示'],
    ['/dashboard/admin/files', '檔案'],
  ] as const) {
    await page.goto(path)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('公告與作業')
    const tabs = page.getByRole('navigation', { name: '公告與作業分頁' }).getByRole('link')
    await expect(tabs).toHaveText(['公告', '作業', '資源下載', '專題規則', '成果展示', '檔案'])
    await expect(tabs.nth(0)).toHaveAttribute('href', '/dashboard/admin/affairs')
    await expect(tabs.nth(4)).toHaveAttribute('href', '/dashboard/admin/showcase')
    await expect(tabs.nth(5)).toHaveAttribute('href', '/dashboard/admin/files')
    await expect(tabs.filter({ hasText: current })).toHaveAttribute('aria-current', 'page')
    await expect(tabs.and(page.locator('[aria-current="page"]'))).toHaveCount(1)
    // 側欄的「專題事務」到 SH-1-AD 才拿掉，這裡只看頁面本身。
    await expect(page.getByRole('main').getByText('專題事務')).toHaveCount(0)
  }

  await page.goto('/dashboard/admin/showcase')
  await expect(page.getByRole('main').locator('table')).toHaveCount(0)
  const entry = row(page, OLD_TITLE)
  await expect(entry.getByTestId('entry-group')).toHaveText('G09')
  await expect(entry.getByRole('button', { name: `編輯：${OLD_TITLE}` })).toBeVisible()
  await expect(page.getByText('草稿不會公開')).toBeVisible()
  // 「新增」下拉：作品、補登歷屆作品、榮譽。「作品」只在建草稿的屆別有還沒建的組時能選；開本檔自己建的屆別（G01 已建過，選項停用並寫原因）。
  await page.goto(`/dashboard/admin/showcase?cohort=${cohortId}`)
  await page.getByRole('button', { name: '新增', exact: true }).click()
  const menu = page.getByRole('menu', { name: '新增哪一種' })
  await expect(menu.getByRole('menuitem')).toHaveCount(3)
  await expect(menu.getByRole('menuitem', { name: /^作品/ })).toBeDisabled()
  await expect(menu.getByRole('menuitem', { name: /^補登歷屆作品/ })).toBeEnabled()
  await expect(menu.getByRole('menuitem', { name: /^榮譽/ })).toBeEnabled()
  // 下半是榮譽榜區。
  await expect(page.getByRole('list', { name: '榮譽清單' })).toBeAttached()
  await expect(page.getByRole('navigation', { name: '榮譽榜屆別' })).toBeVisible()
})
