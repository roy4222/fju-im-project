import { expect, request as playwrightRequest, test, type Locator, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * 第 1 批 V1（Q48-a）：公告置頂。驗收 AC-V01～V05、V07～V10（定案 D2 不插隊、D3 後台首頁跟著置頂優先、
 * D9 不設上限且後置頂的在前），以及 AC-V27① 的公告卡與競賽卡 `<img>` 屬性。
 * 第 1 批 V7 延伸：AC-V06 首頁「進行中的競賽」置頂優先；AC-V27① `/news` 每張公告卡都 lazy。
 *
 * 系辦在專題事務工作台按「置頂」→ 前台 `/news`、首頁最新公告、`/competitions` 置頂的排最前並標「置頂」；
 * 下架清掉置頂、重新發布不恢復；本屆學生的置頂公告訪客看不到、學生的公告列表與後台首頁排第一。
 *
 * 前台列表用 `?q=CODE` 只看本檔的資料（同一個資料庫裡還有別支 spec 的公告）。AC-V06 的三則競賽用另一個
 * 代碼 `HOME`（不進 `?q=CODE` 的列表，AC-V07、V08 的順序不受影響）。結尾把本檔的置頂全部取消，
 * 免得影響別支 spec 的首頁與後台首頁順序。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const CODE = `V1P-${stamp}`
const A = `${CODE} 公告 A`
const B = `${CODE} 公告 B`
const C = `${CODE} 草稿 C`
const H = `${CODE} 榮譽 H`
const K1 = `${CODE} 競賽 K1`
const K2 = `${CODE} 競賽 K2`
const S = `${CODE} 本屆公告 S`
const HOME = `V7H-${stamp}`
const HK1 = `${HOME} 競賽 K1`
const HK2 = `${HOME} 競賽 K2`
const HK3 = `${HOME} 競賽 K3`

let pool: Pool
let cohortId: string
let student: TestSession

function ymd(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

async function itemByTitle(title: string) {
  const found = await pool.query<{ id: string; revision: number; pinned_at: Date | null; status: string }>(
    'select id, revision, pinned_at, status from managed_items where title = $1',
    [title],
  )
  return found.rows[0]!
}

async function count(sql: string, values: unknown[]): Promise<number> {
  return Number((await pool.query<{ n: string }>(sql, values)).rows[0]!.n)
}

test.beforeAll(async () => {
  test.setTimeout(120_000)
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備與核對資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })
  cohortId = String(
    (
      await pool.query<{ id: string }>(
        `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
         values (gen_random_uuid(), $1, $1, 'active', $2, 'system') returning id`,
        [CODE, ymd(new Date(Date.now() + 300 * 86_400_000))],
      )
    ).rows[0]!.id,
  )
  // 本屆學生（AC-V10）：學籍與學號占用都在這一屆，`cohort_students` 的公告才看得到。
  const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
  student = await createTestSession(context, 'student')
  await context.dispose()
  const studentNo = `418${String(Date.now()).slice(-6)}`
  await pool.query(
    `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, contact_email)
     values ($1, $2, $2, $3, $4, $5)
     on conflict (user_id) do update set student_no = excluded.student_no, cohort_id = excluded.cohort_id`,
    [student.userId, `${CODE} 學生`, studentNo, cohortId, `v1p-${stamp.toLowerCase()}@contact.example.com`],
  )
  await pool.query('insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)', [cohortId, studentNo, student.userId])
})

test.afterAll(async () => {
  // 本檔的置頂全部取消（不動別支 spec 的資料）。
  await pool?.query(`update managed_items set pinned_at = null where title like $1 or title like $2`, [`${CODE} %`, `${HOME} %`])
  await pool?.end()
})

async function signIn(page: Page, session: TestSession) {
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
}

async function asAdmin(page: Page) {
  await signIn(page, await sharedTestSession(page.request, 'admin'))
}

