import type { FileTypeId } from '@/application/ops'

/**
 * 首頁設定（第三波 W3；設計方案 §3，Q18、Q32「存了就生效」）：首頁大圖、圖片說明、標語兩行。
 *
 * 資料是一筆單列設定（`home_settings`，`id = 1`）；欄位是 null 就用這裡的預設。
 * **預設值與改版前寫死在首頁的字一字不差**（`e2e/smoke.spec.ts`、`e2e/public-pages.spec.ts` 守著），
 * 所以沒有設定列、或按過「恢復預設」時，首頁跟以前一模一樣。上方小字與兩顆按鈕不進後台。
 *
 * 這個檔只有規則，沒有資料庫：預設值、字數上限、表單收斂都是純函式。
 */

export const HOME_DEFAULTS = {
  heroSrc: '/placeholder/campus.jpg',
  /** 預設圖是裝飾（文字在旁邊），alt 留空。 */
  heroAlt: '',
  line1: '輔仁大學資訊管理學系專題管理平台',
  line2: '輔大資管系專題：從分組、提案到成果發表，公告、規則與歷屆作品都在這裡。',
} as const

/** 與 `home_settings` 的 CHECK 一致（以字計，Postgres `char_length`）。 */
export const HOME_LIMITS = { line1: 40, line2: 120, heroAlt: 120 } as const

/** 首頁大圖：只收 PNG／JPG、上限 5 MiB（同公告封面，`application/items/items.ts` 的 `ITEM_UPLOAD.cover`）。 */
export const HERO_UPLOAD: { readonly allowedTypes: readonly FileTypeId[]; readonly maxBytes: number } = {
  allowedTypes: ['png', 'jpg'],
  maxBytes: 5 * 1024 * 1024,
}

/** 資料庫裡的那一列（沒有列時查詢回 null）。 */
export type HomeSettings = {
  readonly heroFileId: string | null
  readonly heroAlt: string | null
  readonly line1: string | null
  readonly line2: string | null
  /** 樂觀鎖：畫面帶著它存檔，別人先存過就被擋。 */
  readonly revision: number
  readonly updatedAt: Date
  readonly updatedByName: string | null
}

/** 首頁 hero 實際要畫的東西。 */
export type ResolvedHome = {
  readonly heroSrc: string
  readonly heroAlt: string
  readonly line1: string
  readonly line2: string
}

export function resolveHome(settings: HomeSettings | null): ResolvedHome {
  const heroFileId = settings?.heroFileId ?? null
  return {
    // 自訂圖走 /api/files：每次下載重新授權，只有目前指到的那一張對訪客公開（換圖後舊圖回到「無法存取」）。
    heroSrc: heroFileId ? `/api/files/${heroFileId}` : HOME_DEFAULTS.heroSrc,
    heroAlt: heroFileId ? (settings?.heroAlt ?? '') : HOME_DEFAULTS.heroAlt,
    line1: settings?.line1 ?? HOME_DEFAULTS.line1,
    line2: settings?.line2 ?? HOME_DEFAULTS.line2,
  }
}

/** 表單送來的原始值（都還沒整理）。 */
export type HomeSettingsInput = {
  readonly heroFileId: string | null
  readonly heroAlt: string
  readonly line1: string
  readonly line2: string
}

/** 要寫進資料庫的四欄；null＝用預設。 */
export type HomeSettingsFields = {
  readonly heroFileId: string | null
  readonly heroAlt: string | null
  readonly line1: string | null
  readonly line2: string | null
}

export type HomeSettingsField = 'hero' | 'heroAlt' | 'line1' | 'line2'

export type NormalizedHomeSettings =
  | { readonly ok: true; readonly value: HomeSettingsFields }
  | { readonly ok: false; readonly field: HomeSettingsField; readonly message: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 以「字」計（code point），跟 Postgres 的 `char_length` 一樣；emoji 算一個字。 */
function charLength(value: string): number {
  return Array.from(value).length
}

const LABEL: Record<Exclude<HomeSettingsField, 'hero'>, string> = {
  heroAlt: '圖片說明',
  line1: '標語第一行',
  line2: '標語第二行',
}

function text(field: Exclude<HomeSettingsField, 'hero'>, raw: string): { ok: true; value: string | null } | { ok: false; field: HomeSettingsField; message: string } {
  const value = String(raw ?? '').trim()
  if (value === '') return { ok: true, value: null }
  if (/[\r\n]/.test(value)) return { ok: false, field, message: `${LABEL[field]}只能寫一行，請拿掉換行。` }
  const length = charLength(value)
  const max = HOME_LIMITS[field]
  if (length > max) return { ok: false, field, message: `${LABEL[field]}最多 ${max} 字（現在 ${length} 字）。` }
  return { ok: true, value }
}

export function normalizeHomeSettings(input: HomeSettingsInput): NormalizedHomeSettings {
  const rawFile = input.heroFileId === null ? '' : String(input.heroFileId).trim()
  const heroFileId = rawFile === '' ? null : rawFile.toLowerCase()
  if (heroFileId !== null && !UUID.test(heroFileId)) {
    return { ok: false, field: 'hero', message: '首頁大圖的資料不對，請重新上傳。' }
  }
  const line1 = text('line1', input.line1)
  if (!line1.ok) return line1
  const line2 = text('line2', input.line2)
  if (!line2.ok) return line2
  // 圖片說明只對自訂圖有意義：預設圖是裝飾，不存說明。
  const alt = heroFileId ? text('heroAlt', input.heroAlt) : ({ ok: true, value: null } as const)
  if (!alt.ok) return alt
  if (heroFileId && alt.value === null) {
    return { ok: false, field: 'heroAlt', message: '請寫圖片說明（例如「利瑪竇大樓外觀」），看不到圖的人會聽到這段文字。' }
  }
  return { ok: true, value: { heroFileId, heroAlt: alt.value, line1: line1.value, line2: line2.value } }
}

/** 存檔成功後給系辦看的一句話（AC-17）。 */
export function describeHomeSaved(reset: boolean): string {
  return reset ? '已恢復預設，訪客重新整理就會看到。' : '首頁已更新，訪客重新整理就會看到。'
}

/** 別人（或另一個分頁）先存過（AC-19）。 */
export const HOME_STALE_MESSAGE = '這份設定剛被改過，請重新整理再改。'
