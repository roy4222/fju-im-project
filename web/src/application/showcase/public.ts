import type { ShowcaseSort } from '@/application/showcase/ports'

/**
 * 前台精選列表的排序（純規則；優秀專題與歷屆一覽共用）。
 *
 * 原型還有「優秀專題優先」「佳作優先」「只看得獎」：得獎等級在精選三表與 spec 附錄 A 都沒有欄位，
 * 這一版不做（PR 內文列為待決）。
 */
export const SHOWCASE_SORT_OPTIONS: readonly { readonly value: ShowcaseSort; readonly label: string }[] = [
  { value: 'cohort', label: '屆別（新到舊）' },
  { value: 'cohort-asc', label: '屆別（舊到新）' },
  { value: 'title', label: '題目' },
]

/** 網址上的 `?sort=` → 排序；看不懂的一律當預設（屆別新到舊）。 */
export function parseShowcaseSort(value: unknown): ShowcaseSort {
  return SHOWCASE_SORT_OPTIONS.find((o) => o.value === value)?.value ?? 'cohort'
}

/** 前台還沒有真照片時的佔位圖（`public/placeholder/*.jpg`；Q-SHW01 素材到位前）。同一個 ID 永遠拿到同一張。 */
export const PLACEHOLDER_IMAGES = [
  'showcase',
  'present',
  'students',
  'study',
  'hackathon',
  'applause',
  'trophy',
  'campus',
  'building',
  'atrium',
  'lounge',
  'phone',
] as const

export function placeholderImageFor(id: string): string {
  let hash = 0
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return `/placeholder/${PLACEHOLDER_IMAGES[hash % PLACEHOLDER_IMAGES.length]}.jpg`
}
