import { expect, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { sharedTestSession, toPlaywrightCookie } from './session'

/**
 * 系辦編輯器正文旁的即時預覽（系辦 AD-16；AC-AD-28）：
 *
 * 1. 新建頁沒填標題：窗格寫「填好標題、開始打正文就會出現預覽」與檢查原因「請填標題。」，不渲染正文。
 * 2. 填好標題：窗格渲染伺服器淨化後的正文（粗體在）；正文裡的 `<script>`、`onerror` 不執行，也不出現原字。
 * 3. 標題清空：窗格寫「請填標題。」並清掉上一版預覽。
 * 4. 頂列「預覽」只開關窗格、不多打伺服器；手機寬預設收起、按了才展開。
 *
 * 所見即所得正文（AD-B5，設計方案 §8.2；AC-A-29、30、49）：預設是 Tiptap 工具列，「原始 HTML」切成 textarea；
 * 上面幾個預覽案例要直接填 HTML，先切「原始 HTML」再填。
 * 白名單格式組合往返（A-R6）：Tiptap 讀進來、在別處改字、存檔後，每個字的區塊與格式都不變；
 * Tiptap 無法原樣保留的組合，自動留在原始 HTML，正文不動。
 *
 * 屆別用 owner 連線直接建；全程用真的表單與按鈕。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const CODE = `AD16-${stamp}`

let pool: Pool
let cohortId: string

function ymd(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

test.beforeAll(async () => {
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備資料')
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
  await pool.query(
    `insert into cohort_stages (id, cohort_id, seq, name, start_date, created_by_kind)
     values (gen_random_uuid(), $1, 1, '成組期', $2, 'system')`,
    [cohortId, ymd(new Date())],
  )
})

test.afterAll(async () => {
  await pool?.end()
})

async function asAdmin(page: Page) {
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie((await sharedTestSession(page.request, 'admin')).cookie, BASE_URL)])
}

/** 正文切到「原始 HTML」（textarea），回傳那個 textarea。 */
async function rawHtml(page: Page) {
  await page.getByRole('group', { name: '正文編輯方式' }).getByRole('button', { name: '原始 HTML' }).click()
  const area = page.locator('textarea#ed-body')
  await expect(area).toBeVisible()
  return area
}

/** 正文切回所見即所得，回傳編輯區（contenteditable）。 */
async function richMode(page: Page) {
  await page.getByRole('group', { name: '正文編輯方式' }).getByRole('button', { name: '所見即所得' }).click()
  const editor = page.locator('#ed-body[contenteditable="true"]')
  await expect(editor).toBeVisible()
  return editor
}

/** 數 Server Action 請求（自動檢查 `reviewItemAction` 就是走這個）。 */
function countActions(page: Page) {
  const counter = { n: 0 }
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.headers()['next-action']) counter.n += 1
  })
  return counter
}

