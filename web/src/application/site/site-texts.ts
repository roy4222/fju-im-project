/**
 * 站內文字（C 階段規格② 設計方案 §6.5；C2-17）：系辦可在前台直接改的頁尾聯絡、三張快速入口卡、隱私權政策內文。
 *
 * 資料是 `site_texts` 一個 key 一列，`value` 是這裡定的 JSON 形狀；沒有列就用程式內預設
 * （預設值在 app 層：`site-contact.ts`、`page.tsx`、`privacy/page.tsx`，跟改版前寫死的字一字不差）。
 * 首頁橫幅不在這裡，沿用 `home-settings.ts`。
 *
 * 這個檔只有規則，沒有資料庫：key 清單、每種文字的欄位與字數上限、表單收斂、資料庫 JSON 的讀取。
 */

import { charLength } from '@/shared/text'

export const SITE_TEXT_KEYS = ['footer_contact', 'quick_card_1', 'quick_card_2', 'quick_card_3', 'privacy'] as const
export type SiteTextKey = (typeof SITE_TEXT_KEYS)[number]
export type QuickCardKey = Extract<SiteTextKey, `quick_card_${number}`>

export function isSiteTextKey(value: unknown): value is SiteTextKey {
  return typeof value === 'string' && (SITE_TEXT_KEYS as readonly string[]).includes(value)
}

/** 頁尾聯絡資料（也給隱私權政策頁的「聯絡我們」與首頁第三張卡用）；`phoneHref` 由 `phone` 算，不存。 */
export type FooterContactText = {
  readonly department: string
  readonly address: string
  readonly phone: string
  readonly siteLabel: string
  readonly siteHref: string
  readonly slogan: string
  readonly officeNote: string
  readonly industryNote: string
}

/** 三張快速入口卡：只有標題與說明；卡上的連結與按鈕由程式依登入狀態產生，不在這裡（Q-C2-4）。 */
export type QuickCardText = {
  readonly title: string
  readonly description: string
}

/** 隱私權政策內文：段落陣列（每節一個標題＋幾段）；「聯絡我們」那一節由程式接頁尾聯絡資料，不在這裡。 */
export type PrivacyText = {
  readonly sections: readonly { readonly heading: string; readonly paragraphs: readonly string[] }[]
}

export type SiteTextValue = {
  footer_contact: FooterContactText
  quick_card_1: QuickCardText
  quick_card_2: QuickCardText
  quick_card_3: QuickCardText
  privacy: PrivacyText
}

/** 資料庫裡的一列（沒有列時查詢就沒有這個 key）。 */
export type SiteTextRow<K extends SiteTextKey = SiteTextKey> = {
  readonly key: K
  readonly value: SiteTextValue[K]
  /** 樂觀鎖：畫面帶著它存檔，別人先存過就被擋。 */
  readonly revision: number
  readonly updatedAt: Date
}

/** 一次讀回來的全部站內文字，照 key 取；沒有列的 key 不在裡面。 */
export type SiteTexts = { readonly [K in SiteTextKey]?: SiteTextRow<K> }

/** 表單送來的原始值（純文字欄位，都還沒整理）。隱私權政策是一整段 `body`（格式見 `parsePrivacyBody`）。 */
export type SiteTextInput = Readonly<Record<string, string>>

export const SITE_TEXT_LIMITS = {
  footer_contact: { department: 60, address: 120, phone: 30, siteLabel: 60, siteHref: 200, slogan: 120, officeNote: 120, industryNote: 120 },
  quick_card: { title: 20, description: 200 },
  privacy: { body: 20_000, heading: 60 },
} as const

export const FOOTER_CONTACT_FIELDS = ['department', 'address', 'phone', 'siteLabel', 'siteHref', 'slogan', 'officeNote', 'industryNote'] as const
export type FooterContactField = (typeof FOOTER_CONTACT_FIELDS)[number]

export const FOOTER_CONTACT_LABEL: Record<FooterContactField, string> = {
  department: '系所名稱',
  address: '地址',
  phone: '電話',
  siteLabel: '系網（顯示文字）',
  siteHref: '系網網址',
  slogan: '一句話介紹',
  officeNote: '專題洽詢說明',
  industryNote: '產學洽詢說明',
}

export type NormalizedSiteText<K extends SiteTextKey = SiteTextKey> =
  | { readonly ok: true; readonly value: SiteTextValue[K] }
  | { readonly ok: false; readonly field: string; readonly message: string }

type Line = { ok: true; value: string } | { ok: false; field: string; message: string }

/** 單行文字：去頭尾空白、不准換行、字數上限；`required` 時不准空白。 */
function line(field: string, label: string, raw: string | undefined, max: number, required: boolean): Line {
  const value = String(raw ?? '').trim()
  if (value === '') return required ? { ok: false, field, message: `請填${label}。` } : { ok: true, value }
  if (/[\r\n]/.test(value)) return { ok: false, field, message: `${label}只能寫一行，請拿掉換行。` }
  const length = charLength(value)
  if (length > max) return { ok: false, field, message: `${label}最多 ${max} 字（現在 ${length} 字）。` }
  return { ok: true, value }
}

