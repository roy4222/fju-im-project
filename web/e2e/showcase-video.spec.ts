import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { sharedTestSession, toPlaywrightCookie } from './session'

/**
 * 第 1 批 V3（Q49）：精選影片連結只收 YouTube 影片，作品頁直接嵌入播放。
 *
 * - AC-V13：Vimeo、頻道頁、播放清單、雲端硬碟、`javascript:` 存檔被擋，紅字在影片欄下方、欄位 `aria-invalid`，
 *   打到一半的其他欄位還在、草稿版本不增。
 * - AC-V12：五種 YouTube 網址都存得進去，重開看到自己填的原字串（不改寫）；發布後版本也是原字串，作品頁嵌入 `embed/ID`。
 * - AC-V27⑦：作品頁側欄海報 lazy、`900×1200`。
 *
 * 資料：一個進行中的屆別＋G01（走畫面建草稿、存檔、上傳海報、勾同意發布、設獎項）。每筆都帶這次的戳記。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const CODE = `V3-${stamp}`
const TITLE = `${stamp} 影片嵌入作品`
const MESSAGE = '影片連結只收 YouTube 影片網址（例如 https://www.youtube.com/watch?v=… 或 https://youtu.be/…），不公開影片也可以。'

/** 1×1 的真 PNG。 */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')

let pool: Pool
let cohortId: string

test.beforeAll(async () => {
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備與核對資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })
  const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
  await sharedTestSession(context, 'admin')
  await context.dispose()
  cohortId = String(
    (
      await pool.query(
        `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
         values (gen_random_uuid(), $1, $1, 'active', '2099-06-30', 'system') returning id`,
        [CODE],
      )
    ).rows[0]!.id,
  )
  await pool.query(
    `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
     values (gen_random_uuid(), $1, 'G01', 'general', now(), now(), 'system')`,
    [cohortId],
  )
})

test.afterAll(async () => {
  await pool?.end()
})

async function asAdmin(page: Page) {
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie((await sharedTestSession(page.request, 'admin')).cookie, BASE_URL)])
}

const card = (page: Page) => page.getByTestId('showcase-draft').filter({ hasText: 'G01' })

async function draftRow(): Promise<{ revision: number; videoUrl: string | null; title: string }> {
  const { rows } = await pool.query(
    `select e.revision, d.video_url, d.title from showcase_entries e join showcase_drafts d on d.entry_id = e.id where e.cohort_id = $1`,
    [cohortId],
  )
  return { revision: Number(rows[0]!.revision), videoUrl: rows[0]!.video_url, title: rows[0]!.title }
}

test('AC-V13：不是 YouTube 影片的連結存檔被擋，紅字在影片欄下方、欄位標不合格；其他欄位還在、草稿不變', async ({ page }) => {
  await asAdmin(page)
  await page.goto(`/dashboard/admin/showcase?cohort=${cohortId}`)
  const create = page.getByRole('form', { name: '建立成果展示草稿' })
  await create.getByLabel('組別').selectOption({ label: 'G01' })
  await create.getByRole('button', { name: '建立草稿' }).click()
  await expect(create.getByRole('status')).toContainText('已替 G01 建立成果展示草稿')

  const g01 = card(page)
  const video = g01.getByLabel('影片連結')
  // 欄位說明（不是欄位名稱的一部分）。
  await expect(video).toHaveAccessibleDescription(/只收 YouTube 影片網址（watch、youtu\.be、shorts 都可以），不公開（unlisted）影片也可以。/)
  await g01.getByLabel('題目').fill(TITLE)
  await g01.getByLabel('摘要').fill('打到一半的摘要')
  const before = await draftRow()

  // 瀏覽器 type="url" 只擋非網址字串，提示是同一句。
  await video.fill('youtu.be/t25-demo')
  await g01.getByRole('button', { name: '儲存草稿' }).click()
  expect(await video.evaluate((el) => (el as HTMLInputElement).validationMessage)).toBe(MESSAGE)

  for (const bad of [
    'https://vimeo.com/123',
    'https://www.youtube.com/@fjuim',
    'https://www.youtube.com/playlist?list=PL1',
    'https://drive.google.com/file/d/x',
    // 合法 URL 語法、過得了瀏覽器，由伺服器擋。
    'javascript:alert(1)',
  ]) {
    await video.fill(bad)
    await g01.getByRole('button', { name: '儲存草稿' }).click()
    const alert = g01.getByRole('alert')
    await expect(alert, bad).toHaveText(MESSAGE)
    await expect(alert).toHaveCount(1)
    await expect(video).toHaveAttribute('aria-invalid', 'true')
    // 紅字掛在影片欄上（螢幕閱讀器讀欄位時會讀到），位置在欄位下方。
    const alertId = await alert.getAttribute('id')
    expect((await video.getAttribute('aria-describedby'))?.split(' ')).toContain(alertId)
    const [fieldBox, alertBox] = [await video.boundingBox(), await alert.boundingBox()]
    expect(alertBox!.y).toBeGreaterThan(fieldBox!.y + fieldBox!.height - 1)
    await expect(g01.getByLabel('題目')).toHaveValue(TITLE)
    await expect(g01.getByLabel('摘要')).toHaveValue('打到一半的摘要')
    await expect(video).toHaveValue(bad)
    expect(await draftRow(), bad).toEqual(before)
  }
})

