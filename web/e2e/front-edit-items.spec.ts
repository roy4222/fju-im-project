import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { formReady, openAdvanced } from './create-item'
import { fillItemBody } from './item-body'
import { createTestSession, type TestSession } from './session'

/**
 * C 階段規格① C1-06 AC-6a：前台直接編輯（②的框架）開①的表單模組，只改標題，其他欄位都保留。
 *
 * - 公告（含 2 個附件）：首頁「進行中的競賽」那一則按「編輯」。
 * - 作業（對象「指定組別」G01、G03，2 個繳交欄位）：前台目前沒有作業區塊（②§11.3：`submission` 只是列齊），
 *   這裡在頁面上補一個 `data-fe-item="submission"` 標記，走同一個框架與同一個模組。
 *
 * 開窗時送出鈕先 disabled，`frontEditContextAction` 載完 `ItemDetail` 才換成表單；表單初值是完整的 detail（附件、組別、欄位都在），
 * revision 也取自 detail（首頁的標記沒有帶 `data-fe-rev`，用 props 的 revision 會被當成過期）。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER
const PASSWORD = 'E2e-Password-Correct-9'

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const CODE = `FEI-${stamp}`
const PDF = Buffer.from('%PDF-1.4\n% e2e C1-06 AC-6a\n')

let pool: Pool
let admin: TestSession
let cohortId: string

function ymd(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

function localMinute(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 16)
}

test.beforeAll(async () => {
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })
  const api = await playwrightRequest.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { origin: new URL(BASE_URL).origin } })
  // 系辦要用密碼從登入頁登入，才會帶前台編輯的提示 cookie（同 front-edit.spec）。
  admin = await createTestSession(api, 'admin')
  await api.dispose()
  cohortId = String(
    (
      await pool.query<{ id: string }>(
        `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
         values (gen_random_uuid(), $1, $1, 'active', $2, 'system') returning id`,
        [CODE, ymd(new Date(Date.now() + 300 * 86_400_000))],
      )
    ).rows[0]!.id,
  )
  for (const code of ['G01', 'G02', 'G03']) {
    await pool.query(
      `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
       values (gen_random_uuid(), $1, $2, 'general', now(), now(), 'system')`,
      [cohortId, code],
    )
  }
})

test.afterAll(async () => {
  // 置頂只為了排進首頁前 3 則；拿掉，不影響別的 spec 的首頁順序。
  await pool?.query(`update managed_items set pinned_at = null where cohort_id = $1`, [cohortId])
  await pool?.end()
})

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(admin.email)
  await page.getByLabel('密碼', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: '登入', exact: true }).click()
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 })
}

type Snapshot = {
  id: string
  title: string
  revision: number
  category: string | null
  audience_kind: string
  receiver_unit: string
  due_at: Date | null
  registration_deadline_day: string | null
  body_html: string
  attachments: string[]
  groups: string[]
  fields: { key: string; type: string; label: string }[]
}

async function snapshot(title: string): Promise<Snapshot> {
  const found = await pool.query<Omit<Snapshot, 'attachments' | 'groups' | 'fields'> & { fields: Snapshot['fields'] }>(
    `select id, title, revision, category, audience_kind, receiver_unit, due_at, to_char(registration_deadline, 'YYYY-MM-DD') as registration_deadline_day,
            body_html, draft_schema->'fields' as fields
       from managed_items where cohort_id = $1 and title = $2`,
    [cohortId, title],
  )
  expect(found.rows, `找不到「${title}」`).toHaveLength(1)
  const row = found.rows[0]!
  const attachments = await pool.query<{ file_id: string }>('select file_id from item_attachments where item_id = $1 order by sort', [row.id])
  const groups = await pool.query<{ code: string }>(
    'select g.code from item_audience_groups a join groups g on g.id = a.group_id where a.item_id = $1 order by g.code',
    [row.id],
  )
  return {
    ...row,
    fields: (row.fields ?? []).map((f) => ({ key: f.key, type: f.type, label: f.label })),
    attachments: attachments.rows.map((r) => r.file_id),
    groups: groups.rows.map((r) => r.code),
  }
}

/** 前台開編輯模式；`frontEditContextAction` 故意慢一點回，看得到「載入前送出鈕 disabled」。 */
async function openEditMode(page: Page) {
  await page.route(
    (url) => url.pathname === '/',
    async (route) => {
      const request = route.request()
      if (request.method() === 'POST' && request.headers()['next-action']) await new Promise((resolve) => setTimeout(resolve, 800))
      await route.continue().catch(() => undefined)
    },
  )
  await page.goto('/')
  await page.getByRole('button', { name: '編輯頁面' }).click()
  const layer = page.getByTestId('front-edit-layer')
  await expect(layer).toBeAttached()
  return layer
}