/** 用完整編輯器發布一則公告（預設公開）；競賽資訊另外填報名截止日與活動日。 */
async function publishNews(
  page: Page,
  title: string,
  options: { audience?: 'public' | 'cohort_students'; competition?: { deadline: string; event: string } } = {},
): Promise<string> {
  await page.goto(`/dashboard/admin/editor/new?cohort=${cohortId}`)
  await page.locator('#ed-title').fill(title)
  await page.locator('#ed-body').fill('置頂測試用的公告。')
  await page.getByLabel('誰看得到').selectOption(options.audience ?? 'public')
  if (options.competition) {
    await page.getByTestId('category-competition').click()
    await page.getByLabel(/報名截止日/).fill(options.competition.deadline)
    await page.getByLabel(/活動日/).fill(options.competition.event)
  }
  await page.getByRole('button', { name: '發布', exact: true }).click()
  const check = page.getByRole('dialog', { name: '發布前檢查' })
  await expect(check.locator('[data-ok="no"]')).toHaveCount(0)
  await check.getByRole('button', { name: '確認發布' }).click()
  await expect(check.getByRole('status')).toContainText('已發布')
  return (await itemByTitle(title)).id
}

function affairRow(page: Page, title: string): Locator {
  return page.getByTestId('affair-row').filter({ hasText: title })
}

/** 在工作台按「置頂」或「取消置頂」，等回饋句。 */
async function togglePin(page: Page, title: string, pin: boolean) {
  await page.goto(`/dashboard/admin/affairs?cohort=${cohortId}`)
  const row = affairRow(page, title)
  await row.getByRole('button', { name: pin ? `置頂「${title}」` : `取消置頂「${title}」` }).click()
  await expect(page.getByTestId('pin-feedback')).toHaveText(
    pin ? `「${title}」已置頂，前台公告與競賽資訊會排在最前面。` : `「${title}」已取消置頂。`,
  )
  await expect(row.getByTestId('pinned-pill')).toHaveCount(pin ? 1 : 0)
}

async function newsTitles(page: Page): Promise<string[]> {
  await page.goto(`/news?q=${encodeURIComponent(CODE)}`)
  await expect(page.getByTestId('news-card').first()).toBeVisible()
  return page.getByTestId('news-card').getByRole('heading').allTextContents()
}

/** 列表卡片的圖（AC-V27①）：`loading="lazy"`＋寬高（16:9 比例提示）。`/news` 前三張也 lazy（V7 拿掉 NewsCard 的 `priority`）。 */
async function expectListImage(card: Locator) {
  const img = card.locator('img')
  await expect(img).toHaveAttribute('loading', 'lazy')
  await expect(img).toHaveAttribute('width', '1280')
  await expect(img).toHaveAttribute('height', '720')
}

