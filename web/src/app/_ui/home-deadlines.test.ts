import { describe, expect, it } from 'vitest'
import type { MyDeadline } from '@/application/items'
import { homeDeadlines } from './home-deadlines'

const at = (iso: string) => new Date(iso)
const d = (itemId: string, dueAt: string): MyDeadline => ({
  itemId,
  cohortId: 'c',
  title: itemId,
  dueAt: at(dueAt),
  receiverUnit: 'group',
})

// 業務時間 2026-11-10 12:00（臺灣）。
const NOW = at('2026-11-10T04:00:00Z')

describe('homeDeadlines（首頁近期截止）', () => {
  it('逾期還沒交的列在最前面、標紅；交過的逾期項目不佔位', () => {
    const list = homeDeadlines(
      [d('later', '2026-12-31T15:59:00Z'), d('late-todo', '2026-11-07T15:59:00Z'), d('late-done', '2026-11-08T15:59:00Z'), d('soon', '2026-11-12T15:59:00Z')],
      new Set(['late-todo']),
      NOW,
    )
    expect(list.map((x) => [x.itemId, x.tone, x.countdown])).toEqual([
      ['late-todo', 'overdue', '逾期 3 天'],
      ['soon', 'soon', '剩 2 天'],
      ['later', 'later', '剩 51 天'],
    ])
  })

  it('今天截止：還沒過是「今天截止」（橘），過了是「今天已截止」（紅）；10 天整還算橘', () => {
    const today = homeDeadlines([d('t', '2026-11-10T15:59:00Z')], new Set(), NOW)
    expect(today[0]).toMatchObject({ overdue: false, tone: 'soon', countdown: '今天截止', days: 0 })
    const passed = homeDeadlines([d('p', '2026-11-10T01:00:00Z')], new Set(['p']), NOW)
    expect(passed[0]).toMatchObject({ overdue: true, tone: 'overdue', countdown: '今天已截止' })
    expect(homeDeadlines([d('ten', '2026-11-20T15:59:00Z')], new Set(), NOW)[0]!.tone).toBe('soon')
    expect(homeDeadlines([d('eleven', '2026-11-21T15:59:00Z')], new Set(), NOW)[0]!.tone).toBe('later')
  })

  it('最多三筆', () => {
    const many = ['a', 'b', 'c', 'e'].map((id, i) => d(id, `2026-11-2${i}T15:59:00Z`))
    expect(homeDeadlines(many, new Set(), NOW).map((x) => x.itemId)).toEqual(['a', 'b', 'c'])
  })
})