test('正文旁預覽：先填標題才渲染、只渲染淨化後的正文、檢查失敗清掉舊預覽、按鈕只開關窗格', async ({ page }) => {
  const alerts: string[] = []
  page.on('dialog', async (d) => {
    alerts.push(d.message())
    await d.dismiss()
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await asAdmin(page)
  const actions = countActions(page)
  await page.goto(`/dashboard/admin/editor/new?cohort=${cohortId}`)

  const pane = page.getByRole('region', { name: '預覽', exact: true })
  await rawHtml(page)
  const body = page.getByLabel('正文（網頁排版格式，可直接打字）', { exact: true })
  await expect(body).toBeVisible()
  await expect(page.getByRole('main').getByRole('link', { name: '公告與作業', exact: true })).toHaveAttribute(
    'href',
    `/dashboard/admin/affairs?cohort=${cohortId}`,
  )

  // 一開始與步驟 1：還沒有標題，只有提示句與原因，正文沒有渲染。
  await expect(pane).toContainText('填好標題、開始打正文就會出現預覽')
  await expect(pane).toContainText('請填標題。')
  await body.fill('<p>期中<strong>報告</strong></p>')
  await page.waitForTimeout(1000)
  await expect(pane).toContainText('請填標題。')
  await expect(pane.locator('strong')).toHaveCount(0)
  await expect(pane).not.toContainText('期中')

  // 1440 寬：窗格在正文右側。
  const bodyBox = (await body.boundingBox())!
  const paneBox = (await pane.boundingBox())!
  expect(paneBox.x).toBeGreaterThanOrEqual(bodyBox.x + bodyBox.width)
  expect(paneBox.y).toBeLessThan(bodyBox.y + bodyBox.height)

  // 步驟 2：填標題 → 渲染淨化後的正文。
  await page.locator('#ed-title').fill('期中報告說明')
  await expect(pane.locator('strong')).toHaveText('報告')
  await expect(pane).not.toContainText('填好標題')
  await expect(pane).not.toContainText('請填標題。')

  // 含 <script> 與 onerror：不執行、不出現原字。
  await body.fill('<p>第二版<strong>報告</strong></p><script>window.__ad16=1;alert(1)</script><img src=x onerror="window.__ad16=2;alert(2)">')
  await expect(pane).toContainText('第二版')
  await expect(pane).not.toContainText('<script')
  await expect(pane).not.toContainText('__ad16')
  expect(await pane.innerHTML()).not.toMatch(/<script|onerror/i)
  expect(await page.evaluate(() => (window as unknown as { __ad16?: number }).__ad16)).toBeUndefined()
  expect(alerts, '正文裡的腳本不能執行').toEqual([])

  // 步驟 3：清空標題 → 原因出現、上一版預覽清掉。
  await page.locator('#ed-title').fill('')
  await expect(pane).toContainText('請填標題。')
  await expect(pane).toContainText('填好標題、開始打正文就會出現預覽')
  await expect(pane).not.toContainText('第二版')
  await expect(pane.locator('strong')).toHaveCount(0)

  // 頂列「預覽」：只開關窗格，不多打伺服器。
  await page.waitForTimeout(1000)
  const before = actions.n
  const toggle = page.locator('button[aria-controls="ed-body-preview"]')
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await toggle.click()
  await expect(pane).toBeHidden()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  await expect(pane).toBeVisible()
  await page.waitForTimeout(1000)
  expect(actions.n, '按「預覽」不應多打伺服器').toBe(before)
})

test('手機寬：預覽窗格預設收起，頂列「預覽」可以展開', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await asAdmin(page)
  await page.goto(`/dashboard/admin/editor/new?cohort=${cohortId}`)
  await page.locator('#ed-title').fill('手機預覽')
  await (await rawHtml(page)).fill('<p>手機<strong>看得到</strong></p>')

  const pane = page.locator('#ed-body-preview')
  const toggle = page.locator('button[aria-controls="ed-body-preview"]')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(pane).toBeHidden()

  // 先切到別的分頁，按「預覽」也會回到窗格所在的「內容」分頁。
  await page.getByRole('navigation', { name: '編輯區段' }).getByRole('button', { name: '發布' }).click()
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(pane).toBeVisible()
  await expect(pane.locator('strong')).toHaveText('看得到')
  // 窄螢幕窗格在正文下方。
  const bodyBox = (await page.locator('#ed-body').boundingBox())!
  const paneBox = (await pane.boundingBox())!
  expect(paneBox.y).toBeGreaterThanOrEqual(bodyBox.y + bodyBox.height)
})

test('成功預覽後手動「檢查與預覽」斷線：窗格寫原因、清掉舊預覽', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await asAdmin(page)
  await page.goto(`/dashboard/admin/editor/new?cohort=${cohortId}`)
  await page.locator('#ed-title').fill('斷線預覽')
  await (await rawHtml(page)).fill('<p>斷線前<strong>看得到</strong></p>')
  const pane = page.getByRole('region', { name: '預覽', exact: true })
  await expect(pane.locator('strong')).toHaveText('看得到')

  // 之後的 Server Action 都斷線（頁面不重新載入）。
  await page.route('**/dashboard/admin/editor/new**', (route) =>
    route.request().method() === 'POST' && route.request().headers()['next-action'] ? route.abort('failed') : route.continue(),
  )
  await page.getByRole('region', { name: '預覽確認' }).getByRole('button', { name: '檢查與預覽' }).click()
  await expect(pane).toContainText('連線中斷，請再按一次。')
  await expect(pane.locator('strong')).toHaveCount(0)
  await expect(pane).not.toContainText('斷線前')
})

