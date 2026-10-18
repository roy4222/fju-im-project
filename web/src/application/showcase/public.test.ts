import { describe, expect, it } from 'vitest'
import {
  ARCHIVE_SORT_OPTIONS,
  FEATURED_AWARD_OPTIONS,
  FEATURED_SORT_OPTIONS,
  parseShowcaseAward,
  parseShowcaseSort,
} from '@/application/showcase/public'

describe('parseShowcaseSort', () => {
  it('這一頁開的排序原樣回傳', () => {
    for (const o of ARCHIVE_SORT_OPTIONS) expect(parseShowcaseSort(o.value)).toBe(o.value)
    for (const o of FEATURED_SORT_OPTIONS) expect(parseShowcaseSort(o.value, FEATURED_SORT_OPTIONS)).toBe(o.value)
  })

  it('優秀專題只剩「預設排序」「屆別（新到舊）」，預設預設排序（跟首頁輪播同序）', () => {
    expect(FEATURED_SORT_OPTIONS.map((o) => o.value)).toEqual(['home', 'cohort'])
    expect(parseShowcaseSort(undefined, FEATURED_SORT_OPTIONS)).toBe('home')
    // 「優秀專題優先」「佳作優先」改成獎項篩選，不再是排序。
    expect(parseShowcaseSort('excellent', FEATURED_SORT_OPTIONS)).toBe('home')
    expect(parseShowcaseSort('merit', FEATURED_SORT_OPTIONS)).toBe('home')
  })

  it('看不懂的、沒給的、別頁才有的都當該頁預設（歷屆一覽仍是屆別新到舊）', () => {
    expect(parseShowcaseSort(undefined)).toBe('cohort')
    expect(parseShowcaseSort(['title'])).toBe('cohort')
    // 歷屆一覽沒有「優秀專題優先」與「預設排序」、優秀專題沒有「題目」。
    expect(parseShowcaseSort('excellent')).toBe('cohort')
    expect(parseShowcaseSort('home')).toBe('cohort')
    expect(parseShowcaseSort('title', FEATURED_SORT_OPTIONS)).toBe('home')
  })
})

describe('parseShowcaseAward', () => {
  it('獎項篩選：全部獎項、優秀專題、佳作', () => {
    expect(FEATURED_AWARD_OPTIONS.map((o) => [o.value, o.label])).toEqual([
      ['', '全部獎項'],
      ['excellent', '優秀專題'],
      ['merit', '佳作'],
    ])
    expect(parseShowcaseAward('excellent')).toBe('excellent')
    expect(parseShowcaseAward('merit')).toBe('merit')
  })

  it('看不懂的、空的、陣列都當沒篩選', () => {
    expect(parseShowcaseAward(undefined)).toBeUndefined()
    expect(parseShowcaseAward('')).toBeUndefined()
    expect(parseShowcaseAward('xxx')).toBeUndefined()
    expect(parseShowcaseAward(['excellent'])).toBeUndefined()
  })
})
