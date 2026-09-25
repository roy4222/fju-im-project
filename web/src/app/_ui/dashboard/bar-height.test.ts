import { describe, expect, it } from 'vitest'
import { barHeight } from './bar-height'

describe('barHeight', () => {
  it('值是 0（或負數、NaN）時高度 0，不套最小高度', () => {
    expect(barHeight(0, 5, 120)).toBe(0)
    expect(barHeight(-1, 5, 120)).toBe(0)
    expect(barHeight(Number.NaN, 5, 120)).toBe(0)
  })
  it('值大於 0 但很小：至少 4px', () => {
    expect(barHeight(1, 1000, 120)).toBe(4)
  })
  it('一般情況照比例；最大值滿高', () => {
    expect(barHeight(5, 10, 120)).toBe(60)
    expect(barHeight(10, 10, 120)).toBe(120)
  })
})
