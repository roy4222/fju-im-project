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
  it('逾期的不列（Roy 2026-09-08）；還沒到的近的在前，10 天內橘', () => {
    const list = homeDeadlines(
      [d('later', '2026-12-31T15:59:00Z'), d('late', '2026-11-07T15:59:00Z'), d('soon', '2026-11-12T15:59:00Z')],
      NOW,
    )
    expect(list.map((x) => [x.itemId, x.tone, x.countdown])).toEqual([
      ['soon', 'soon', '剩 2 天'],
      ['later', 'later', '剩 51 天'],
    ])
  })

  it('今天稍晚截止還列「今天截止」；今天稍早已截止就不列；10 天整還算橘', () => {
    expect(homeDeadlines([d('t', '2026-11-10T15:59:00Z')], NOW)[0]).toMatchObject({ tone: 'soon', countdown: '今天截止', days: 0 })
    expect(homeDeadlines([d('p', '2026-11-10T01:00:00Z')], NOW)).toEqual([])
    expect(homeDeadlines([d('ten', '2026-11-20T15:59:00Z')], NOW)[0]!.tone).toBe('soon')
    expect(homeDeadlines([d('eleven', '2026-11-21T15:59:00Z')], NOW)[0]!.tone).toBe('later')
  })

  it('最多三筆', () => {
    const many = ['a', 'b', 'c', 'e'].map((id, i) => d(id, `2026-11-2${i}T15:59:00Z`))
    expect(homeDeadlines(many, NOW).map((x) => x.itemId)).toEqual(['a', 'b', 'c'])
  })
})