test('AC-V01、V02：系辦在工作台置頂發布中的公告；草稿與榮譽沒有置頂按鈕', async ({ page }) => {
  test.setTimeout(180_000)
  await asAdmin(page)
  await publishNews(page, A)
  // A 是三天前發布的（排序看第一次發布時間）。
  await pool.query(`update managed_items set actual_opened_at = actual_opened_at - interval '3 days' where title = $1`, [A])
  await publishNews(page, B)

  // 草稿 C：完整編輯器存草稿。
  await page.goto(`/dashboard/admin/editor/new?cohort=${cohortId}`)
  await page.locator('#ed-title').fill(C)
  await page.getByRole('button', { name: '存草稿' }).click()
  await expect(page.getByRole('status')).toContainText('已存成草稿')

  // 發布中的榮譽 H：三步驟對話框選「榮譽／競賽」。
  await page.goto(`/dashboard/admin/affairs?cohort=${cohortId}`)
  await page.getByRole('button', { name: '新增項目' }).click()
  const dialog = page.getByRole('dialog', { name: '新增項目' })
  await dialog.getByRole('radio', { name: /榮譽／競賽/ }).check()
  await dialog.getByLabel('標題').fill(H)
  await dialog.getByRole('button', { name: '下一步' }).click()
  await dialog.getByLabel('說明', { exact: true }).fill('恭喜。')
  await dialog.getByRole('button', { name: '下一步' }).click()
  await dialog.getByRole('button', { name: '發布', exact: true }).click()
  await expect(dialog.getByRole('status')).toContainText(`「${H}」已發布`)

  const before = await itemByTitle(A)
  const versions = await count('select count(*) as n from item_versions where item_id = $1', [before.id])
  const publications = await count('select count(*) as n from item_publications where item_id = $1', [before.id])

  await togglePin(page, A, true)
  const row = affairRow(page, A)
  await expect(row.getByTestId('pinned-pill')).toHaveText('置頂')
  await expect(row.getByRole('button', { name: `取消置頂「${A}」` })).toHaveText('取消置頂')

  const after = await itemByTitle(A)
  expect(after.pinned_at).not.toBeNull()
  expect(after.revision).toBe(before.revision)
  expect(await count('select count(*) as n from item_versions where item_id = $1', [before.id])).toBe(versions)
  expect(await count('select count(*) as n from item_publications where item_id = $1', [before.id])).toBe(publications)
  expect(await count(`select count(*) as n from audit_events where target_id = $1 and action = 'item.pin'`, [before.id])).toBe(1)

  // 草稿、榮譽、還沒置頂的 B：只有 B 有「置頂」。
  await expect(affairRow(page, C).getByRole('button', { name: /置頂/ })).toHaveCount(0)
  await expect(affairRow(page, H).getByRole('button', { name: /置頂/ })).toHaveCount(0)
  await expect(affairRow(page, B).getByRole('button', { name: `置頂「${B}」` })).toBeVisible()
})

test('AC-V03、V27①：訪客 /news 第一張是置頂的 A（帶「置頂」），B 第二；卡片圖都 lazy、有寬高', async ({ page }) => {
  await page.context().clearCookies()
  expect(await newsTitles(page)).toEqual([A, B])
  const cards = page.getByTestId('news-card')
  await expect(cards.nth(0).getByTestId('pinned-tag')).toHaveText('置頂')
  await expect(cards.nth(1).getByTestId('pinned-tag')).toHaveCount(0)
  for (const card of await cards.all()) await expectListImage(card)
})

test('AC-V04：首頁最新公告第一張是 A（帶「置頂」），B 第二；右側列表不含 A、B', async ({ page }) => {
  await page.context().clearCookies()
  await page.goto('/')
  const region = page.getByRole('region', { name: '最新公告' })
  const cards = region.getByTestId('news-card')
  await expect(cards.nth(0)).toContainText(A)
  await expect(cards.nth(0).getByTestId('pinned-tag')).toHaveText('置頂')
  await expect(cards.nth(1)).toContainText(B)
  await expect(region.locator('ul')).not.toContainText(A)
  await expect(region.locator('ul')).not.toContainText(B)
})

/** 首頁「進行中的競賽」每張卡是本題的哪一則（AC-V06）；別支 spec 的競賽記成 `other`。 */
async function homeCompetitionTitles(page: Page): Promise<string[]> {
  await page.goto('/')
  const cards = page.getByTestId('home-competitions').getByRole('listitem')
  await expect(cards.first()).toBeVisible()
  return (await cards.allTextContents()).map((text) => [HK1, HK2, HK3].find((title) => text.includes(title)) ?? 'other')
}

