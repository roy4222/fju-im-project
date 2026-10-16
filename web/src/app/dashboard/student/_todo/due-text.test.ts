import { describe, expect, it } from 'vitest'
import { daysLeft, dueText } from '@/app/dashboard/student/_todo/due-text'

// 業務鐘固定在臺灣 8/17 晚上（UTC 已經是 8/17 15:30）：天數要照臺灣日曆日算。
const NOW = new Date('2026-08-17T23:30:00+08:00')
const at = (taipei: string) => new Date(`${taipei}+08:00`)

describe('daysLeft', () => {
  it('照臺灣日曆日相減，不看幾點', () => {
    expect(daysLeft(at('2026-08-26T23:59:00'), NOW)).toBe(9)
    expect(daysLeft(at('2026-08-18T00:00:00'), NOW)).toBe(1)
    expect(daysLeft(at('2026-08-17T00:00:00'), NOW)).toBe(0)
    expect(daysLeft(at('2026-08-14T23:59:00'), NOW)).toBe(-3)
  })
})

describe('dueText', () => {
  it('同意書沒有截止日', () => {
    expect(dueText({ due: null, status: 'open', late: false }, NOW)).toBe('沒有截止日')
  })

  it('還沒到：M/D 截止・剩 N 天', () => {
    expect(dueText({ due: at('2026-08-26T23:59:00'), status: 'soon', late: false }, NOW)).toBe('8/26 截止・剩 9 天')
    expect(dueText({ due: at('2026-09-06T23:59:00'), status: 'open', late: false }, NOW)).toBe('9/6 截止・剩 20 天')
    expect(dueText({ due: at('2026-09-06T23:59:00'), status: 'notOpen', late: false }, NOW)).toBe('9/6 截止・剩 20 天')
  })

  it('今天截止', () => {
    expect(dueText({ due: at('2026-08-17T23:59:00'), status: 'soon', late: false }, NOW)).toBe('今天截止')
  })

  it('逾期 N 天；當天剛過截止寫「今天已截止」不寫「逾期 0 天」', () => {
    expect(dueText({ due: at('2026-08-14T23:59:00'), status: 'overdue', late: false }, NOW)).toBe('逾期 3 天')
    expect(dueText({ due: at('2026-08-17T12:00:00'), status: 'overdue', late: false }, NOW)).toBe('今天已截止')
  })

  it('補交期限生效：補交到 M/D（Q128）', () => {
    expect(dueText({ due: at('2026-08-20T23:59:00'), status: 'soon', late: true }, NOW)).toBe('補交到 8/20')
  })

  it('已交、免繳只寫截止日', () => {
    expect(dueText({ due: at('2026-08-10T23:59:00'), status: 'done', late: false }, NOW)).toBe('8/10 截止')
    expect(dueText({ due: at('2026-08-26T23:59:00'), status: 'exempt', late: false }, NOW)).toBe('8/26 截止')
  })
})
