import { describe, expect, it } from 'vitest'
import { parseShowcaseSort, SHOWCASE_SORT_OPTIONS } from '@/application/showcase/public'

describe('parseShowcaseSort', () => {
  it('認得的排序原樣回傳', () => {
    for (const o of SHOWCASE_SORT_OPTIONS) expect(parseShowcaseSort(o.value)).toBe(o.value)
  })

  it('看不懂的、沒給的都當預設（屆別新到舊）', () => {
    expect(parseShowcaseSort(undefined)).toBe('cohort')
    expect(parseShowcaseSort('excellent')).toBe('cohort')
    expect(parseShowcaseSort(['title'])).toBe('cohort')
  })
})
