import { describe, expect, it } from 'vitest'
import { normalizeScores, summarizeScores } from '@/application/grading/evaluation'
import { collectSchemeKeys, normalizeSchemeStages, readSchemeStages, type SchemeStageInput } from '@/application/grading/scheme'
import { averageScore, formatScore, parseItemScore, teacherStageScore } from '@/shared/score'

/**
 * 票 23：評分方案的權重驗證、分數驗證與 decimal 計算（產品模組 06 §4「7.2」「7.3」「7.4」；案例 GRD-01、GRD-05、GRD-06、GRD-12）。
 */

const number = (name: string, weight: number, max = 100) => ({ name, type: 'number', max, weight })

function stages(...list: SchemeStageInput[]): SchemeStageInput[] {
  return list
}

describe('方案權重（GRD-01）', () => {
  it('階段 60／50 合計 110：被拒，而且說出合計是多少', () => {
    const result = normalizeSchemeStages(
      stages(
        { name: '系統驗收', weight: 60, items: [number('展示', 100)] },
        { name: '專題發表', weight: 50, items: [number('發表', 100)] },
      ),
    )
    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', details: { field: 'stageWeights' } })
    if (!result.ok) expect(result.message).toContain('110%')
  })

  it('階段 60／30 合計 90 也被拒', () => {
    const result = normalizeSchemeStages(
      stages({ name: 'A', weight: 60, items: [number('x', 100)] }, { name: 'B', weight: 30, items: [number('y', 100)] }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('90%')
  })

  it('項目權重不合 100：指出是哪一個階段', () => {
    const result = normalizeSchemeStages(
      stages(
        { name: '系統驗收', weight: 60, items: [number('展示', 50), number('文件', 40)] },
        { name: '專題發表', weight: 40, items: [number('發表', 100)] },
      ),
    )
    expect(result).toMatchObject({ ok: false, details: { field: 'stage1.itemWeights' } })
    if (!result.ok) expect(result.message).toContain('「系統驗收」的項目權重合計是 90%')
  })

  it('合法：60／40、項目 50／50；沒有 key 的階段與項目補上 s1、i1…', () => {
    const result = normalizeSchemeStages(
      stages(
        { name: '系統驗收', weight: 60, items: [number('展示', 50), number('文件', 50)] },
        { name: '專題發表', weight: 40, items: [number('發表', 100)] },
      ),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.map((s) => s.key)).toEqual(['s1', 's2'])
    expect(result.value[0]!.items.map((i) => i.key)).toEqual(['i1', 'i2'])
    expect(result.value[0]!.letterMap).toBeNull()
  })

  it('既有的 key 保留，新加的避開已用的', () => {
    const result = normalizeSchemeStages(
      stages(
        { key: 's2', name: '舊', weight: 50, items: [{ key: 'i1', ...number('x', 100) }] },
        { name: '新', weight: 50, items: [number('y', 100)] },
      ),
    )
    expect(result.ok && result.value.map((s) => s.key)).toEqual(['s2', 's1'])
  })

  it('刪掉的代號不會重用：歷來版本用過 s1、i1，新增的階段與項目拿新的代號（審查 P1）', () => {
    const v1 = normalizeSchemeStages(
      stages(
        { name: '系統驗收', weight: 60, items: [number('功能', 50), number('文件', 50)] },
        { name: '專題發表', weight: 40, items: [number('發表', 100)] },
      ),
    )
    if (!v1.ok) throw new Error('fixture')
    expect(v1.value.map((s) => s.key)).toEqual(['s1', 's2'])
    // 項目代號整個方案不重複：第二階段的項目接著編。
    expect(v1.value.flatMap((s) => s.items.map((i) => i.key))).toEqual(['i1', 'i2', 'i3'])

    // v2：刪掉 s1、保留 s2 但刪掉它的項目，各新增一個——都不能拿回 s1／i1／i3。
    const v2 = normalizeSchemeStages(
      stages(
        { key: 's2', name: '專題發表', weight: 50, items: [number('新發表項目', 100)] },
        { name: '新的階段', weight: 50, items: [number('新項目', 100)] },
      ),
      collectSchemeKeys([v1.value]),
    )
    if (!v2.ok) throw new Error(v2.message)
    expect(v2.value.map((s) => s.key)).toEqual(['s2', 's3'])
    const newItemKeys = v2.value.flatMap((s) => s.items.map((i) => i.key))
    expect(newItemKeys).toEqual(['i4', 'i5'])
    for (const old of ['i1', 'i2', 'i3']) expect(newItemKeys).not.toContain(old)
  })

  it('等第項目：帶版本化的對照表（沒給用預設）；對照表要由 A 到 F 遞減', () => {
    const ok = normalizeSchemeStages(
      stages({ name: '發表', weight: 100, items: [number('內容', 60), { name: '台風', type: 'letter', weight: 40 }] }),
    )
    expect(ok.ok && ok.value[0]!.letterMap).toEqual({ A: 95, B: 85, C: 75, D: 65, F: 50 })
    expect(ok.ok && ok.value[0]!.items[1]).toMatchObject({ type: 'letter', max: null, weight: 40 })

    const bad = normalizeSchemeStages(
      stages({
        name: '發表',
        weight: 100,
        letterMap: { A: 80, B: 90, C: 70, D: 60, F: 40 },
        items: [{ name: '台風', type: 'letter', weight: 100 }],
      }),
    )
    expect(bad).toMatchObject({ ok: false, details: { field: 'stage1.letterMap' } })
  })

  it('通過／不通過是 Gate：不占權重、不算進合計，但一個階段不能只有它', () => {
    const ok = normalizeSchemeStages(
      stages({ name: '驗收', weight: 100, items: [number('功能', 100), { name: '可以運作', type: 'passfail', weight: 30 }] }),
    )
    expect(ok.ok && ok.value[0]!.items[1]).toMatchObject({ type: 'passfail', max: null, weight: 0 })

    const only = normalizeSchemeStages(stages({ name: '驗收', weight: 100, items: [{ name: '可以運作', type: 'passfail', weight: 0 }] }))
    expect(only.ok).toBe(false)
  })

  it('數字項目要有 1 以上的整數滿分；型態只收三種；名稱不能空、不能重複', () => {
    expect(normalizeSchemeStages(stages({ name: 'A', weight: 100, items: [number('x', 100, 0)] }))).toMatchObject({
      ok: false,
      details: { field: 'stage1.item1.max' },
    })
    expect(normalizeSchemeStages(stages({ name: 'A', weight: 100, items: [{ name: 'x', type: 'excel', weight: 100 }] }))).toMatchObject({
      ok: false,
      details: { field: 'stage1.item1.type' },
    })
    expect(normalizeSchemeStages(stages({ name: ' ', weight: 100, items: [number('x', 100)] }))).toMatchObject({ ok: false })
    expect(
      normalizeSchemeStages(stages({ name: 'A', weight: 50, items: [number('x', 100)] }, { name: 'A', weight: 50, items: [number('y', 100)] })),
    ).toMatchObject({ ok: false, details: { field: 'stages' } })
    expect(normalizeSchemeStages([])).toMatchObject({ ok: false })
  })

  it('讀回資料庫的 jsonb 不會因為壞資料炸掉', () => {
    expect(readSchemeStages(null)).toEqual([])
    expect(readSchemeStages([{ key: 's1', name: 'A', weight: 100, items: [{ key: 'i1', name: 'x', type: 'number', max: 100, weight: 100 }] }])[0])
      .toMatchObject({ key: 's1', letterMap: null, items: [{ key: 'i1', max: 100 }] })
  })
})

const STAGE = (() => {
  const r = normalizeSchemeStages(
    stages({
      name: '發表',
      weight: 100,
      items: [number('內容', 60), { name: '台風', type: 'letter', weight: 40 }, { name: '準時', type: 'passfail', weight: 0 }],
    }),
  )
  if (!r.ok) throw new Error('fixture')
  return r.value[0]!
})()

describe('分數輸入（GRD-12）', () => {
  it('101、負數、三位小數、非數字都被拒，指出是哪一項', () => {
    for (const bad of ['101', '-1', '80.123', 'abc']) {
      const result = normalizeScores(STAGE, { i1: bad }, { complete: false })
      expect(result, bad).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', details: { field: 'i1' } })
    }
  })

  it('暫存可以只填一部分；正式送出要填齊，說還差幾項', () => {
    expect(normalizeScores(STAGE, { i1: '80' }, { complete: false })).toEqual({ ok: true, value: { i1: '80' } })
    const missing = normalizeScores(STAGE, { i1: '80' }, { complete: true })
    expect(missing).toMatchObject({ ok: false, details: { fields: ['i2', 'i3'] } })
    if (!missing.ok) expect(missing.message).toContain('還差 2 項')
  })

  it('方案沒有的項目一律拒絕，不默默丟掉', () => {
    expect(normalizeScores(STAGE, { i1: '80', hacked: '100' }, { complete: false })).toMatchObject({ ok: false })
  })

  it('數字正規化（80.50 → 80.5）、等第不分大小寫、通過只收 pass／fail', () => {
    expect(normalizeScores(STAGE, { i1: '80.50', i2: 'b', i3: 'pass' }, { complete: true })).toEqual({
      ok: true,
      value: { i1: '80.5', i2: 'B', i3: 'pass' },
    })
    expect(normalizeScores(STAGE, { i3: 'yes' }, { complete: false })).toMatchObject({ ok: false, details: { field: 'i3' } })
  })
})

describe('decimal 計算與捨入（GRD-05、GRD-06）', () => {
  it('單一老師：80×60% ＋ B(85)×40% ＝ 82；通過／不通過另外顯示，不進分數', () => {
    expect(summarizeScores(STAGE, { i1: '80', i2: 'B', i3: 'fail' })).toEqual({ score: '82.00', filled: 3, total: 3, gate: 'fail' })
    expect(summarizeScores(STAGE, { i1: '80', i2: 'B', i3: 'pass' }).gate).toBe('pass')
    expect(summarizeScores(STAGE, { i1: '80', i2: 'B' }).gate).toBe('incomplete')
  })

  it('滿分不是 100 的項目先換成百分成績', () => {
    const r = teacherStageScore([{ key: 'a', type: 'number', max: 40, weight: 100 }], null, { a: '33' })
    expect(formatScore(r.score)).toBe('82.50')
  })

  it('平均 80 與 84.29 ＝ 82.145，顯示 82.15（round-half-up，不是先捨入中間值）', () => {
    const avg = averageScore(['80', '84.29'])!
    expect(avg.toString()).toBe('82.145')
    expect(formatScore(avg)).toBe('82.15')
  })

  it('最終 82.145×60% ＋ 90×40% ＝ 85.287，顯示 85.29', () => {
    const final = averageScore(['82.145'])!.times(60).dividedBy(100).plus(averageScore(['90'])!.times(40).dividedBy(100))
    expect(final.toString()).toBe('85.287')
    expect(formatScore(final)).toBe('85.29')
  })

  it('浮點會錯的例子用 decimal 算對：0.1＋0.2 類的組合', () => {
    const r = teacherStageScore(
      [
        { key: 'a', type: 'number', max: 100, weight: 10 },
        { key: 'b', type: 'number', max: 100, weight: 90 },
      ],
      null,
      { a: '0.1', b: '0.2' },
    )
    expect(r.score.toString()).toBe('0.19')
  })

  it('parseItemScore：邊界 0 與滿分合法', () => {
    const item = { key: 'a', type: 'number' as const, max: 100, weight: 100 }
    expect(parseItemScore(item, '0')).toEqual({ ok: true, value: '0' })
    expect(parseItemScore(item, '100.00')).toEqual({ ok: true, value: '100' })
    expect(parseItemScore(item, '100.01')).toEqual({ ok: false, reason: 'range' })
  })
})
