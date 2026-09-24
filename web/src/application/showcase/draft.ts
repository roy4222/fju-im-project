import type { FileTypeId } from '@/application/ops'
import { err, type Err } from '@/shared/result'

/**
 * 精選草稿的純規則（模組實作設計 09 §2「草稿與版本分開」、§3「draft（編輯）」、附錄 A `showcase_drafts`；票 25／S11-03）。
 *
 * 草稿只存、不發布：儲存不需要授權、不跑個資檢查（那是 S12 發布時的事）。這裡只管「存進去的東西長得對」：
 * 題目與摘要的長度、影片連結是 http(s)、摘要怎麼正規化（算 checksum 的依據）。
 *
 * **摘要正規化**是授權範圍比對的基礎：`summary_checksum`＝sha256(正規化後的摘要)。
 * 簽核建版時直接讀草稿上的 checksum 凍結，S12 發布時的涵蓋比對也用同一份正規化——所以這裡只能有一份。
 */

/** 和資料庫 CHECK（0010 `showcase_drafts_*_check`）同一組數字。 */
export const SHOWCASE_LIMITS = { title: 200, summary: 2000, videoUrl: 500 } as const

/** 海報只收圖片（票 25：「海報走 FileStorage 並只收圖片」）。上限比照一般附件的圖片。 */
export const POSTER_UPLOAD: { readonly allowedTypes: readonly FileTypeId[]; readonly maxBytes: number } = {
  allowedTypes: ['png', 'jpg'],
  maxBytes: 10 * 1024 * 1024,
}

/** 閘門欄在 S11 固定顯示的文案（S11-03：以固定文案代替 S12 的公開閘門）。 */
export const GATE_PLACEHOLDER = '尚無授權'

/**
 * 摘要正規化：Unicode NFC、換行統一成 `\n`、每行去掉行尾空白、整段去掉頭尾空白。
 * 「前後多一個空白」「Windows 換行」不算改了摘要（S11-03 整合：相同摘要含前後空白差異 checksum 穩定）；
 * 段落內文字不動。
 */
export function normalizeSummary(summary: string): string {
  return summary
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\u3000]+$/u, ''))
    .join('\n')
    .trim()
}

/** 題目：NFC、壓掉換行與連續空白、去頭尾空白。 */
export function normalizeTitle(title: string): string {
  return title.normalize('NFC').replace(/\s+/g, ' ').trim()
}

const VIDEO_URL = /^https?:\/\/[^\s]+$/i

export type DraftFieldsInput = {
  readonly title: unknown
  readonly summary: unknown
  readonly videoUrl: unknown
}

export type DraftFields = {
  readonly title: string
  readonly summary: string
  readonly videoUrl: string | null
}

/** 表單送來的三欄 → 可以存的樣子；不合就 `VALIDATION_FAILED` 並指出哪一欄。 */
export function normalizeDraftFields(input: DraftFieldsInput): { ok: true; value: DraftFields } | Err {
  const title = normalizeTitle(String(input.title ?? ''))
  if (title.length > SHOWCASE_LIMITS.title) {
    return err('VALIDATION_FAILED', `題目最多 ${SHOWCASE_LIMITS.title} 個字。`, { details: { field: 'title' } })
  }
  const summary = normalizeSummary(String(input.summary ?? ''))
  if (summary.length > SHOWCASE_LIMITS.summary) {
    return err('VALIDATION_FAILED', `摘要最多 ${SHOWCASE_LIMITS.summary} 個字。`, { details: { field: 'summary' } })
  }
  const rawUrl = String(input.videoUrl ?? '').trim()
  let videoUrl: string | null = null
  if (rawUrl !== '') {
    if (rawUrl.length > SHOWCASE_LIMITS.videoUrl || !VIDEO_URL.test(rawUrl)) {
      return err('VALIDATION_FAILED', '影片連結要是 http:// 或 https:// 開頭的完整網址。', { details: { field: 'videoUrl' } })
    }
    try {
      const parsed = new URL(rawUrl)
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('protocol')
    } catch {
      return err('VALIDATION_FAILED', '影片連結要是 http:// 或 https:// 開頭的完整網址。', { details: { field: 'videoUrl' } })
    }
    videoUrl = rawUrl
  }
  return { ok: true, value: { title, summary, videoUrl } }
}
