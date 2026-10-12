/**
 * 截圖路由 `/shots/<runId>/<item>/screenshots/<檔名>` 的放行規則（設計方案 §3.9）：
 * 每段只收 `^[A-Za-z0-9._-]+$`（且不是 `.`／`..`）、`runId` 要在 acceptance-index.runs、
 * 檔案要被**該 run** 的 summary.json `steps[].截圖` 列到。其餘一律 404。
 */
import { isSafeSegment } from '../data/read'
import type { SummaryJson } from '../data/types'

// 用 Map：普通物件會讓 `constructor` 之類的繼承屬性被當成副檔名命中。
export const SHOT_CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp'],
  ['gif', 'image/gif'],
])

export type ShotRequest = { runId: string; item: string; /** `<item>/screenshots/<檔名>` */ rel: string; contentType: string }

/** 只看網址形狀：剛好四段、第三段是 `screenshots`、每段安全、副檔名是圖。 */
export function parseShotPath(segments: string[]): ShotRequest | null {
  if (segments.length !== 4) return null
  if (!segments.every(isSafeSegment)) return null
  const [runId, item, dir, file] = segments as [string, string, string, string]
  if (dir !== 'screenshots') return null
  const ext = file.includes('.') ? file.slice(file.lastIndexOf('.') + 1).toLowerCase() : ''
  const contentType = SHOT_CONTENT_TYPES.get(ext)
  if (!contentType) return null
  return { runId, item, rel: `${item}/${dir}/${file}`, contentType }
}

/** summary.json 的 `steps[].截圖` 列到的全部路徑（`<item>/screenshots/<檔名>`）。 */
export function listedShots(summary: SummaryJson): Set<string> {
  const out = new Set<string>()
  for (const item of summary.items ?? []) {
    for (const step of item.steps ?? []) {
      for (const shot of Array.isArray(step.截圖) ? step.截圖 : []) if (typeof shot === 'string') out.add(shot)
    }
  }
  return out
}
