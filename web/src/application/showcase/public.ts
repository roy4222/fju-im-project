import type { ShowcaseAward, ShowcaseSort } from '@/application/showcase/ports'

type SortOption = { readonly value: ShowcaseSort; readonly label: string }
type AwardOption = { readonly value: ShowcaseAward | ''; readonly label: string }

/**
 * 前台精選列表的排序與篩選（純規則；照原型）。
 *
 * - 優秀專題（公開）：預設排序（＝首頁輪播的順序，預設）、屆別（新到舊）；獎項改用篩選（Q51）。
 * - 歷屆一覽（登入後）：屆別（新到舊）、得獎優先、題目（原型 `ProjectBrowser`）。
 *
 * 每組的第一個選項是該頁預設。獎項等級在 0011（票 39）才有欄位（`showcase_entries.award_level`）。
 */
export const FEATURED_SORT_OPTIONS: readonly SortOption[] = [
  { value: 'home', label: '預設排序' },
  { value: 'cohort', label: '屆別（新到舊）' },
]

export const ARCHIVE_SORT_OPTIONS: readonly SortOption[] = [
  { value: 'cohort', label: '屆別（新到舊）' },
  { value: 'award', label: '得獎優先' },
  { value: 'title', label: '題目' },
]

/** 優秀專題的獎項篩選；空字串＝全部獎項（不寫進網址）。 */
export const FEATURED_AWARD_OPTIONS: readonly AwardOption[] = [
  { value: '', label: '全部獎項' },
  { value: 'excellent', label: '優秀專題' },
  { value: 'merit', label: '佳作' },
]

/** 網址上的 `?sort=` → 這一頁開的排序；看不懂的一律當該頁預設（第一個選項）。 */
export function parseShowcaseSort(value: unknown, options: readonly SortOption[] = ARCHIVE_SORT_OPTIONS): ShowcaseSort {
  return options.find((o) => o.value === value)?.value ?? options[0]!.value
}

/** 網址上的 `?award=` → 優秀專題的獎項篩選；看不懂的一律當沒篩選。 */
export function parseShowcaseAward(value: unknown): ShowcaseAward | undefined {
  return value === 'excellent' || value === 'merit' ? value : undefined
}
