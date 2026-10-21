import { expect, type Locator, type Page } from '@playwright/test'
import { fillItemBody, rawHtml } from './item-body'

/**
 * 系辦建立公告／作業／資源／規則／榮譽的共用步驟（C 階段規格① C1-06：一頁式共用表單 `ItemForm`）。
 *
 * 舊的三步驟精靈與「完整編輯器」都拿掉了，各 spec 的建立步驟一律走這裡：
 * - `createItemOnPage`：全頁 `/dashboard/admin/editor/new?placement=…`。先「儲存（先不發布）」拿到 id（網址換成 `/editor/<id>`），
 *   要發布就再按「發布」，成功後回到清單。
 * - `createItemInDialog`：那一類分頁右上「新增」→ 對話框裡的同一張表單 → 「發布」或「儲存（先不發布）」，對話框關掉（C1-07 起不先選類型）。
 *   專題規則沒有右上「新增」（CL-1）：改走清單底部「新增章節」的就地表單（`createRuleInline`）。
 *
 * 表單根元素有 `data-hydrated`（hydration 完才填，免得填進去的字被 hydration 洗掉）。
 */

export type NewItem = {
  /** 全頁時預選的位置（網址 `?placement=`）；對話框時用 `kind` 選類型。 */
  placement?: 'news' | 'resource' | 'submission' | 'rules' | 'honor'
  title: string
  body?: string
  /** 正文用「原始 HTML」直接填（要測淨化、清單、引用時）。 */
  html?: string
  /** 「對象（誰看得到）」的值：`public`、`signed_in`、`cohort_students`、`teachers`、`groups`。 */
  audience?: string
  /** 指定組別要勾的組（組代號）。 */
  groups?: readonly string[]
  /** 作業的繳交方式。 */
  unit?: '個人一份' | '整組一份'
  /** `datetime-local` 的臺灣時間。 */
  opensAt?: string
  dueAt?: string
  /** 附件（PDF）。 */
  file?: { name: string; buffer: Buffer; mimeType?: string }
  /** 進階設定：公告／資源的「重要公告」要不要勾（不給就照預設）。 */
  important?: boolean
  /** 進階設定：分類、摘要、榮譽的得獎日期。 */
  category?: string
  summary?: string
  awardedOn?: string
  /** 作業：先把預設的檔案欄刪掉、改加這些型別（`要新增的欄位類型` 的值）。 */
  fieldTypes?: readonly string[]
  /** `false`＝只按「儲存（先不發布）」。 */
  publish?: boolean
}

/** 等表單 hydration 完成。 */
export async function formReady(scope: Page | Locator): Promise<Locator> {
  const form = scope.locator('[data-testid="item-form"][data-hydrated]')
  await expect(form).toBeVisible()
  return form
}

/** 打開進階設定（折疊，預設收）。 */
export async function openAdvanced(form: Locator) {
  const details = form.getByTestId('advanced-settings')
  if ((await details.getAttribute('open')) === null) await details.locator('summary').first().click()
  await expect(details).toHaveAttribute('open', '')
}

/** 依 `item` 填表單（不按送出）。 */
export async function fillItemForm(page: Page, form: Locator, item: NewItem) {
  if (item.audience) {
    const audience = form.getByLabel('對象（誰看得到）')
    // 規則、榮譽固定公開訪客（選單鎖住）：只確認是那個值。
    if (await audience.isDisabled()) await expect(audience).toHaveValue(item.audience)
    else await audience.selectOption(item.audience)
  }
  for (const code of item.groups ?? []) await form.getByRole('checkbox', { name: new RegExp(`^${code}（`) }).check()
  if (item.unit) await form.getByRole('radio', { name: item.unit, exact: true }).check()
  if (item.opensAt) await form.getByLabel('開放時間（選填）').fill(item.opensAt)
  if (item.dueAt) await form.getByLabel('截止時間（臺灣時間，含這一分鐘）').fill(item.dueAt)
  await form.getByLabel('標題', { exact: true }).fill(item.title)
  if (item.body !== undefined) await fillItemBody(page, item.body)
  if (item.html !== undefined) await (await rawHtml(page)).fill(item.html)
  if (item.file) {
    await form.getByLabel('加入附件').setInputFiles({ name: item.file.name, mimeType: item.file.mimeType ?? 'application/pdf', buffer: item.file.buffer })
    await expect(form.getByRole('list', { name: '附件' }).getByRole('link', { name: item.file.name })).toBeVisible()
  }
  if (item.fieldTypes) {
    const fields = form.locator('section[aria-labelledby="sec-fields"]')
    while ((await fields.locator('li[data-field-type]').count()) > 0) {
      await fields.locator('li[data-field-type]').first().getByRole('button', { name: /^刪除 / }).click()
    }
    for (const type of item.fieldTypes) {
      await form.getByLabel('要新增的欄位類型').selectOption(type)
      await form.getByRole('button', { name: '新增欄位' }).click()
    }
  }
  if (item.important !== undefined || item.category !== undefined || item.summary !== undefined || item.awardedOn !== undefined) {
    await openAdvanced(form)
    if (item.summary !== undefined) await form.getByLabel('摘要', { exact: false }).fill(item.summary)
    if (item.category !== undefined) await form.locator('#ed-category').fill(item.category)
    if (item.awardedOn !== undefined) await form.getByLabel(/得獎日期/).fill(item.awardedOn)
    if (item.important !== undefined) {
      const important = form.getByRole('checkbox', { name: /重要公告/ })
      // 預設值要等即時預覽算出會通知幾人才定，先等那一句出來再改。
      await expect(important.locator('xpath=..')).toContainText('勾選後將通知')
      await important.setChecked(item.important)
    }
  }
}