test('AC-V12、AC-V27⑦：五種 YouTube 網址存原字串；發布後版本是原字串、作品頁嵌入 embed/ID；側欄海報 lazy 900×1200', async ({ page, browser }) => {
  await asAdmin(page)
  await page.goto(`/dashboard/admin/showcase?cohort=${cohortId}`)
  const urls = [
    'https://youtu.be/dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/live/dQw4w9WgXcQ?si=abc',
  ]
  for (const url of urls) {
    const g01 = card(page)
    await g01.getByLabel('題目').fill(TITLE)
    // 前後空白存檔時去掉（trim 後的原字串）。
    await g01.getByLabel('影片連結').fill(`${url} `)
    if (url === urls.at(-1)) {
      await g01.getByLabel('選擇海報圖檔').setInputFiles({ name: 'poster.png', mimeType: 'image/png', buffer: PNG })
      await expect(g01.getByTestId('poster-name')).toContainText('poster.png')
    }
    await g01.getByRole('button', { name: '儲存草稿' }).click()
    await expect(g01.getByRole('status'), url).toContainText('G01 的成果展示草稿已儲存')
    await expect(g01.getByRole('alert')).toHaveCount(0)
    await expect(g01.getByLabel('影片連結')).not.toHaveAttribute('aria-invalid', 'true')
    expect((await draftRow()).videoUrl).toBe(url)
    await page.reload()
    await expect(card(page).getByLabel('影片連結'), url).toHaveValue(url)
  }

  const g01 = card(page)
  await g01.getByLabel(/已取得這組同學同意公開/).check()
  await g01.getByRole('button', { name: '發布', exact: true }).click()
  await expect(g01.getByRole('group', { name: '公開' }).getByRole('status')).toContainText('已發布（第 1 版）')
  const awardForm = g01.getByRole('form', { name: /的獎項/ })
  await awardForm.getByLabel('獎項等級').selectOption('excellent')
  await awardForm.getByRole('button', { name: '儲存獎項' }).click()
  await expect(awardForm.getByRole('status')).toBeVisible()

  const { rows } = await pool.query(
    `select e.id, v.video_url from showcase_entries e join showcase_versions v on v.id = e.current_version_id where e.cohort_id = $1`,
    [cohortId],
  )
  expect(rows[0]!.video_url).toBe(urls.at(-1))

  const guest = await (await browser.newContext({ baseURL: BASE_URL })).newPage()
  await guest.route('https://www.youtube.com/embed/**', (route) => route.fulfill({ contentType: 'text/html', body: '<p>stub player</p>' }))
  await guest.goto(`/projects/${rows[0]!.id}`)
  await expect(guest.getByRole('heading', { level: 1 })).toHaveText(TITLE)
  await expect(guest.getByTestId('video-embed')).toHaveAttribute('src', 'https://www.youtube.com/embed/dQw4w9WgXcQ')
  // 有嵌入的作品沒有 16:9 主圖（被 iframe 取代）。
  await expect(guest.locator('main img[width="1280"]')).toHaveCount(0)
  const poster = guest.getByRole('img', { name: '成果海報' })
  await expect(poster).toHaveAttribute('loading', 'lazy')
  await expect(poster).toHaveAttribute('width', '900')
  await expect(poster).toHaveAttribute('height', '1200')
  await poster.scrollIntoViewIfNeeded()
  await expect(poster).toHaveJSProperty('naturalWidth', 1)
  await guest.context().close()
})