/** `application/items/rich-text.ts` 的白名單（測試自己抄一份：清理規則改了，這裡要跟著看）。 */
const ALLOWED_TAGS = new Set(['p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'ul', 'ol', 'li', 'h2', 'h3', 'h4', 'blockquote', 'a', 'hr', 'code', 'pre', 'table', 'thead', 'tbody', 'tr', 'th', 'td'])

function tagsOf(html: string): string[] {
  return [...new Set([...html.matchAll(/<([a-z][a-z0-9]*)\b/gi)].map((m) => m[1]!.toLowerCase()))]
}

async function bodyOf(title: string): Promise<{ id: string; body: string }> {
  const found = await pool.query<{ id: string; body_html: string }>('select id, body_html from managed_items where title = $1', [title])
  expect(found.rows, `找不到「${title}」`).toHaveLength(1)
  return { id: found.rows[0]!.id, body: found.rows[0]!.body_html }
}

/** 存草稿並等到「已儲存」。 */
async function saveDraft(page: Page) {
  await page.getByRole('button', { name: '存草稿', exact: true }).click()
  await expect(page.getByText('已儲存', { exact: true })).toBeVisible()
}

/** 發布（公開），等到「已發布」。 */
async function publishPublic(page: Page) {
  await page.getByLabel('誰看得到').selectOption('public')
  await page.getByRole('button', { name: '發布', exact: true }).click()
  const check = page.getByRole('dialog', { name: '發布前檢查' })
  await expect(check.locator('[data-ok="no"]')).toHaveCount(0)
  await check.getByRole('button', { name: '確認發布' }).click()
  await expect(check.getByRole('status')).toContainText('已發布')
}

test('所見即所得：工具列打字、設標題、插連結 → 預覽一致；發布後前台只含白名單標籤（AC-A-29）', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await asAdmin(page)
  await page.goto(`/dashboard/admin/editor/new?cohort=${cohortId}`)
  const title = `工具列公告-${stamp}`
  await page.locator('#ed-title').fill(title)

  const toolbar = page.getByRole('toolbar', { name: '正文格式' })
  await expect(toolbar).toBeVisible()
  const editor = page.locator('#ed-body[contenteditable="true"]')
  await expect(editor).toBeVisible()
  await expect(page.locator('textarea#ed-body')).toHaveCount(0)

  // 標題 2
  await editor.click()
  await page.keyboard.type('期末報告說明')
  await toolbar.getByRole('button', { name: '標題 2' }).click()
  await expect(editor.locator('h2')).toHaveText('期末報告說明')
  await expect(toolbar.getByRole('button', { name: '標題 2' })).toHaveAttribute('aria-pressed', 'true')

  // 下一段：一般文字＋粗體＋連結
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('請準時繳交，')
  await toolbar.getByRole('button', { name: '粗體' }).click()
  await page.keyboard.type('逾期不收')
  await toolbar.getByRole('button', { name: '粗體' }).click()
  await page.keyboard.type('。報名表')
  for (let n = 0; n < 3; n += 1) await page.keyboard.press('Shift+ArrowLeft')
  await toolbar.getByRole('button', { name: '連結' }).click()
  // 不安全的網址不收
  await page.getByLabel('連結網址').fill('javascript:alert(1)')
  await page.getByRole('button', { name: '套用連結' }).click()
  await expect(page.getByRole('alert').filter({ hasText: '連結只收' })).toBeVisible()
  await page.getByLabel('連結網址').fill('https://example.com/form')
  await page.getByRole('button', { name: '套用連結' }).click()

  await expect(editor.locator('strong')).toHaveText('逾期不收')
  await expect(editor.locator('a')).toHaveText('報名表')
  await expect(editor.locator('a')).toHaveAttribute('href', 'https://example.com/form')

  // 預覽與編輯器一致（伺服器淨化後的版本）。
  const pane = page.getByRole('region', { name: '預覽', exact: true })
  await expect(pane.locator('h2')).toHaveText('期末報告說明')
  await expect(pane.locator('strong')).toHaveText('逾期不收')
  await expect(pane.locator('a')).toHaveText('報名表')
  await expect(pane.locator('a')).toHaveAttribute('href', 'https://example.com/form')
  await expect(pane).toContainText('請準時繳交，逾期不收。報名表')

  await publishPublic(page)
  const { id, body } = await bodyOf(title)
  expect(body).toContain('<h2>期末報告說明</h2>')
  for (const tag of tagsOf(body)) expect(ALLOWED_TAGS.has(tag), `資料庫正文出現 <${tag}>`).toBe(true)

  await page.goto(`/news/${id}`)
  const front = page.locator('.prose-item')
  await expect(front.locator('h2')).toHaveText('期末報告說明')
  await expect(front.locator('strong')).toHaveText('逾期不收')
  await expect(front.locator('a')).toHaveAttribute('href', 'https://example.com/form')
  for (const tag of tagsOf(await front.innerHTML())) expect(ALLOWED_TAGS.has(tag), `前台正文出現 <${tag}>`).toBe(true)
})

test('原始 HTML 改一行再切回 → 編輯器顯示新內容；貼 <script> 存檔後正文不含 script（AC-A-30）', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await asAdmin(page)
  await page.goto(`/dashboard/admin/editor/new?cohort=${cohortId}`)
  const title = `原始切換-${stamp}`
  await page.locator('#ed-title').fill(title)

  let editor = page.locator('#ed-body[contenteditable="true"]')
  await editor.click()
  await page.keyboard.type('第一行')
  await page.keyboard.press('Enter')
  await page.keyboard.type('第二行')

  const area = await rawHtml(page)
  await expect(area).toHaveValue('<p>第一行</p><p>第二行</p>')
  await area.fill('<p>第一行</p><p>第二行（已改）</p><script>window.__a30=1</script>')

  editor = await richMode(page)
  await expect(editor.locator('p').nth(1)).toHaveText('第二行（已改）')
  await expect(editor).not.toContainText('__a30')

  await saveDraft(page)
  const { body } = await bodyOf(title)
  expect(body).toContain('第二行（已改）')
  expect(body).not.toMatch(/<script|__a30/i)
  expect(await page.evaluate(() => (window as unknown as { __a30?: number }).__a30)).toBeUndefined()
})

