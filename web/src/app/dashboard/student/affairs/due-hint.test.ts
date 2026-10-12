import { describe, expect, it } from 'vitest'
import { dueHint } from '@/app/dashboard/student/affairs/due-hint'

const status = (patch: Partial<Parameters<typeof dueHint>[1]> = {}) => ({ pending: false, submitted: false, overdue: false, editable: false, ...patch })

describe('學生作業區截止欄的第二行', () => {
  it('逾期未繳：當天截止寫「今天已截止」，不是「逾期 0 天」（驗收第 2 章 P-07）；隔天起寫「逾期 N 天」', () => {
    expect(dueHint(0, status({ overdue: true })).text).toBe('今天已截止')
    expect(dueHint(-1, status({ overdue: true })).text).toBe('逾期 1 天')
    expect(dueHint(-3, status({ overdue: true })).text).toBe('逾期 3 天')
  })

  it('還沒繳：剩幾天／今天截止；已繳：可重送或已截止', () => {
    expect(dueHint(5, status({ pending: true })).text).toBe('剩 5 天')
    expect(dueHint(0, status({ pending: true })).text).toBe('今天截止')
    expect(dueHint(2, status({ submitted: true, editable: true })).text).toBe('剩 2 天可重送')
    expect(dueHint(-1, status({ submitted: true })).text).toBe('已截止')
  })
})
