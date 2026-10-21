import { describe, expect, it } from 'vitest'
import { normalizeSchemeStages, SCHEME_LIMITS, type SchemeStageInput } from '@/application/grading/scheme'

const scheme = (stageName: string, itemName = '展示'): SchemeStageInput[] => [
  { name: stageName, weight: 100, items: [{ name: itemName, type: 'number', max: 100, weight: 100 }] },
]

/** 名稱上限以字計（⑤-16、AC-63）：emoji 算 1 字。 */
describe('評分方案名稱的字數上限', () => {
  const max = SCHEME_LIMITS.nameLength

  it('舊結果＝新結果：純中文剛好上限過、多一字擋', () => {
    expect(normalizeSchemeStages(scheme('字'.repeat(max))).ok).toBe(true)
    expect(normalizeSchemeStages(scheme('字'.repeat(max + 1)))).toMatchObject({ ok: false, details: { field: 'stage1.name' } })
    expect(normalizeSchemeStages(scheme('驗收', 'a'.repeat(max + 1)))).toMatchObject({ ok: false, details: { field: 'stage1.item1.name' } })
  })

  it('階段名含 emoji 與中文，剛好上限：通過（.length 會算成上限 +1）', () => {
    const name = `👍中${'字'.repeat(max - 2)}`
    expect(name.length).toBe(max + 1)
    expect(normalizeSchemeStages(scheme(name)).ok).toBe(true)
    expect(normalizeSchemeStages(scheme(`${name}字`))).toMatchObject({ ok: false, details: { field: 'stage1.name' } })
  })

  it('細項名含 emoji 與中文，剛好上限：通過', () => {
    const name = `👍中${'字'.repeat(max - 2)}`
    expect(normalizeSchemeStages(scheme('驗收', name)).ok).toBe(true)
    expect(normalizeSchemeStages(scheme('驗收', `${name}字`))).toMatchObject({ ok: false, details: { field: 'stage1.item1.name' } })
  })
})