test('原始 HTML ↔ 所見即所得來回切換：表格、底線、粗斜體、帶 title 的連結都保留（AC-A-49）', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await asAdmin(page)
  await page.goto(`/dashboard/admin/editor/new?cohort=${cohortId}`)
  const title = `格式保留-${stamp}`
  await page.locator('#ed-title').fill(title)

  const source =
    '<p>說明：<u>底線</u>、<b>甲</b><i>乙</i>、<a href="https://example.com" title="示例">連結</a>、<a href="/rules">站內</a></p>' +
    '<table><tr><th>項目</th><th>期限</th></tr><tr><td>初稿</td><td>十月底</td></tr></table>'
  await (await rawHtml(page)).fill(source)

  // 切回所見即所得：編輯器裡看得到每一種格式。
  let editor = await richMode(page)
  const expectEditor = async () => {
    await expect(editor.locator('u')).toHaveText('底線')
    await expect(editor.locator('strong, b')).toHaveText('甲')
    await expect(editor.locator('em, i')).toHaveText('乙')
    await expect(editor.locator('a[title="示例"]')).toHaveAttribute('href', 'https://example.com')
    await expect(editor.locator('a', { hasText: '站內' })).toHaveAttribute('href', '/rules')
    await expect(editor.locator('table tr')).toHaveCount(2)
    await expect(editor.locator('table tr').nth(0).locator('th, td')).toHaveText(['項目', '期限'])
    await expect(editor.locator('table tr').nth(1).locator('th, td')).toHaveText(['初稿', '十月底'])
  }
  await expectEditor()

  // 在所見即所得裡改一個字，讓正文改由 Tiptap 輸出，再切「原始 HTML」看它寫出來的樣子。
  await editor.locator('p').first().click()
  await page.keyboard.press('End')
  await page.keyboard.type('。')
  const area = await rawHtml(page)
  const serialized = await area.inputValue()
  expect(serialized).toMatch(/<u>底線<\/u>/)
  expect(serialized).toMatch(/<(strong|b)>甲<\/(strong|b)>/)
  expect(serialized).toMatch(/<(em|i)>乙<\/(em|i)>/)
  expect(serialized).toMatch(/<a [^>]*href="https:\/\/example\.com"/)
  expect(serialized).toMatch(/<a [^>]*title="示例"/)
  expect(serialized, '站內相對連結也要留著').toMatch(/<a [^>]*href="\/rules"[^>]*>站內<\/a>/)

  editor = await richMode(page)
  await expectEditor()
  await saveDraft(page)

  // 資料庫正文（伺服器淨化後）。
  const { id, body } = await bodyOf(title)
  expect(body).toMatch(/<u>底線<\/u>/)
  expect(body).toMatch(/<(strong|b)>甲<\/(strong|b)>/)
  expect(body).toMatch(/<(em|i)>乙<\/(em|i)>/)
  expect(body).toMatch(/<a [^>]*href="https:\/\/example\.com"/)
  expect(body).toMatch(/<a [^>]*title="示例"/)
  expect(body).toMatch(/<a [^>]*href="\/rules"[^>]*>站內<\/a>/)
  const rows = [...body.matchAll(/<tr>(.*?)<\/tr>/g)].map((m) => [...m[1]!.matchAll(/<t[hd]>(.*?)<\/t[hd]>/g)].map((c) => c[1]!.replace(/<[^>]+>/g, '')))
  expect(rows).toEqual([
    ['項目', '期限'],
    ['初稿', '十月底'],
  ])

  // 前台頁面（發布成公開後看 /news/<id>）。
  await page.goto(`/dashboard/admin/editor/${id}`)
  await publishPublic(page)
  await page.goto(`/news/${id}`)
  const front = page.locator('.prose-item')
  await expect(front.locator('u')).toHaveText('底線')
  await expect(front.locator('strong, b')).toHaveText('甲')
  await expect(front.locator('em, i')).toHaveText('乙')
  await expect(front.locator('a[title="示例"]')).toHaveAttribute('href', 'https://example.com')
  await expect(front.locator('table tr')).toHaveCount(2)
  await expect(front.locator('table tr').nth(0).locator('th, td')).toHaveText(['項目', '期限'])
  await expect(front.locator('table tr').nth(1).locator('th, td')).toHaveText(['初稿', '十月底'])
})