test('AC-V06：首頁「進行中的競賽」置頂的 K2（決賽／結果）排在報名中的 K1 前面並標「置頂」，K3 最後；多則置頂時後置頂的在前', async ({ page }) => {
  test.setTimeout(180_000)
  await asAdmin(page)
  // K2、K3 已過報名截止、活動還沒結束＝決賽／結果；K3 比 K2 早發布。K1 報名中、最晚發布。
  await publishNews(page, HK3, { competition: { deadline: '2000-01-01', event: '2099-12-31' } })
  await publishNews(page, HK2, { competition: { deadline: '2000-01-01', event: '2099-12-31' } })
  await publishNews(page, HK1, { competition: { deadline: '2099-12-31', event: '2099-12-31' } })
  await togglePin(page, HK2, true)

  await page.context().clearCookies()
  const titles = await homeCompetitionTitles(page)
  expect(titles.slice(0, 2)).toEqual([HK2, HK1])
  // 首頁只放 3 張、資料庫裡可能還有別支 spec 的報名中競賽會排在 K3 前面；本題的卡照 K2、K1、K3 的次序出現。
  const ours = titles.filter((t) => t !== 'other')
  expect(ours).toEqual([HK2, HK1, HK3].slice(0, ours.length))
  const cards = page.getByTestId('home-competitions').getByRole('listitem')
  await expect(cards.nth(0).getByTestId('pinned-tag')).toHaveText('置頂')
  await expect(cards.nth(0)).toContainText('決賽／結果')
  await expect(cards.nth(1).getByTestId('pinned-tag')).toHaveCount(0)
  await expect(cards.nth(1)).toContainText('報名中')

  // D9：再把 K1 也置頂，後置頂的 K1 在前、K2 第二，兩張都標「置頂」。
  await asAdmin(page)
  await togglePin(page, HK1, true)
  await page.context().clearCookies()
  expect((await homeCompetitionTitles(page)).slice(0, 2)).toEqual([HK1, HK2])
  await expect(cards.nth(0).getByTestId('pinned-tag')).toHaveText('置頂')
  await expect(cards.nth(1).getByTestId('pinned-tag')).toHaveText('置頂')

  // 本題的置頂用完就取消，不影響後面幾題與別支 spec 的首頁順序。
  await pool.query(`update managed_items set pinned_at = null where title like $1`, [`${HOME} %`])
})

test('AC-V05、V27①：競賽頁預設排序置頂的 K2 第一；照名稱排時不插隊、仍標「置頂」', async ({ page }) => {
  test.setTimeout(120_000)
  await asAdmin(page)
  await publishNews(page, K1, { competition: { deadline: '2099-12-31', event: '2099-12-31' } })
  await publishNews(page, K2, { competition: { deadline: '2099-06-30', event: '2099-12-31' } })
  await togglePin(page, K2, true)

  await page.context().clearCookies()
  await page.goto(`/competitions?q=${encodeURIComponent(CODE)}`)
  const cards = page.getByTestId('competition-card')
  await expect(cards).toHaveCount(2)
  await expect(cards.nth(0)).toContainText(K2)
  await expect(cards.nth(0).getByTestId('pinned-tag')).toHaveText('置頂')
  await expect(cards.nth(1)).toContainText(K1)
  await expect(cards.nth(1).getByTestId('pinned-tag')).toHaveCount(0)
  for (const card of await cards.all()) await expectListImage(card)

  await page.goto(`/competitions?q=${encodeURIComponent(CODE)}&sort=title`)
  await expect(cards.nth(0)).toContainText(K1)
  await expect(cards.nth(1)).toContainText(K2)
  await expect(cards.nth(1).getByTestId('pinned-tag')).toHaveText('置頂')

  // 取消置頂後回到原本的順序（截止日較晚的 K1 在前）。
  await asAdmin(page)
  await togglePin(page, K2, false)
  await page.context().clearCookies()
  await page.goto(`/competitions?q=${encodeURIComponent(CODE)}`)
  await expect(cards.nth(0)).toContainText(K1)
  await expect(page.getByTestId('pinned-tag')).toHaveCount(0)
})

test('AC-V07：再把 B 置頂，後置頂的在前（B、A），都在未置頂之前；第三則也能置頂', async ({ page }) => {
  await asAdmin(page)
  await togglePin(page, B, true)
  await page.context().clearCookies()
  expect(await newsTitles(page)).toEqual([B, A, K2, K1])
  const cards = page.getByTestId('news-card')
  await expect(cards.nth(0).getByTestId('pinned-tag')).toBeVisible()
  await expect(cards.nth(1).getByTestId('pinned-tag')).toBeVisible()
  await expect(cards.nth(2).getByTestId('pinned-tag')).toHaveCount(0)

  await asAdmin(page)
  await togglePin(page, K1, true)
  await page.context().clearCookies()
  expect(await newsTitles(page)).toEqual([K1, B, A, K2])
})

