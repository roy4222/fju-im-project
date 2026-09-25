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