/**
 * 格式指紋（測試自己的一份，在瀏覽器裡算）：每個字的「所在區塊鏈＋格式集合」序列，加上段落邊界、換行、分隔線、空段落。
 * 允許的正規化不算差異：b→strong、i→em、補 p、補 tbody／丟 thead、pre 補 code、pre 裡 br→換行、格式巢狀順序、
 * colgroup／style、連結 target／rel、連續空白與區塊邊緣空白。
 */
function signatureIn(page: Page, html: string): Promise<string> {
  return page.evaluate((source) => {
    const containers: Record<string, string> = { H2: 'h2', H3: 'h3', H4: 'h4', UL: 'ul', OL: 'ol', LI: 'li', BLOCKQUOTE: 'q', PRE: 'pre', TABLE: 'table', TR: 'tr', TH: 'th', TD: 'td' }
    const blocks = new Set([...Object.keys(containers), 'P', 'THEAD', 'TBODY'])
    const markOf: Record<string, string> = { STRONG: 'b', B: 'b', EM: 'i', I: 'i', U: 'u', S: 's', CODE: 'code' }
    const out: string[] = []
    let space = false
    const edge = (t: string) => {
      space = false
      if (out.at(-1) !== t) out.push(t)
    }
    const walk = (node: Node, ctx: string, marks: string[], pre: boolean) => {
      const key = `${ctx}{${[...new Set(marks)].sort().join(',')}}`
      for (const child of node.childNodes) {
        if (child.nodeType === 3) {
          for (const ch of (child as Text).data) {
            if (!pre && /[ \t\n\r\f]/.test(ch)) {
              space = true
              continue
            }
            if (space && out.length > 0 && !['¶', '↵', '∅', 'HR'].includes(out.at(-1)!)) out.push(' ')
            space = false
            out.push(key + ch)
          }
          continue
        }
        if (child.nodeType !== 1) continue
        const el = child as Element
        const tag = el.tagName
        if (tag === 'COLGROUP') continue
        if (tag === 'BR') {
          if (pre) out.push(key + '\n')
          else edge('↵')
          continue
        }
        if (tag === 'HR') {
          edge('¶')
          edge('HR')
          edge('¶')
          continue
        }
        let next = marks
        if (markOf[tag] && !(pre && tag === 'CODE')) next = [...marks, markOf[tag]!]
        if (tag === 'A') next = [...next, `a(${el.getAttribute('href') ?? ''}|${el.getAttribute('title') ?? ''})`]
        if (!blocks.has(tag)) {
          walk(el, ctx, next, pre)
          continue
        }
        edge('¶')
        const before = out.length
        walk(el, containers[tag] ? `${ctx}/${containers[tag]}` : ctx, next, pre || tag === 'PRE')
        const hasBlockChild = [...el.children].some((c) => blocks.has(c.tagName) || c.tagName === 'HR')
        const leaf = ['P', 'H2', 'H3', 'H4', 'PRE'].includes(tag) || (['LI', 'TD', 'TH', 'BLOCKQUOTE'].includes(tag) && !hasBlockChild)
        if (leaf && out.slice(before).every((t) => t === '¶')) edge('∅')
        edge('¶')
      }
    }
    walk(new DOMParser().parseFromString(`<!doctype html><body>${source}</body>`, 'text/html').body, '', [], false)
    while (out.at(-1) === '¶') out.pop()
    while (out[0] === '¶') out.shift()
    return out.join('\u0000')
  }, html)
}

