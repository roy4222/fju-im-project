import { describe, expect, it } from 'vitest'
import {
  describePanelMismatch,
  normalizeStageSetting,
  optionalReason,
  panelMismatches,
  panelStageKeys,
  type PanelGroupFacts,
} from '@/application/grading/stage-settings'

/** C1-04：評分項目側表的純規則（設計方案① §1.3、§1.4）。 */

const ITEM = '0190a2b4-1c2d-7e3f-8a9b-0c1d2e3f4a5b'

describe('normalizeStageSetting', () => {
  it('空字串與空白當沒填；說明與評審組去頭尾空白', () => {
    expect(normalizeStageSetting({ itemId: '', description: '  ', panelKey: null })).toEqual({
      ok: true,
      value: { itemId: null, description: null, panelKey: null },
    })
    expect(normalizeStageSetting({ itemId: ITEM, description: ' 依發表當天表現評分 ', panelKey: ' s1 ' })).toEqual({
      ok: true,
      value: { itemId: ITEM, description: '依發表當天表現評分', panelKey: 's1' },
    })
  })

  it('說明 500 字可以、501 字擋；評審組 40 字可以、41 字擋；作業不是 UUID 擋（emoji 算一個字）', () => {
    expect(normalizeStageSetting({ description: '😀'.repeat(500) }).ok).toBe(true)
    expect(normalizeStageSetting({ description: '字'.repeat(501) })).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', details: { field: 'description' } })
    expect(normalizeStageSetting({ panelKey: 'p'.repeat(40) }).ok).toBe(true)
    expect(normalizeStageSetting({ panelKey: 'p'.repeat(41) })).toMatchObject({ ok: false, details: { field: 'panelKey' } })
    expect(normalizeStageSetting({ description: '😀'.repeat(501) })).toMatchObject({ ok: false, details: { field: 'description' } })
    expect(normalizeStageSetting({ panelKey: '😀'.repeat(40) }).ok).toBe(true)
    expect(normalizeStageSetting({ panelKey: '😀'.repeat(41) })).toMatchObject({ ok: false, details: { field: 'panelKey' } })
    expect(normalizeStageSetting({ itemId: 'G01' })).toMatchObject({ ok: false, details: { field: 'itemId' } })
    expect(normalizeStageSetting({ description: 42 })).toMatchObject({ ok: false, details: { field: 'description' } })
  })
})

describe('panelStageKeys（評審組展開）', () => {
  const settings = [
    { stageKey: 's3', panelKey: 'p1' },
    { stageKey: 's1', panelKey: 'p1' },
    { stageKey: 's2', panelKey: null },
    { stageKey: 's9', panelKey: 'p1' },
  ]
  it('屬於評審組 → 同組全部項目（依代號排序），不在目前版本的代號不算', () => {
    expect(panelStageKeys(settings, 's3', ['s1', 's2', 's3'])).toEqual(['s1', 's3'])
    expect(panelStageKeys(settings, 's1', ['s1', 's2', 's3'])).toEqual(['s1', 's3'])
  })
  it('不屬於評審組、沒有側表列 → 只有自己', () => {
    expect(panelStageKeys(settings, 's2', ['s1', 's2', 's3'])).toEqual(['s2'])
    expect(panelStageKeys(settings, 's4', ['s1', 's4'])).toEqual(['s4'])
  })
})

describe('panelMismatches（評審組一致性）', () => {
  const facts = (code: string, s1: string[], s2: string[], req: [number, number] = [2, 2]): PanelGroupFacts => ({
    groupId: code,
    groupCode: code,
    requiredByStage: new Map([
      ['s1', req[0]],
      ['s2', req[1]],
    ]),
    teachersByStage: new Map([
      ['s1', new Set(s1)],
      ['s2', new Set(s2)],
    ]),
  })
  it('老師集合（不管順序）與要幾位老師評都相同 → 沒有不一致；只有一個項目不用比', () => {
    expect(panelMismatches(['s1', 's2'], [facts('G01', ['甲', '乙'], ['乙', '甲']), facts('G02', [], [], [0, 0])])).toEqual([])
    expect(panelMismatches(['s1'], [facts('G01', ['甲'], ['丁'])])).toEqual([])
  })
  it('AC-30b：老師不同或份數不同的組列出來（依代號排序）；沒設定份數當 0', () => {
    const noReq: PanelGroupFacts = { groupId: 'G05', groupCode: 'G05', requiredByStage: new Map([['s1', 0]]), teachersByStage: new Map() }
    expect(
      panelMismatches(
        ['s1', 's2'],
        [facts('G07', ['甲'], ['甲'], [1, 2]), facts('G03', ['甲', '乙'], ['甲', '丁']), facts('G01', ['甲'], ['甲']), noReq],
      ),
    ).toEqual(['G03', 'G07'])
  })
  it('訊息列組別與項目名稱', () => {
    expect(describePanelMismatch(['G03', 'G07'], ['系統驗收', '專題發表'])).toBe(
      'G03、G07 的『系統驗收』與『專題發表』評審不同，請先在評分老師分頁對齊。',
    )
  })
})

describe('optionalReason（X2 理由選填）', () => {
  it('沒給、null、空白 → null；有填去頭尾空白；超過上限擋', () => {
    expect(optionalReason(undefined, '結算理由')).toEqual({ ok: true, value: null })
    expect(optionalReason(null, '結算理由')).toEqual({ ok: true, value: null })
    expect(optionalReason('   ', '結算理由')).toEqual({ ok: true, value: null })
    expect(optionalReason(' 全部送出 ', '結算理由')).toEqual({ ok: true, value: '全部送出' })
    expect(optionalReason('字'.repeat(500), '結算理由').ok).toBe(true)
    expect(optionalReason('字'.repeat(501), '結算理由')).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', message: '結算理由最多 500 字。' })
    expect(optionalReason(3, '結算理由')).toMatchObject({ ok: false, details: { field: 'reason' } })
  })
})

describe('optionalReason 字數改用共用 charLength（⑤-16、AC-63）', () => {
  it('舊結果＝新結果：emoji＋中文剛好上限過、多一字擋', () => {
    const reason = `👍中${'字'.repeat(498)}`
    expect(reason.length).toBe(501)
    expect(optionalReason(reason, '結算理由')).toEqual({ ok: true, value: reason })
    expect(optionalReason(`${reason}字`, '結算理由')).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(optionalReason(`a b\n${'x'.repeat(496)}`, '結算理由')).toMatchObject({ ok: true })
  })
})
