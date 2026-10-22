import { expect, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { sanitizeBody } from '../src/application/items/rich-text'
import { formReady } from './create-item'
import { rawHtml, richMode } from './item-body'
import { sharedTestSession, toPlaywrightCookie } from './session'

/**
 * 系辦共用表單右欄的「即時預覽：學生看到的樣子」（AD-16、AC-AD-28；C1-06 起搬進一頁式表單 `ItemForm`，AC-3）：
 *
 * 1. 正文停手後渲染伺服器淨化後的正文（粗體在），不必先填標題（標題空著時預覽寫「（未命名）」）；
 *    正文裡的 `<script>`、`onerror` 不執行，也不出現原字。
 * 2. 寬螢幕預覽在正文右側；手機寬在正文下方（一欄）。
 * 3. 預覽連線中斷：寫原因、清掉上一版預覽。
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

/** 右欄即時預覽的正文區（伺服器淨化後的版本）。 */
function previewBody(page: Page) {
  return page.getByRole('region', { name: '即時預覽：學生看到的樣子' }).getByTestId('body-preview')
}

test('即時預覽：只渲染淨化後的正文（不用先填標題）、腳本不執行、標題跟著變；寬螢幕在正文右側', async ({ page }) => {
  const alerts: string[] = []
  page.on('dialog', async (d) => {
    alerts.push(d.message())
    await d.dismiss()
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await asAdmin(page)
  await page.goto(`/dashboard/admin/editor/new?cohort=${cohortId}`)
  await formReady(page)

  const pane = previewBody(page)
  await rawHtml(page)
  const body = page.getByLabel('正文（網頁排版格式，可直接打字）', { exact: true })
  await expect(body).toBeVisible()
  await expect(page.getByRole('main').getByRole('link', { name: '公告與作業', exact: true })).toHaveAttribute(
    'href',
    `/dashboard/admin/affairs?cohort=${cohortId}&placement=all`,
  )

  // 一開始：正文空的。標題還沒填也照樣渲染正文（預覽標題寫「（未命名）」）。
  await expect(pane).toContainText('正文還是空的。')
  await body.fill('<p>期中<strong>報告</strong></p>')
  await expect(pane.locator('strong')).toHaveText('報告')
  await expect(page.getByTestId('preview-title')).toHaveText('（未命名）')

  // 1440 寬：預覽在正文右側。
  const bodyBox = (await body.boundingBox())!
  const paneBox = (await pane.boundingBox())!
  expect(paneBox.x).toBeGreaterThanOrEqual(bodyBox.x + bodyBox.width)

  await page.locator('#ed-title').fill('期中報告說明')
  await expect(page.getByTestId('preview-title')).toHaveText('期中報告說明')

  // 含 <script> 與 onerror：不執行、不出現原字。
  await body.fill('<p>第二版<strong>報告</strong></p><script>window.__ad16=1;alert(1)</script><img src=x onerror="window.__ad16=2;alert(2)">')
  await expect(pane).toContainText('第二版')
  await expect(pane).not.toContainText('<script')
  await expect(pane).not.toContainText('__ad16')
  expect(await pane.innerHTML()).not.toMatch(/<script|onerror/i)
  expect(await page.evaluate(() => (window as unknown as { __ad16?: number }).__ad16)).toBeUndefined()
  expect(alerts, '正文裡的腳本不能執行').toEqual([])
})

test('手機寬：預覽在正文下方（一欄）', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await asAdmin(page)
  await page.goto(`/dashboard/admin/editor/new?cohort=${cohortId}`)
  await formReady(page)
  await page.locator('#ed-title').fill('手機預覽')
  await (await rawHtml(page)).fill('<p>手機<strong>看得到</strong></p>')

  const pane = previewBody(page)
  await expect(pane.locator('strong')).toHaveText('看得到')
  const bodyBox = (await page.locator('#ed-body').boundingBox())!
  const paneBox = (await pane.boundingBox())!
  expect(paneBox.y).toBeGreaterThanOrEqual(bodyBox.y + bodyBox.height)
})

test('成功預覽後連線中斷：預覽寫原因、清掉舊預覽', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await asAdmin(page)
  await page.goto(`/dashboard/admin/editor/new?cohort=${cohortId}`)
  await formReady(page)
  await page.locator('#ed-title').fill('斷線預覽')
  const area = await rawHtml(page)
  await area.fill('<p>斷線前<strong>看得到</strong></p>')
  const pane = previewBody(page)
  await expect(pane.locator('strong')).toHaveText('看得到')

  // 之後的 Server Action 都斷線（頁面不重新載入）；再改一次正文，停手後重問就斷線。
  await page.route('**/dashboard/admin/editor/new**', (route) =>
    route.request().method() === 'POST' && route.request().headers()['next-action'] ? route.abort('failed') : route.continue(),
  )
  await area.fill('<p>斷線後<strong>看不到</strong></p>')
  await expect(pane).toContainText('預覽連線中斷；停手後會再試一次。')
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

/** 「儲存（先不發布）」並等到這一次真的存好（表單的 `data-revision` 變了）。 */
async function saveDraft(page: Page) {
  const form = await formReady(page)
  const before = await form.getAttribute('data-revision')
  await form.getByRole('button', { name: '儲存（先不發布）', exact: true }).click()
  await expect(form).not.toHaveAttribute('data-revision', before ?? '')
  await expect(page.getByRole('status').filter({ hasText: '已存成草稿' })).toBeVisible()
}

/** 發布（公開）：發布成功回到清單（C1-06 共用表單）。 */
async function publishPublic(page: Page) {
  const form = await formReady(page)
  await form.getByLabel('誰看得到').selectOption('public')
  await form.getByRole('button', { name: '發布', exact: true }).click()
  await expect(page).toHaveURL(/\/dashboard\/admin\/affairs\?/)
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
  const pane = previewBody(page)
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

/** 固定的規格例子；expected 只明列容許的 HTML 正規化，不呼叫產品的 canon 當 oracle。 */
type RoundTripCase = { name: string; html: string; expected?: string; rich?: boolean }
const ROUND_TRIPS: RoundTripCase[] = [
  { name: 'p', html: '<p>段落</p>', rich: true },
  { name: 'br', html: '<p>甲<br>乙<br><br>丙</p>', rich: true },
  ...['strong', 'b', 'em', 'i', 'u', 's', 'code'].map((tag) => ({
    name: tag, html: `<p><${tag}>格式</${tag}></p>`,
    expected: `<p><${({ b: 'strong', i: 'em' } as Record<string, string>)[tag] ?? tag}>格式</${({ b: 'strong', i: 'em' } as Record<string, string>)[tag] ?? tag}></p>`, rich: true,
  })),
  ...['ul', 'ol'].map((tag) => ({ name: tag, html: `<${tag}><li>項目</li></${tag}>`, expected: `<${tag}><li><p>項目</p></li></${tag}>`, rich: true })),
  { name: 'li', html: '<ul><li>一</li><li>二</li></ul>', expected: '<ul><li><p>一</p></li><li><p>二</p></li></ul>', rich: true },
  ...['h2', 'h3', 'h4'].map((tag) => ({ name: tag, html: `<${tag}>標題</${tag}>`, rich: true })),
  { name: 'blockquote', html: '<blockquote>引言</blockquote>', expected: '<blockquote><p>引言</p></blockquote>', rich: true },
  { name: 'a', html: '<p><a href="/rules" title="規則">連結</a></p>', rich: true },
  { name: 'hr', html: '<hr><hr>', rich: true },
  { name: 'pre', html: '<pre>程式<br>  縮排</pre>', expected: '<pre><code>程式\n  縮排</code></pre>', rich: true },
  ...['table', 'thead', 'tbody', 'tr', 'th', 'td'].map((tag) => ({
    name: tag,
    html: `<table>${tag === 'thead' ? '<thead>' : '<tbody>'}<tr><th>欄</th><td>格</td></tr>${tag === 'thead' ? '</thead>' : '</tbody>'}</table>`,
    expected: '<table><tbody><tr><th><p>欄</p></th><td><p>格</p></td></tr></tbody></table>', rich: true,
  })),
  { name: 'a.href missing', html: '<p><a>無網址</a></p>', rich: false },
  { name: 'a.href empty', html: '<p><a href="">空網址</a></p>', rich: false },
  ...['https://example.com/a?x=1&y=2', 'http://example.com', 'mailto:a@example.com', '/rules', '#top', '?q=x', 'relative/path'].map((href) => ({
    name: `a.href ${href}`, html: `<p><a href="${href}">網址</a></p>`, rich: true,
  })),
  { name: 'a.title missing', html: '<p><a href="/rules">無標題</a></p>', rich: true },
  { name: 'a.title empty', html: '<p><a href="/rules" title="">空標題</a></p>', rich: true },
  { name: 'a.title punctuation', html: '<p><a href="/rules" title="甲 &amp; &quot;乙&quot; &lt;丙&gt; | 丁">標題</a></p>', rich: true },
  { name: 'a.target', html: '<p><a href="/rules" target="_self">開啟位置</a></p>', rich: true },
  { name: 'a.rel', html: '<p><a href="/rules" rel="opener">連結關係</a></p>', rich: true },
  ...['javascript:alert(1)', 'data:text/html,x', '//example.com', 'java&#9;script:alert(1)'].map((href) => ({
    name: `a.href forbidden ${href}`, html: `<p><a href="${href}">不安全網址</a></p>`, rich: false,
  })),
  ...['strong', 'em', 'u', 's', 'a'].flatMap((tag) => {
    const open = tag === 'a' ? '<a href="/rules" title="r1">' : `<${tag}>`
    return [
      { name: `r1 ${tag}/code`, html: `<p>${open}<code>行內碼</code></${tag}></p>`, rich: true },
      { name: `r1 pre/${tag}`, html: `<pre><code>${open}區塊碼</${tag}></code></pre>`, rich: true },
    ]
  }),
  { name: 'adjacent aliases', html: '<p><strong>甲</strong><b>乙</b><em>丙</em><i>丁</i></p>', expected: '<p><strong>甲</strong><strong>乙</strong><em>丙</em><em>丁</em></p>', rich: true },
  { name: 'nested duplicate marks', html: '<p><strong><strong>雙層</strong></strong></p>', rich: false },
  { name: 'paragraph boundaries', html: '<p>甲</p><p></p><p>乙</p>', rich: true },
  { name: 'partial pre/code', html: '<pre>甲<code>乙</code>丙</pre>', rich: false },
  { name: 'double pre/code', html: '<pre><code><code>雙層碼</code></code></pre>', rich: false },
  { name: 'list first child is list', html: '<ul><li><ul><li>子清單</li></ul></li></ul>', rich: false },
  { name: 'empty tbody first', html: '<table><tbody></tbody><tbody><tr><td>格</td></tr></tbody></table>', rich: false },
  { name: 'empty tbody last', html: '<table><tbody><tr><td>格</td></tr></tbody><tbody></tbody></table>', rich: false },
  { name: 'empty thead', html: '<table><thead></thead><tbody><tr><td>格</td></tr></tbody></table>', rich: false },
  { name: 'thead after tbody', html: '<table><tbody><tr><td>內文</td></tr></tbody><thead><tr><th>表頭</th></tr></thead></table>', rich: false },
  ...['thead', 'tbody', 'tr', 'th', 'td', 'li'].map((tag) => ({ name: `orphan ${tag}`, html: `<${tag}>游離元素</${tag}>`, rich: false })),
  ...['p', 'strong', 'b', 'em', 'i', 'u', 's', 'ul', 'ol', 'li', 'h2', 'h3', 'h4', 'blockquote', 'a', 'code', 'pre', 'table', 'thead', 'tbody', 'tr', 'th', 'td'].map((tag) => ({
    name: `empty ${tag}`, html: `<${tag}></${tag}>`,
    expected: tag === 'blockquote' ? '<blockquote><p></p></blockquote>' : tag === 'pre' ? '<pre><code></code></pre>' : undefined,
    // 空元素也必須保留；如果 Tiptap 不支援，留在 HTML 即可。
    rich: ['thead', 'tbody', 'tr', 'th', 'td', 'li'].includes(tag) ? false : undefined,
  })),
  { name: 'template', html: '<template><p>模板正文</p></template>', expected: '<p>模板正文</p>', rich: false },
  { name: 'title', html: '<title>標題正文</title>', expected: '<p>標題正文</p>', rich: false },
  { name: 'head/title', html: '<head><title>文件標題</title></head>', expected: '<p>文件標題</p>', rich: false },
  { name: 'colgroup text', html: '<colgroup>欄群正文</colgroup>', expected: '<p>欄群正文</p>' },
  { name: 'xmp text', html: '<xmp><b>原樣標籤</b></xmp>', expected: '<p>&lt;b&gt;原樣標籤&lt;/b&gt;</p>' },
  { name: 'span wrapper', html: '<p>甲<span>乙</span>丙</p>', expected: '<p>甲乙丙</p>', rich: true },
  ...['script', 'style', 'textarea', 'option', 'noscript', 'iframe', 'object', 'embed', 'svg', 'math'].map((tag) => ({
    name: `sanitizer removes ${tag}`, html: `<p>外前</p><${tag}>內文<strong>內格式</strong></${tag}><p>外後</p>`,
    expected: tag === 'embed' ? '<p>外前</p><p>內文<strong>內格式</strong></p><p>外後</p>' : '<p>外前</p><p>外後</p>',
  })),
]

/** 只排屬性順序；不去除元素、不合併文字或 marks。expected 的 p/code/tbody 由上表逐案明列。 */
async function htmlTreeIn(page: Page, html: string) {
  return page.evaluate((source) => {
    const root = document.createElement('template')
    root.innerHTML = source
    const walk = (node: Node): unknown => node.nodeType === Node.TEXT_NODE
      ? node.textContent
      : [
          (node as Element).tagName,
          [...(node as Element).attributes].map((a) => [a.name, a.value]).sort(([a], [b]) => a!.localeCompare(b!)),
          [...node.childNodes].map(walk),
        ]
    return [...root.content.childNodes].map(walk)
  }, html)
}

test('白名單逐項 round-trip：25 元素、4 屬性、r1/r2、空元素與 sanitizer 語意（A-R6）', async ({ page }) => {
  test.setTimeout(480_000)
  await asAdmin(page)
  const publicBodies: string[] = []
  const expectedBodies: string[] = []
  for (const [index, c] of ROUND_TRIPS.entries()) {
    await test.step(c.name, async () => {
      await page.goto(`/dashboard/admin/editor/new?cohort=${cohortId}`)
      const title = `矩陣-${index}-${stamp}`
      await page.locator('#ed-title').fill(title)
      const source = `<p>前</p>${c.html}<p>尾</p>`
      await (await rawHtml(page)).fill(source)
      await page.getByRole('button', { name: '所見即所得', exact: true }).click()
      const area = page.locator('textarea#ed-body')
      const editor = page.locator('#ed-body[contenteditable="true"]')
      await expect.poll(async () => (await area.isVisible()) || (await editor.isVisible())).toBe(true)
      const rich = await editor.isVisible()
      if (c.rich !== undefined) expect.soft(rich, `${c.name}: mode`).toBe(c.rich)
      let expected: string
      if (rich) {
        await editor.locator('p', { hasText: '尾' }).last().click()
        await page.keyboard.press('End')
        await page.keyboard.type('。')
        expected = sanitizeBody(`<p>前</p>${c.expected ?? c.html}<p>尾。</p>`)
      } else {
        await expect(page.getByRole('status').filter({ hasText: '無法原樣保留' })).toBeVisible()
        await expect(area).toHaveValue(source)
        await area.fill(source.replace('<p>尾</p>', '<p>尾。</p>'))
        expected = sanitizeBody(source.replace('<p>尾</p>', '<p>尾。</p>'))
      }
      await saveDraft(page)
      const saved = await bodyOf(title)
      if (rich) {
        expect.soft(await htmlTreeIn(page, saved.body), `${c.name}: stored`).toEqual(await htmlTreeIn(page, expected))
        // 即使 browser 會修復游離元素，也不能把 Tiptap 丟元素當無損。
        if (c.rich === false) expect.soft(saved.body, `${c.name}: lossy conversion`).toBe(expected)
      } else expect.soft(saved.body, `${c.name}: stored raw`).toBe(expected)
      // 再載入既有正文並在別處補字，確實觸發重寫；只存未編輯的正文抓不到載入時的漏攔。
      await page.goto(`/dashboard/admin/editor/${saved.id}`)
      await expect.poll(async () => (await area.isVisible()) || (await editor.isVisible())).toBe(true)
      const reopened = await editor.isVisible() ? 'rich' : 'html'
      if (reopened === 'rich') {
        await editor.locator('p', { hasText: '尾。' }).last().click()
        await page.keyboard.press('End')
        await page.keyboard.type('?')
        expected = sanitizeBody(`<p>前</p>${c.expected ?? c.html}<p>尾。?</p>`)
      } else {
        await expect(area).toHaveValue(saved.body)
        await area.fill(saved.body.replace('<p>尾。</p>', '<p>尾。?</p>'))
        expected = expected.replace('<p>尾。</p>', '<p>尾。?</p>')
      }
      await saveDraft(page)
      const afterReopen = (await bodyOf(title)).body
      if (reopened === 'rich') expect.soft(await htmlTreeIn(page, afterReopen), `${c.name}: reopen/edit/save`).toEqual(await htmlTreeIn(page, expected))
      else expect.soft(afterReopen, `${c.name}: reopen/edit/save`).toBe(expected)
      publicBodies.push(afterReopen)
      expectedBodies.push(expected)
      console.log(`ROUNDTRIP ${c.name}: switch=${rich ? 'rich' : 'html'} reopen=${reopened} checked`)
    })
  }
  // 公開輸出仍由真正的前台 sanitizer 處理；整張表的固定預期一起核對。
  await page.goto(`/dashboard/admin/editor/new?cohort=${cohortId}`)
  const title = `矩陣前台-${stamp}`
  await page.locator('#ed-title').fill(title)
  const expected = expectedBodies.join('')
  await (await rawHtml(page)).fill(publicBodies.join(''))
  await publishPublic(page)
  const saved = await bodyOf(title)
  await page.context().clearCookies()
  await page.goto(`/news/${saved.id}`)
  expect(await htmlTreeIn(page, await page.locator('.prose-item').innerHTML())).toEqual(await htmlTreeIn(page, expected))
})

test('R2：無網址連結與 template/title 文字不得在切換、編輯、存檔或重開時消失', async ({ page }) => {
  await asAdmin(page)
  const cases = [
    { name: 'a-no-href', html: '<p><a>無網址</a></p>', retained: '<a target="_blank" rel="noopener noreferrer nofollow">無網址</a>' },
    { name: 'a-empty-href', html: '<p><a href="">空網址</a></p>', retained: '<a target="_blank" rel="noopener noreferrer nofollow">空網址</a>' },
    { name: 'template', html: '<template><p>模板正文</p></template>', retained: '<p>模板正文</p>' },
    { name: 'title', html: '<title>標題正文</title>', retained: '標題正文' },
  ]
  for (const c of cases) {
    await test.step(c.name, async () => {
      await page.goto(`/dashboard/admin/editor/new?cohort=${cohortId}`)
      const title = `R2-${c.name}-${stamp}`
      await page.locator('#ed-title').fill(title)
      const source = `<p>前</p>${c.html}<p>尾</p>`
      await (await rawHtml(page)).fill(source)
      await page.getByRole('button', { name: '所見即所得', exact: true }).click()
      // Soft assertions let the old head demonstrate every counterexample in one run.
      await expect.soft(page.getByRole('status').filter({ hasText: '無法原樣保留' }), c.name).toBeVisible({ timeout: 1500 })
      const area = page.locator('textarea#ed-body')
      const rich = page.locator('#ed-body[contenteditable="true"]')
      if (await area.isVisible()) {
        await expect(area).toHaveValue(source)
        await area.fill(source.replace('<p>尾</p>', '<p>尾。</p>'))
      } else {
        await rich.locator('p').last().click()
        await page.keyboard.press('End')
        await page.keyboard.type('。')
      }
      await saveDraft(page)
      const saved = await bodyOf(title)
      console.log(`R2 ${c.name}: ${saved.body}`)
      expect.soft(saved.body, c.name).toContain(c.retained)
      await page.goto(`/dashboard/admin/editor/${saved.id}`)
      if (c.name.startsWith('a-')) {
        await expect.soft(page.locator('textarea#ed-body'), `${c.name} reopen`).toHaveValue(saved.body, { timeout: 1500 })
      } else {
        await expect.soft(page.locator('#ed-body'), `${c.name} reopen`).toContainText(c.name === 'template' ? '模板正文' : '標題正文')
      }
    })
  }
})

test('保留檢查的 XSS 回歸：切換與存檔、匿名前台、直接污染 DB 都不得執行 payload', async ({ page }) => {
  await asAdmin(page)
  await page.goto(`/dashboard/admin/editor/new?cohort=${cohortId}`)
  const title = `保留檢查XSS-${stamp}`
  await page.locator('#ed-title').fill(title)
  const payload = '<p style="position:fixed" onclick="window.__a10xss=1">安全正文</p>' +
    '<script>window.__a10xss=2</script><img src=x onerror="window.__a10xss=3">' +
    '<a href="javascript:window.__a10xss=4">JS</a><a href="data:text/html,x">DATA</a>' +
    '<iframe srcdoc="<script>parent.__a10xss=5</script>"></iframe><style>body{display:none}</style>' +
    '<p><code><a href="javascript:window.__a10xss=6">碼連結</a></code></p>' +
    '<pre><code><a href="java&#9;script:window.__a10xss=7">區塊連結</a></code></pre>' +
    '<template><p onclick="window.__a10xss=8">模板文字</p></template><a href="https://example.com">安全連結</a>'
  const unsafe = /<script|<iframe|<img|<style|\son\w+=|\sstyle=|javascript:|data:|__a10xss/i
  const marker = () => page.evaluate(() => (window as unknown as { __a10xss?: number }).__a10xss)
  await (await rawHtml(page)).fill(payload)
  await page.getByRole('button', { name: '所見即所得', exact: true }).click()
  await expect(page.locator('textarea#ed-body')).toHaveValue(payload)
  await expect(page.getByRole('status').filter({ hasText: '無法原樣保留' })).toBeVisible()
  expect(await marker()).toBeUndefined()
  await saveDraft(page)
  const saved = await bodyOf(title)
  expect(saved.body).not.toMatch(unsafe)
  expect(saved.body).toContain('模板文字')
  await publishPublic(page)
  await page.context().clearCookies()
  const response = await page.goto(`/news?q=${encodeURIComponent(title)}`)
  expect(response!.headers()['content-security-policy']).not.toContain("'unsafe-inline'")
  await expect(page.getByTestId('news-card').filter({ hasText: title })).toBeVisible()
  expect(await marker()).toBeUndefined()
  await page.goto(`/news/${saved.id}`)
  const front = page.locator('.prose-item')
  await expect(front).toContainText('安全正文')
  expect(await front.innerHTML()).not.toMatch(unsafe)
  expect(await marker()).toBeUndefined()
  await pool.query('update managed_items set body_html=$1 where id=$2', [payload, saved.id])
  await page.reload()
  expect(await front.innerHTML()).not.toMatch(unsafe)
  await expect(front).toContainText('模板文字')
  expect(await marker()).toBeUndefined()
  console.log('XSS: switch/save, anonymous list/detail and poisoned DB output passed')
})
