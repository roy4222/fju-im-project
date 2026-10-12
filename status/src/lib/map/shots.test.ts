// 截圖路由的放行規則（§3.9）：只認網址形狀與 summary.json 有列到的檔。
import { describe, expect, it } from 'vitest'

import type { SummaryJson } from '../data/types'
import { listedShots, parseShotPath } from './shots'

describe('parseShotPath', () => {
  it('四段、第三段是 screenshots、副檔名是圖 → 放行並回 content-type', () => {
    expect(parseShotPath(['night-20261012-2200', 'story-1', 'screenshots', '01-home.PNG'])).toEqual({
      runId: 'night-20261012-2200', item: 'story-1', rel: 'story-1/screenshots/01-home.PNG', contentType: 'image/png',
    })
  })

  it.each([
    [['night-1', '..', '..', 'secrets', 'tunnel.json']],
    [['night-1', '..', 'screenshots', 'a.png']],
    [['..', 'story-1', 'screenshots', 'a.png']],
    [['night-1', 'story-1', 'screenshots', '.']],
    [['night-1', 'story-1', 'logs', 'a.png']],
    [['night-1', 'story-1', 'screenshots', 'report.md']],
    [['night-1', 'story-1', 'screenshots', 'a b.png']],
    [['night-1', 'story-1', 'screenshots', 'sub', 'a.png']],
    [['night-1', 'summary.json']],
    [['night-1', 'story-1', 'screenshots', 'a.constructor']],
    [['night-1', 'story-1', 'screenshots', 'a.toString']],
    [['night-1', 'story-1', 'screenshots', 'a.__proto__']],
  ])('擋下 %j', (segments) => {
    expect(parseShotPath(segments)).toBeNull()
  })
})

describe('listedShots', () => {
  it('收集每個 item 每一步的截圖；沒有 steps 或截圖不是陣列也不壞', () => {
    const summary = {
      items: [
        { id: 'story-1', steps: [{ 截圖: ['story-1/screenshots/a.png'] }, { 截圖: [] }] },
        { id: 'story-2', steps: [{ 截圖: 'story-2/screenshots/b.png' }] },
        { id: 'story-3' },
      ],
    } as unknown as SummaryJson
    expect([...listedShots(summary)]).toEqual(['story-1/screenshots/a.png'])
  })
})