function normalizeFooterContact(input: SiteTextInput): NormalizedSiteText<'footer_contact'> {
  const out: Record<FooterContactField, string> = { department: '', address: '', phone: '', siteLabel: '', siteHref: '', slogan: '', officeNote: '', industryNote: '' }
  for (const field of FOOTER_CONTACT_FIELDS) {
    const required = field === 'department' || field === 'address' || field === 'phone'
    const got = line(field, FOOTER_CONTACT_LABEL[field], input[field], SITE_TEXT_LIMITS.footer_contact[field], required)
    if (!got.ok) return got
    out[field] = got.value
  }
  if (out.siteHref !== '' && !/^https?:\/\/\S+$/i.test(out.siteHref)) {
    return { ok: false, field: 'siteHref', message: '系網網址要以 http:// 或 https:// 開頭。' }
  }
  if ((out.siteLabel === '') !== (out.siteHref === '')) {
    return { ok: false, field: out.siteLabel === '' ? 'siteLabel' : 'siteHref', message: '系網的顯示文字與網址要一起填，或一起留空。' }
  }
  return { ok: true, value: out }
}

function normalizeQuickCard(input: SiteTextInput): NormalizedSiteText<'quick_card_1'> {
  const title = line('title', '標題', input.title, SITE_TEXT_LIMITS.quick_card.title, true)
  if (!title.ok) return title
  const description = line('description', '說明', input.description, SITE_TEXT_LIMITS.quick_card.description, false)
  if (!description.ok) return description
  return { ok: true, value: { title: title.value, description: description.value } }
}

/**
 * 隱私權政策的純文字格式（表單是一個多行欄位）：`# ` 開頭的一行是一節的標題，其餘每個非空行是一段；空行只是分隔。
 * 至少一節，每節至少一段；第一行必須是標題。
 */
export function parsePrivacyBody(body: string): NormalizedSiteText<'privacy'> {
  const text = String(body ?? '').replace(/\r\n?/g, '\n')
  if (text.trim() === '') return { ok: false, field: 'body', message: '請填隱私權政策的內文。' }
  const length = charLength(text)
  if (length > SITE_TEXT_LIMITS.privacy.body) {
    return { ok: false, field: 'body', message: `內文最多 ${SITE_TEXT_LIMITS.privacy.body} 字（現在 ${length} 字）。` }
  }
  const sections: { heading: string; paragraphs: string[] }[] = []
  for (const rawLine of text.split('\n')) {
    const current = rawLine.trim()
    if (current === '') continue
    if (current.startsWith('#')) {
      const heading = current.replace(/^#+\s*/, '').trim()
      if (heading === '') return { ok: false, field: 'body', message: '「#」後面要接這一節的標題。' }
      if (charLength(heading) > SITE_TEXT_LIMITS.privacy.heading) {
        return { ok: false, field: 'body', message: `每節標題最多 ${SITE_TEXT_LIMITS.privacy.heading} 字：「${heading}」太長。` }
      }
      sections.push({ heading, paragraphs: [] })
      continue
    }
    const section = sections.at(-1)
    if (!section) return { ok: false, field: 'body', message: '第一行要是一節的標題（以「# 」開頭，例如「# 我們蒐集哪些資料」）。' }
    section.paragraphs.push(current)
  }
  const empty = sections.find((s) => s.paragraphs.length === 0)
  if (empty) return { ok: false, field: 'body', message: `「${empty.heading}」這一節還沒有內文。` }
  return { ok: true, value: { sections } }
}

/** 把段落陣列還原成表單用的純文字（`parsePrivacyBody` 的反向）。 */
export function privacyBodyOf(value: PrivacyText): string {
  return value.sections.map((s) => [`# ${s.heading}`, ...s.paragraphs].join('\n\n')).join('\n\n')
}

export function normalizeSiteText<K extends SiteTextKey>(key: K, input: SiteTextInput): NormalizedSiteText<K> {
  switch (key) {
    case 'footer_contact':
      return normalizeFooterContact(input) as NormalizedSiteText<K>
    case 'privacy':
      return parsePrivacyBody(input.body ?? '') as NormalizedSiteText<K>
    default:
      return normalizeQuickCard(input) as NormalizedSiteText<K>
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const allStrings = (value: Record<string, unknown>, fields: readonly string[]) => fields.every((f) => typeof value[f] === 'string')

/**
 * 資料庫 JSON → 型別化的值；形狀不對（手動改壞、舊格式）回 `null`，畫面就當沒有列、用預設，不會整頁掛掉。
 */
export function readSiteText<K extends SiteTextKey>(key: K, raw: unknown): SiteTextValue[K] | null {
  if (!isRecord(raw)) return null
  if (key === 'footer_contact') {
    return allStrings(raw, FOOTER_CONTACT_FIELDS) ? (raw as unknown as SiteTextValue[K]) : null
  }
  if (key === 'privacy') {
    const sections = raw.sections
    if (!Array.isArray(sections) || sections.length === 0) return null
    const valid = sections.every(
      (s) => isRecord(s) && typeof s.heading === 'string' && Array.isArray(s.paragraphs) && s.paragraphs.length > 0 && s.paragraphs.every((p) => typeof p === 'string'),
    )
    return valid ? ({ sections } as unknown as SiteTextValue[K]) : null
  }
  return allStrings(raw, ['title', 'description']) ? ({ title: raw.title, description: raw.description } as SiteTextValue[K]) : null
}

/** 視窗標題與稽核用的名稱。 */
export const SITE_TEXT_LABEL: Record<SiteTextKey, string> = {
  footer_contact: '頁尾聯絡資料',
  quick_card_1: '快速入口（第一張）',
  quick_card_2: '快速入口（第二張）',
  quick_card_3: '快速入口（第三張）',
  privacy: '隱私權政策',
}

/** 別人（或另一個分頁）先存過；沿用首頁設定那一句（§6.5）。 */
export { HOME_STALE_MESSAGE as SITE_TEXT_STALE_MESSAGE } from '@/application/site/home-settings'