/** 白名單裡的格式組合（Review 反例在前兩段）。最後一段「尾」留給測試在編輯器裡補字。 */
const COMBOS = [
  '<p>見<a href="/rules"><code>規則</code></a>，<code><a href="https://example.com/c">碼連結</a></code>。</p>',
  '<p><strong><code>粗碼</code></strong><b><code>b碼</code></b><em><code>斜碼</code></em><i><code>i碼</code></i><u><code>底碼</code></u><s><code>刪碼</code></s><code><strong><em><u><s>全碼</s></u></em></strong></code></p>',
  '<pre><code>區塊 <strong>粗</strong> <em>斜</em> <u>底</u> <s>刪</s> <a href="https://example.com/p" title="區">連</a>\n  第二行  縮排</code></pre>',
  '<pre>沒有 code<br>換行</pre>',
  '<p><strong><em>甲</em></strong><strong><u>乙</u></strong><strong><s>丙</s></strong><em><u>丁</u></em><em><s>戊</s></em><u><s>己</s></u><strong><em><u><s>庚</s></u></em></strong></p>',
  '<p><a href="https://example.com" title="示例"><strong>連粗</strong><em>連斜</em><u>連底</u><s>連刪</s></a><strong><a href="mailto:a@example.com">信</a></strong><a href="#top">錨</a></p>',
  '<h2><strong>二</strong></h2><h3><em>三</em><a href="/x">連</a></h3><h4><code>四</code><br>換行</h4>',
  '<p>a<br>b<br><br>c</p><p></p>',
  '<ul><li>項<strong>粗</strong></li><li><p>段一</p><p>段二</p></li><li>巢<ul><li>子</li></ul><ol><li>編</li></ol></li><li>引<blockquote><p>q</p></blockquote><pre><code>c</code></pre></li><li></li></ul>',
  '<blockquote>直接文字</blockquote><blockquote><h2>引標</h2><p>外</p><blockquote><p>內</p></blockquote><ul><li>引清單</li></ul></blockquote>',
  '<hr>',
  '<table><thead><tr><th>甲</th><th>乙</th></tr></thead><tbody><tr><td><strong>a</strong><a href="/x">l</a></td><td>x<br>y</td></tr><tr><td><ul><li>i</li></ul></td><td><code>c</code></td></tr><tr><td></td><td>空左</td></tr></tbody></table>',
  '<p>尾</p>',
].join('')