test('AC-V08：下架清掉置頂；重新發布回到列表但沒有「置頂」、照發布日排', async ({ page }) => {
  await asAdmin(page)
  const a = await itemByTitle(A)
  await page.goto(`/dashboard/admin/editor/${a.id}`)
  await page.getByRole('button', { name: '下架', exact: true }).click()
  await page.getByRole('dialog', { name: '下架這個項目？' }).getByRole('button', { name: '確認下架' }).click()
  await expect(page.getByTestId('item-status')).toHaveText('已下架')
  expect((await itemByTitle(A)).pinned_at).toBeNull()

  await page.context().clearCookies()
  expect(await newsTitles(page)).toEqual([K1, B, K2])

  await asAdmin(page)
  await page.goto(`/dashboard/admin/editor/${a.id}`)
  await page.getByRole('button', { name: '重新發布' }).click()
  await page.getByRole('dialog', { name: '重新發布？' }).getByRole('button', { name: '確認重新發布' }).click()
  await expect(page.getByTestId('item-status')).toHaveText('發布中')
  expect((await itemByTitle(A)).pinned_at).toBeNull()

  await page.context().clearCookies()
  // A 是最早發布的：排在未置頂的最後，沒有「置頂」。
  expect(await newsTitles(page)).toEqual([K1, B, K2, A])
  await expect(page.getByTestId('news-card').nth(3).getByTestId('pinned-tag')).toHaveCount(0)
})

test('AC-V10：本屆學生的置頂公告 S——訪客看不到；學生 /news 與後台首頁公告區第一則是 S', async ({ page }) => {
  test.setTimeout(120_000)
  await asAdmin(page)
  // 先把本檔其他置頂取消，S 才會是唯一的置頂。
  await togglePin(page, K1, false)
  await togglePin(page, B, false)
  await publishNews(page, S, { audience: 'cohort_students' })
  await togglePin(page, S, true)

  await page.context().clearCookies()
  expect(await newsTitles(page)).not.toContain(S)

  await signIn(page, student)
  expect((await newsTitles(page))[0]).toBe(S)
  await expect(page.getByTestId('news-card').nth(0).getByTestId('pinned-tag')).toHaveText('置頂')

  await page.goto('/dashboard/student')
  // 後台首頁的「公告」卡跟 /news 同一份查詢（D3「要」）：置頂的 S 是第一則。
  const news = page.locator('section').filter({ has: page.getByRole('heading', { name: '公告', exact: true }) })
  await expect(news.locator('a[href^="/news/"]').first()).toContainText(S)
})

test('AC-V09：編輯器開著 B 的時候在另一分頁置頂，回來改摘要存檔不衝突，置頂仍在', async ({ page }) => {
  await asAdmin(page)
  const b = await itemByTitle(B)
  await page.goto(`/dashboard/admin/editor/${b.id}`)
  await expect(page.getByTestId('item-status')).toHaveText('發布中')

  const other = await page.context().newPage()
  await togglePin(other, B, true)
  await other.close()

  await page.locator('#ed-summary').fill('置頂之後改的摘要')
  await page.getByRole('button', { name: '發布更新' }).click()
  const update = page.getByRole('dialog', { name: '發布更新前檢查' })
  await update.getByRole('checkbox', { name: /通知對象這次的修改/ }).uncheck()
  await update.getByRole('button', { name: '確認更新' }).click()
  await expect(update.getByRole('status')).toContainText('沒有發通知')
  const after = await pool.query<{ summary: string; pinned_at: Date | null }>('select summary, pinned_at from managed_items where id = $1', [b.id])
  expect(after.rows[0]!.summary).toBe('置頂之後改的摘要')
  expect(after.rows[0]!.pinned_at).not.toBeNull()
})
