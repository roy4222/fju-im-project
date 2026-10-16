// 面積圖（DV 設計方案 §12 圖表 seam；AC-DV-13 的圖表元件、AC-DV-19 的 health-chart）。
// 檔名用 .ts（vitest include 只收 src/**/*.test.ts），所以用 createElement 不用 JSX。
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { AreaChart, layoutChart, niceMax, type ChartSeries } from './area-chart'

const render = (series: ChartSeries[], unit = 'ms') => renderToStaticMarkup(createElement(AreaChart, { series, unit }))

// 2026-10-12 09:00 台北＝01:00Z；窗口是前一天 09:00～今天 09:00（台北）。
const THREE: ChartSeries[] = [
  {
    id: 'test',
    label: '測試站',
    points: [
      { at: '2026-10-11T13:00:00Z', value: 200 },
      { at: '2026-10-11T19:00:00Z', value: 100 },
      { at: '2026-10-12T01:00:00Z', value: 0 },
    ],
  },
]

describe('niceMax', () => {
  it('取 1、1.5、2、3、4、5、6、8 × 10ⁿ 裡第一個不小於最大值的數；0 或負數回 1', () => {
    expect(niceMax(200)).toBe(200)
    expect(niceMax(213)).toBe(300)
    expect(niceMax(3000)).toBe(3000)
    expect(niceMax(3001)).toBe(4000)
    expect(niceMax(850)).toBe(1000)
    expect(niceMax(0.3)).toBeCloseTo(0.3)
    expect(niceMax(0)).toBe(1)
  })
})

describe('AreaChart', () => {
  it('3 個點：path d 照時間與數值換成座標（X 軸 24h、Y 軸 0～200）', () => {
    // x：窗口 24h 對應 56～708；13:00Z 是第 12 小時 → 382、19:00Z 第 18 小時 → 545、01:00Z 右端 708。
    // y：0～200 對應 192～12；200 → 12、100 → 102、0 → 192。
    expect(layoutChart(THREE).lines[0]!.d).toBe('M382 12 L545 102 L708 192')
    const html = render(THREE)
    expect(html).toContain('<path data-series="test" d="M382 12 L545 102 L708 192"')
    expect(html.match(/<path/g)).toHaveLength(1)
    expect(html).not.toContain('<script')
  })

  it('X 軸是台北時間整點、每 4 小時一個；Y 軸刻度帶單位', () => {
    const html = render(THREE)
    const x = [...html.matchAll(/>(\d{2}:00)<\/text>/g)].map((m) => m[1])
    expect(x).toEqual(['12:00', '16:00', '20:00', '00:00', '04:00', '08:00'])
    for (const y of ['0 ms', '100 ms', '200 ms']) expect(html).toContain(`>${y}</text>`)
  })

  it('兩個系列：兩條 path（data-series 用 id）、圖例兩個名字；沒給 id 時用 label', () => {
    const html = render([
      THREE[0]!,
      { label: 'prod', points: [{ at: '2026-10-12T00:00:00Z', value: 50 }] },
    ])
    expect(html.match(/<path /g)).toHaveLength(2)
    expect(html).toContain('data-series="test"')
    expect(html).toContain('data-series="prod"')
    expect(html).toContain('測試站')
  })

  it('沒有點、只有一點、數值全相同：不出現 NaN，也不丟例外', () => {
    for (const series of [
      [],
      [{ id: 'test', label: '測試站', points: [] }],
      [{ id: 'test', label: '測試站', points: [{ at: '2026-10-12T01:00:00Z', value: 120 }] }],
      [{ id: 'test', label: '測試站', points: THREE[0]!.points.map((p) => ({ ...p, value: 0 })) }],
      [{ id: 'test', label: '測試站', points: [{ at: 'not-a-time', value: 1 }] }],
    ] satisfies ChartSeries[][]) {
      const html = render(series)
      expect(html).not.toContain('NaN')
      expect(html).toContain('<svg')
    }
    expect(render([])).toContain('沒有資料點')
  })

  it('超過 24h 的舊點不畫（只畫最新時間往前 24 小時）', () => {
    const d = layoutChart([
      { id: 't', label: 't', points: [{ at: '2026-10-10T00:00:00Z', value: 100 }, ...THREE[0]!.points] },
    ]).lines[0]!.d
    expect(d.split(' L')).toHaveLength(3)
  })
})