/** 全頁新增：回傳項目 ID。 */
export async function createItemOnPage(page: Page, cohortId: string, item: NewItem): Promise<string> {
  // 位置用網址預選（`?placement=`）：作業會帶預設的檔案欄，榮譽可以選封存屆別。
  await page.goto(`/dashboard/admin/editor/new?cohort=${cohortId}&placement=${item.placement ?? 'news'}`)
  const form = await formReady(page)
  await fillItemForm(page, form, item)
  await form.getByRole('button', { name: '儲存（先不發布）' }).click()
  await expect(page.getByRole('status').filter({ hasText: '已存成草稿' })).toBeVisible()
  await expect(page).toHaveURL(/\/dashboard\/admin\/editor\/[0-9a-f-]{36}$/)
  const itemId = page.url().split('/').pop()!
  if (item.publish !== false) {
    await form.getByRole('button', { name: '發布', exact: true }).click()
    await expect(page).toHaveURL(/\/dashboard\/admin\/affairs\?/)
  }
  return itemId
}

/** 類型卡片的名稱 → 哪個分頁、新增鈕與對話框叫什麼（C1-07：各分頁的「新增」直接開那一類，不再先選類型）。 */
const TABS: readonly { label: string; path: string; button: string }[] = [
  { label: '公告', path: '/dashboard/admin/affairs', button: '新增公告' },
  { label: '資源下載', path: '/dashboard/admin/affairs/resources', button: '新增資源' },
]

/**
 * 專題規則分頁底部「新增章節」→ 就地展開的同一張表單（layout `inline`：沒有對象欄，規則固定公開）→ 送出，卡片收起、回饋句出現。
 * 呼叫前要已經在 `/dashboard/admin/affairs/rules?cohort=…`。
 */
export async function createRuleInline(page: Page, item: NewItem): Promise<void> {
  await page.getByRole('button', { name: '新增章節' }).click()
  const card = page.getByTestId('rule-new-card')
  const form = await formReady(card)
  await fillItemForm(page, form, { ...item, audience: undefined })
  if (item.publish === false) await form.getByRole('button', { name: '儲存（先不發布）' }).click()
  else await form.getByRole('button', { name: '發布', exact: true }).click()
  await expect(card).toBeHidden()
  await expect(page.getByTestId('pin-feedback')).toHaveText(item.publish === false ? '已儲存' : '已發布')
}

/**
 * 清單頁的「新增」：到那一類的分頁按「新增」→ 對話框表單 → 送出。對話框關掉、清單刷新。
 * `kind` 是類型的名稱（例：`/公告/`、`/專題規則/`、`/資源下載/`）；屆別取目前網址的 `?cohort=`。
 * 榮譽（`/榮譽／競賽/`）在 C1-09 搬到成果展示前沒有對話框入口，走全頁表單（`createItemOnPage`），回到清單看提示。
 */
export async function createItemInDialog(
  page: Page,
  item: NewItem & { kind?: string | RegExp },
  button: string | RegExp = '新增公告',
): Promise<void> {
  const cohortId = new URL(page.url()).searchParams.get('cohort') ?? ''
  const matches = (label: string) => (item.kind instanceof RegExp ? item.kind.test(label) : item.kind === label)
  if (item.kind && matches('榮譽／競賽')) {
    await createItemOnPage(page, cohortId, { ...item, placement: 'honor' })
    return
  }
  if (item.kind && matches('專題規則')) {
    await page.goto(`/dashboard/admin/affairs/rules?cohort=${cohortId}`)
    await createRuleInline(page, item)
    return
  }
  const tab = item.kind ? TABS.find((t) => matches(t.label)) : undefined
  if (tab) await page.goto(`${tab.path}?cohort=${cohortId}`)
  const name = tab?.button ?? button
  await page.getByRole('button', { name }).click()
  const dialog = page.getByRole('dialog', { name })
  const form = await formReady(dialog)
  await fillItemForm(page, form, item)
  if (item.publish === false) await form.getByRole('button', { name: '儲存（先不發布）' }).click()
  else await form.getByRole('button', { name: '發布', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByTestId('item-toast')).toHaveText(item.publish === false ? '已儲存' : '已發布')
}
