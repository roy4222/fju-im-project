import type { ShowcaseSort } from '@/application/showcase/ports'

type SortOption = { readonly value: ShowcaseSort; readonly label: string }

/**
 * 前台精選列表的排序（純規則；照原型）。
 *
 * - 優秀專題（公開）：屆別（新到舊）、優秀專題優先、佳作優先（原型 `listFeaturedProjects`）。
 * - 歷屆一覽（登入後）：屆別（新到舊）、得獎優先、題目（原型 `ProjectBrowser`）。
 *
 * 獎項等級在 0011（票 39）才有欄位（`showcase_entries.award_level`）。
 */
export const FEATURED_SORT_OPTIONS: readonly SortOption[] = [
  { value: 'cohort', label: '屆別（新到舊）' },
  { value: 'excellent', label: '優秀專題優先' },
  { value: 'merit', label: '佳作優先' },
]

export const ARCHIVE_SORT_OPTIONS: readonly SortOption[] = [
  { value: 'cohort', label: '屆別（新到舊）' },
  { value: 'award', label: '得獎優先' },
  { value: 'title', label: '題目' },
]

/** 網址上的 `?sort=` → 這一頁開的排序；看不懂的一律當預設（屆別新到舊）。 */
export function parseShowcaseSort(value: unknown, options: readonly SortOption[] = ARCHIVE_SORT_OPTIONS): ShowcaseSort {
  return options.find((o) => o.value === value)?.value ?? 'cohort'
}