/** 存好的正文去掉伺服器加的 target／rel（指紋本來就不看，留著只是讓失敗訊息好讀）。 */
const plain = (html: string) => html.replaceAll(' target="_blank" rel="noopener noreferrer nofollow"', '')

test('白名單格式組合：所見即所得讀進來、在別處補字、存檔與發布後，每個字的區塊與格式都不變（A-R6、AC-A-49）', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await asAdmin(page)
  await page.goto(`/dashboard/admin/editor/new?cohort=${cohortId}`)
  const title = `格式組合-${stamp}`
  await page.locator('#ed-title').fill(title)
  await (await rawHtml(page)).fill(COMBOS)

  const editor = await richMode(page)
  await expect(page.getByText('無法原樣保留')).toHaveCount(0)
  // Review 反例：連結包行內程式碼、粗體包程式碼、程式碼區塊裡的粗體與連結，在編輯器裡就看得到。
  await expect(editor.locator('a[href="/rules"] code, code a[href="/rules"]')).toHaveText('規則')
  await expect(editor.locator('strong code, code strong').first()).toContainText('粗碼')
  await expect(editor.locator('pre strong')).toHaveText('粗')
  await expect(editor.locator('pre a')).toHaveAttribute('href', 'https://example.com/p')

  // 在別處（最後一段）補一個字，讓整份正文改由 Tiptap 輸出。
  await editor.locator('p', { hasText: '尾' }).last().click()
  await page.keyboard.press('End')
  await page.keyboard.type('。')
  const expected = await signatureIn(page, COMBOS.replace('<p>尾</p>', '<p>尾。</p>'))

  const serialized = await (await rawHtml(page)).inputValue()
  expect(await signatureIn(page, serialized), `Tiptap 輸出：${serialized}`).toBe(expected)

  await saveDraft(page)
  const { id, body } = await bodyOf(title)
  expect(await signatureIn(page, body), `資料庫正文：${plain(body)}`).toBe(expected)
  expect(body).toMatch(/<a [^>]*href="\/rules"[^>]*><code>規則<\/code><\/a>/)

  // 重新打開：留在所見即所得（不會被判成無法保留）。
  await page.goto(`/dashboard/admin/editor/${id}`)
  await expect(page.locator('#ed-body[contenteditable="true"]')).toBeVisible()
  await publishPublic(page)
  await page.goto(`/news/${id}`)
  const front = page.locator('.prose-item')
  expect(await signatureIn(page, await front.innerHTML()), '前台正文').toBe(expected)
  await expect(front.locator('a[href="/rules"] code')).toHaveText('規則')
  await expect(front.locator('pre strong')).toHaveText('粗')
  await expect(front.locator('pre a[title="區"]')).toHaveAttribute('href', 'https://example.com/p')
})

test('Tiptap 無法原樣保留的正文：自動留在原始 HTML 並說明，存檔後正文不變（A-R6）', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await asAdmin(page)
  await page.goto(`/dashboard/admin/editor/new?cohort=${cohortId}`)
  const title = `無法保留-${stamp}`
  await page.locator('#ed-title').fill(title)
  const source = '<ul><li><ul><li>子清單開頭</li></ul></li></ul><p><a title="只有標題">無網址</a></p>'
  const area = await rawHtml(page)
  await area.fill(source)

  const notice = page.getByRole('status').filter({ hasText: '無法原樣保留' })
  await page.getByRole('group', { name: '正文編輯方式' }).getByRole('button', { name: '所見即所得' }).click()
  await expect(notice).toBeVisible()
  await expect(page.locator('textarea#ed-body')).toHaveValue(source)
  await expect(page.locator('#ed-body[contenteditable="true"]')).toHaveCount(0)

  await saveDraft(page)
  const { id, body } = await bodyOf(title)
  expect(plain(body)).toBe(source)

  // 既有正文重新打開：一開始就是原始 HTML 加說明。
  await page.goto(`/dashboard/admin/editor/${id}`)
  await expect(notice).toBeVisible()
  await expect(page.locator('textarea#ed-body')).toHaveValue(body)
})
