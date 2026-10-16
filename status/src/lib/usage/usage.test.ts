// 使用報表的純計算（AC-DV-24 的數字段；Q-DV-7 定案：本學期＝最近一個 2/1 或 8/1 起算）。
import { describe, expect, it } from 'vitest'

import type { UsageReport, UsageRole } from '@/lib/data/types'

import { actionLabel } from './actions'
import { parseRange, parseRole, rangeFrom, summarize, termStart, TOP_N } from './usage'

const day = (offset: number) => new Date(Date.parse('2026-10-12T00:00:00Z') - offset * 86400e3).toISOString().slice(0, 10)

type Action = UsageReport['actions'][number]
const action = (code: string, role: UsageRole, count7d: number, count30d: number, countTerm: number): Action => ({
  action: code,
  role,
  count7d,
  count30d,
  countTerm,
})

/** 120 天：學生每天 activeUsers＝100＋往前第幾天（越舊越多）；老師固定 10；系辦只有最近 3 天、各 3、4、5。 */
function report(actions: Action[] = []): UsageReport {
  const daily: UsageReport['daily'] = []
  for (let i = 119; i >= 0; i--) {
    daily.push({ day: day(i), role: 'student', activeUsers: 100 + i, events: 1 })
    daily.push({ day: day(i), role: 'teacher', activeUsers: 10, events: 1 })
    if (i < 3) daily.push({ day: day(i), role: 'admin', activeUsers: 5 - i, events: 1 })
  }
  return { generatedAt: '2026-10-12T04:10:00+08:00', site: 'prod', window: { from: day(119), to: day(0) }, daily, actions }
}

describe('範圍', () => {
  it('本學期：最近一個 2/1 或 8/1（含當天）', () => {
    expect(termStart('2026-10-12')).toBe('2026-08-01')
    expect(termStart('2026-08-01')).toBe('2026-08-01')
    expect(termStart('2026-07-31')).toBe('2026-02-01')
    expect(termStart('2026-02-01')).toBe('2026-02-01')
    expect(termStart('2026-01-31')).toBe('2025-08-01')
  })

  it('7d／30d 含 window.to 往前 7／30 天', () => {
    expect(rangeFrom('7d', '2026-10-12')).toBe('2026-10-06')
    expect(rangeFrom('30d', '2026-10-12')).toBe('2026-09-13')
    expect(rangeFrom('7d', '2026-03-02')).toBe('2026-02-24')
    expect(rangeFrom('term', '2026-10-12')).toBe('2026-08-01')
  })

  it('網址參數不認得就退回 7 天、全部角色', () => {
    expect(parseRange('30d')).toBe('30d')
    expect(parseRange('term')).toBe('term')
    expect(parseRange('90d')).toBe('7d')
    expect(parseRange(undefined)).toBe('7d')
    expect(parseRange(['30d'])).toBe('7d')
    expect(parseRole('teacher')).toBe('teacher')
    expect(parseRole('guest')).toBe('all')
    expect(parseRole(undefined)).toBe('all')
  })
})

describe('每日活躍人數', () => {
  it('範圍內 activeUsers 平均、四捨五入成整數；只除以有資料的天數', () => {
    const s7 = summarize(report(), '7d', 'all')
    // 學生最近 7 天是 100..106，平均 103
    expect(s7.activeUsers).toEqual({ student: 103, teacher: 10, admin: 4 })
    // 30 天：100..129 平均 114.5 → 115（四捨五入）
    expect(summarize(report(), '30d', 'all').activeUsers.student).toBe(115)
    // 本學期 8/1～10/12 共 73 天：100..172 平均 136
    expect(summarize(report(), 'term', 'all').activeUsers.student).toBe(136)
  })

  it('篩老師：只有老師有數字', () => {
    expect(summarize(report(), '7d', 'teacher').activeUsers).toEqual({ student: null, teacher: 10, admin: null })
  })

  it('範圍內沒有資料的角色是 null', () => {
    const r = report()
    r.daily = r.daily.filter((d) => d.role !== 'admin')
    expect(summarize(r, '7d', 'all').activeUsers.admin).toBeNull()
  })
})

describe('長條圖與很少用的功能', () => {
  it('依範圍用對應的 count 欄、同一 action 跨角色加總、白話名、對不到顯示原代碼', () => {
    const r = report([
      action('submission.submit', 'student', 50, 200, 900),
      action('account.change_password', 'student', 3, 9, 20),
      action('account.change_password', 'teacher', 4, 1, 2),
      action('grading.return', 'teacher', 60, 100, 300),
      action('mystery.thing', 'admin', 5, 5, 5),
    ])
    expect(summarize(r, '7d', 'all').bars).toEqual([
      { action: 'grading.return', label: '評分', count: 60 },
      { action: 'submission.submit', label: '交作業', count: 50 },
      { action: 'account.change_password', label: '改密碼', count: 7 },
      { action: 'mystery.thing', label: 'mystery.thing', count: 5 },
    ])
    expect(summarize(r, '30d', 'all').bars.map((b) => b.action)).toEqual([
      'submission.submit',
      'grading.return',
      'account.change_password',
      'mystery.thing',
    ])
    expect(summarize(r, 'term', 'all').bars[0]).toEqual({ action: 'submission.submit', label: '交作業', count: 900 })
    expect(summarize(r, '7d', 'teacher').bars).toEqual([
      { action: 'grading.return', label: '評分', count: 60 },
      { action: 'account.change_password', label: '改密碼', count: 4 },
    ])
  })

  it(`最多 ${TOP_N} 條、不含 0；同次數依代碼排`, () => {
    const many = Array.from({ length: 20 }, (_, i) => action(`x.a${String(i).padStart(2, '0')}`, 'student', 20 - i, 0, 0))
    many.push(action('x.b', 'student', 6, 0, 0), action('x.zero', 'student', 0, 0, 0))
    const bars = summarize(report(many), '7d', 'all').bars
    expect(bars).toHaveLength(TOP_N)
    expect(bars.map((b) => b.count)).toEqual([20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6])
    // 第 15 名是兩個 6 次並列：代碼排前面的 x.a14 進榜、x.b 不進
    expect(bars.at(-1)?.action).toBe('x.a14')
    expect(bars.map((b) => b.action)).not.toContain('x.b')
    expect(summarize(report([action('x.zero', 'student', 0, 0, 0)]), '7d', 'all').bars).toEqual([])
  })

  it('很少用：範圍內加總 ≤ 2（含 0），由少到多', () => {
    const r = report([
      action('x.zero', 'admin', 0, 0, 1),
      action('x.one', 'admin', 1, 1, 1),
      action('x.two', 'student', 1, 2, 2),
      action('x.two', 'teacher', 1, 0, 0),
      action('x.many', 'student', 3, 3, 3),
    ])
    expect(summarize(r, '7d', 'all').rare.map((c) => [c.action, c.count])).toEqual([
      ['x.zero', 0],
      ['x.one', 1],
      ['x.two', 2],
    ])
    expect(summarize(r, '30d', 'all').rare.map((c) => c.action)).toEqual(['x.zero', 'x.one', 'x.two'])
    // 只看學生：x.two 只算學生那列（7d＝1），系辦的兩個不出現
    expect(summarize(r, '7d', 'student').rare).toEqual([{ action: 'x.two', label: 'x.two', count: 1 }])
  })

  it('actionLabel：對照表裡的給白話名，其他原樣', () => {
    expect(actionLabel('account.change_password')).toBe('改密碼')
    expect(actionLabel('toString')).toBe('toString')
    expect(actionLabel('no.such')).toBe('no.such')
  })
})
