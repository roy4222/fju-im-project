import { expect, type Locator, type Page } from '@playwright/test'

/**
 * 系辦編輯器的正文欄（AD-B5，設計方案 §8.2）：預設所見即所得（Tiptap，動態載入的 contenteditable），
 * 「原始 HTML」切成 textarea。兩種模式的輸入區都是 `#ed-body`、都以「正文」標題為名稱，同一時間只有一個在畫面上。
 *
 * 不要用 `getByLabel('正文')`：Tiptap 還沒載入時它只對到「正文編輯方式」那組按鈕，填不進去。
 */

const BODY_NAME = '正文（網頁排版格式，可直接打字）'

/** 目前模式的正文輸入區（textarea 或 contenteditable）。 */
export function itemBody(page: Page): Locator {
  return page.getByRole('textbox', { name: BODY_NAME, exact: true })
}

/** 用目前模式填正文（純文字）：所見即所得就在編輯區打字，原始 HTML 就填 textarea。填完確認真的進去了。 */
export async function fillItemBody(page: Page, text: string) {
  const body = itemBody(page)
  await expect(body).toBeVisible()
  await body.fill(text)
  if ((await body.evaluate((el) => el.tagName)) === 'TEXTAREA') await expect(body).toHaveValue(text)
  else await expect(body).toHaveText(text)
}

/** 正文切到「原始 HTML」（textarea），回傳那個 textarea。 */
export async function rawHtml(page: Page) {
  await page.getByRole('group', { name: '正文編輯方式' }).getByRole('button', { name: '原始 HTML' }).click()
  const area = page.locator('textarea#ed-body')
  await expect(area).toBeVisible()
  return area
}

/** 正文切回所見即所得，回傳編輯區（contenteditable）。 */
export async function richMode(page: Page) {
  await page.getByRole('group', { name: '正文編輯方式' }).getByRole('button', { name: '所見即所得' }).click()
  const editor = page.locator('#ed-body[contenteditable="true"]')
  await expect(editor).toBeVisible()
  return editor
}