test('AC-6a 公告：含 2 個附件的競賽公告，在首頁直接編輯只改標題，附件、分類、日期、正文都保留', async ({ page }) => {
  const title = `${CODE} 校外競賽`
  const renamed = `${CODE} 校外競賽（改名）`
  await signIn(page)

  // 後台建一則公開的競賽公告：2 個附件、報名截止在一個月後（首頁「進行中的競賽」才列得出來）。
  await page.goto(`/dashboard/admin/editor/new?cohort=${cohortId}&placement=news`)
  const form = await formReady(page)
  await form.getByLabel('對象（誰看得到）').selectOption('public')
  await form.getByLabel('標題', { exact: true }).fill(title)
  await fillItemBody(page, '報名請洽系辦。')
  await form.getByLabel('加入附件').setInputFiles([
    { name: '簡章.pdf', mimeType: 'application/pdf', buffer: PDF },
    { name: '報名表.pdf', mimeType: 'application/pdf', buffer: PDF },
  ])
  await expect(form.getByRole('list', { name: '附件' }).getByRole('link')).toHaveCount(2)
  await openAdvanced(form)
  await form.getByTestId('category-competition').click()
  await form.getByLabel(/報名截止日/).fill(ymd(new Date(Date.now() + 30 * 86_400_000)))
  await form.getByRole('button', { name: '發布', exact: true }).click()
  await expect(page).toHaveURL(/\/dashboard\/admin\/affairs\?/)
  const before = await snapshot(title)
  expect(before.attachments).toHaveLength(2)
  await pool.query(`update managed_items set pinned_at = now() where id = $1`, [before.id])

  const layer = await openEditMode(page)
  await layer.getByRole('button', { name: `編輯「${title}」` }).click()
  const dialog = page.getByRole('dialog', { name: '編輯公告' })
  // 載完 detail 之前：送出鈕 disabled，先顯示標題提示。
  const loading = dialog.getByTestId('fe-item-loading')
  await expect(loading).toContainText(title)
  await expect(loading.getByRole('button', { name: '儲存更新' })).toBeDisabled()
  // 載完：初值是完整的 detail。
  const fe = await formReady(dialog)
  await expect(fe.getByLabel('標題', { exact: true })).toHaveValue(title)
  await expect(fe.getByRole('list', { name: '附件' }).getByRole('link')).toHaveText(['簡章.pdf', '報名表.pdf'])
  await fe.getByLabel('標題', { exact: true }).fill(renamed)
  await fe.getByRole('button', { name: '儲存更新' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('status').filter({ hasText: /已發布|已儲存/ })).toBeVisible()

  const after = await snapshot(renamed)
  expect(after.id).toBe(before.id)
  expect(after.revision).toBeGreaterThan(before.revision)
  expect({ ...after, title: before.title, revision: before.revision }).toEqual(before)

  // 重開後台編輯：只有標題變。
  await page.unrouteAll({ behavior: 'ignoreErrors' })
  await page.goto(`/dashboard/admin/editor/${before.id}`)
  const edit = await formReady(page)
  await expect(edit.getByLabel('標題', { exact: true })).toHaveValue(renamed)
  await expect(edit.getByRole('list', { name: '附件' }).getByRole('link')).toHaveText(['簡章.pdf', '報名表.pdf'])
})

test('AC-6a 作業：對象指定組別 G01、G03、2 個繳交欄位，前台直接編輯只改標題，組別與欄位都保留', async ({ page }) => {
  const title = `${CODE} 期中進度表`
  const renamed = `${CODE} 期中進度表（改名）`
  await signIn(page)

  await page.goto(`/dashboard/admin/editor/new?cohort=${cohortId}&placement=submission`)
  const form = await formReady(page)
  await form.getByLabel('對象（誰看得到）').selectOption('groups')
  await form.getByRole('checkbox', { name: /^G01（/ }).check()
  await form.getByRole('checkbox', { name: /^G03（/ }).check()
  await form.getByRole('radio', { name: '整組一份', exact: true }).check()
  await form.getByLabel('截止時間（臺灣時間，含這一分鐘）').fill(localMinute(new Date(Date.now() + 14 * 86_400_000)))
  await form.getByLabel('標題', { exact: true }).fill(title)
  await fillItemBody(page, '交進度表與簡報。')
  await form.getByLabel('要新增的欄位類型').selectOption('text')
  await form.getByRole('button', { name: '新增欄位' }).click()
  await expect(form.locator('section[aria-labelledby="sec-fields"] li[data-field-type]')).toHaveCount(2)
  await form.getByRole('button', { name: '發布', exact: true }).click()
  await expect(page).toHaveURL(/\/dashboard\/admin\/affairs\?/)
  const before = await snapshot(title)
  expect(before.groups).toEqual(['G01', 'G03'])
  expect(before.fields).toHaveLength(2)

  const layer = await openEditMode(page)
  // 前台沒有作業區塊：補一個標記（同 `mark.ts` 的 `feItem` 屬性），框架照樣掃到、開同一個模組。
  await page.evaluate(
    ({ id, name }) => {
      const el = document.createElement('p')
      el.setAttribute('data-fe-item', 'submission')
      el.setAttribute('data-fe-id', id)
      el.setAttribute('data-fe-fields', JSON.stringify({ title: name }))
      el.textContent = name
      document.querySelector('main')!.prepend(el)
    },
    { id: before.id, name: title },
  )
  await layer.getByRole('button', { name: `編輯「${title}」` }).click()
  const dialog = page.getByRole('dialog', { name: '編輯作業' })
  await expect(dialog.getByTestId('fe-item-loading').getByRole('button', { name: '儲存更新' })).toBeDisabled()
  const fe = await formReady(dialog)
  await expect(fe.getByLabel('對象（誰看得到）')).toHaveValue('groups')
  await expect(fe.getByRole('checkbox', { name: /^G01（/ })).toBeChecked()
  await expect(fe.getByRole('checkbox', { name: /^G02（/ })).not.toBeChecked()
  await expect(fe.getByRole('checkbox', { name: /^G03（/ })).toBeChecked()
  await expect(fe.locator('section[aria-labelledby="sec-fields"] li[data-field-type]')).toHaveCount(2)
  await fe.getByLabel('標題', { exact: true }).fill(renamed)
  await fe.getByRole('button', { name: '儲存更新' }).click()
  await expect(dialog).toHaveCount(0)

  const after = await snapshot(renamed)
  expect(after.id).toBe(before.id)
  expect({ ...after, title: before.title, revision: before.revision }).toEqual(before)

  await page.unrouteAll({ behavior: 'ignoreErrors' })
  await page.goto(`/dashboard/admin/editor/${before.id}`)
  const edit = await formReady(page)
  await expect(edit.getByLabel('標題', { exact: true })).toHaveValue(renamed)
  await expect(edit.getByRole('checkbox', { name: /^G01（/ })).toBeChecked()
  await expect(edit.getByRole('checkbox', { name: /^G03（/ })).toBeChecked()
  await expect(edit.locator('section[aria-labelledby="sec-fields"] li[data-field-type]')).toHaveCount(2)
})
