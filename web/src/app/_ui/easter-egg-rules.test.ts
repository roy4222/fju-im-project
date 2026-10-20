import { describe, expect, it } from 'vitest'
import { EGG_START, eggClick, eggStage, shouldCountClick } from '@/app/_ui/easter-egg-rules'

describe('shouldCountClick：哪些 logo 點擊算彩蛋（也就是要 preventDefault）', () => {
  it('首頁、滑鼠／觸控點擊（detail > 0）：算', () => {
    expect(shouldCountClick('/', { detail: 1 })).toBe(true)
    expect(shouldCountClick('/', { detail: 3 })).toBe(true)
  })

  it('鍵盤 Enter（detail 0）不算，照常回首頁', () => {
    expect(shouldCountClick('/', { detail: 0 })).toBe(false)
  })

  it('首頁以外第 1 下照常回首頁、不計數', () => {
    expect(shouldCountClick('/rules', { detail: 1 })).toBe(false)
    expect(shouldCountClick('/news/1', { detail: 1 })).toBe(false)
  })

  it('還不知道路徑（null）不攔', () => {
    expect(shouldCountClick(null, { detail: 1 })).toBe(false)
  })
})

describe('eggClick：5 秒計數視窗', () => {
  it('第一下從 1 開始，記下起點', () => {
    expect(eggClick(EGG_START, 1000)).toEqual({ count: 1, since: 1000 })
  })

  it('5 秒內連點會累加', () => {
    let s = EGG_START
    for (let i = 0; i < 10; i++) s = eggClick(s, 1000 + i * 400)
    expect(s).toEqual({ count: 10, since: 1000 })
  })

  it('剛好 5 秒還算在視窗內', () => {
    expect(eggClick({ count: 9, since: 1000 }, 6000)).toEqual({ count: 10, since: 1000 })
  })

  it('超過 5 秒：歸零重算，這一下是新的第 1 下（AC-50）', () => {
    const s = eggClick(eggClick(EGG_START, 0), 300)
    expect(eggClick(s, 6300)).toEqual({ count: 1, since: 6300 })
  })

  it('已經到 10 下之後再點：重新開始', () => {
    expect(eggClick({ count: 10, since: 0 }, 500)).toEqual({ count: 1, since: 500 })
  })
})

describe('eggStage：第 3 下起晃、第 10 下起飛', () => {
  it.each([
    [0, 'idle'],
    [1, 'idle'],
    [2, 'idle'],
    [3, 'shake'],
    [9, 'shake'],
    [10, 'fire'],
  ] as const)('%i 下 → %s', (count, stage) => {
    expect(eggStage(count)).toBe(stage)
  })
})
