import { describe, expect, it } from 'vitest'
import { parseShowcaseSort, placeholderImageFor, SHOWCASE_SORT_OPTIONS } from '@/application/showcase/public'

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

describe('placeholderImageFor', () => {
  it('同一個 ID 永遠同一張，而且是 public/placeholder 底下的 jpg', () => {
    const a = placeholderImageFor('0190a8f0-0000-7000-8000-000000000001')
    expect(a).toBe(placeholderImageFor('0190a8f0-0000-7000-8000-000000000001'))
    expect(a).toMatch(/^\/placeholder\/[a-z]+\.jpg$/)
  })
})
