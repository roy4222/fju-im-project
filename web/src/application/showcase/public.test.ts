import { describe, expect, it } from 'vitest'
import { ARCHIVE_SORT_OPTIONS, FEATURED_SORT_OPTIONS, parseShowcaseSort } from '@/application/showcase/public'

describe('parseShowcaseSort', () => {
  it('這一頁開的排序原樣回傳', () => {
    for (const o of ARCHIVE_SORT_OPTIONS) expect(parseShowcaseSort(o.value)).toBe(o.value)
    for (const o of FEATURED_SORT_OPTIONS) expect(parseShowcaseSort(o.value, FEATURED_SORT_OPTIONS)).toBe(o.value)
  })

  it('看不懂的、沒給的、別頁才有的都當預設（屆別新到舊）', () => {
    expect(parseShowcaseSort(undefined)).toBe('cohort')
    expect(parseShowcaseSort(['title'])).toBe('cohort')
    // 歷屆一覽沒有「優秀專題優先」、優秀專題沒有「題目」。
    expect(parseShowcaseSort('excellent')).toBe('cohort')
    expect(parseShowcaseSort('title', FEATURED_SORT_OPTIONS)).toBe('cohort')
  })
})
