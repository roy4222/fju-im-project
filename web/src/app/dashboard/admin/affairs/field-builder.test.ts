import { describe, expect, it } from 'vitest'
import {
  CONSENT_FILE_KEY,
  fieldLock,
  MAIN_FIELD_TYPES,
  MORE_FIELD_TYPES,
  moveField,
  shiftField,
} from '@/app/dashboard/admin/affairs/item-form-model'

/**
 * 表單產生器的純模型（C 階段規格① §2.4、AC-4、AC-5、AC-24）：拖放後的順序、上移／下移、鎖定規則、型別清單。
 * 畫面（原生 HTML5 drag＋上下移按鈕）只呼叫這幾個函式，順序就是存進 schema 的順序（學生端照 schema 順序渲染）。
 */

describe('拖放與上下移', () => {
  const abc = ['A', 'B', 'C']

  it('把 C 拖到最上面 → C、A、B；再把 B 上移到第一 → B、C、A（AC-4）', () => {
    const dragged = moveField(abc, 2, 0)
    expect(dragged).toEqual(['C', 'A', 'B'])
    const once = shiftField(dragged, 2, -1)
    expect(once).toEqual(['C', 'B', 'A'])
    expect(shiftField(once, 1, -1)).toEqual(['B', 'C', 'A'])
  })

  it('往下拖：放到目標那一列的位置，中間的往前擠', () => {
    expect(moveField(['A', 'B', 'C', 'D'], 0, 2)).toEqual(['B', 'C', 'A', 'D'])
  })

  it('同一列、超出範圍、到頂上移、到底下移：不變（回新陣列，不改原陣列）', () => {
    expect(moveField(abc, 1, 1)).toEqual(abc)
    expect(moveField(abc, 0, 3)).toEqual(abc)
    expect(moveField(abc, -1, 0)).toEqual(abc)
    expect(shiftField(abc, 0, -1)).toEqual(abc)
    expect(shiftField(abc, 2, 1)).toEqual(abc)
    const before = [...abc]
    moveField(abc, 2, 0)
    expect(abc).toEqual(before)
  })
})

describe('鎖定規則', () => {
  it('沒人交過：結構可改、可刪', () => {
    expect(fieldLock({ key: 'fa' }, { hasResponses: false, consentMode: null })).toEqual({ structure: false, removable: true })
  })

  it('有人交過：結構鎖住（型別、順序、刪除），只能改欄名與說明（AC-5）', () => {
    expect(fieldLock({ key: 'fa' }, { hasResponses: true, consentMode: null })).toEqual({ structure: true, removable: false })
  })

  it('下載再上傳的同意書：「簽好的同意書」不能刪，其他欄可以（AC-24）', () => {
    expect(fieldLock({ key: CONSENT_FILE_KEY }, { hasResponses: false, consentMode: 'upload' })).toEqual({ structure: false, removable: false })
    expect(fieldLock({ key: 'fx' }, { hasResponses: false, consentMode: 'upload' }).removable).toBe(true)
    // 一般作業剛好用了同一個代號也不受影響。
    expect(fieldLock({ key: CONSENT_FILE_KEY }, { hasResponses: false, consentMode: null }).removable).toBe(true)
  })
})

describe('型別清單（§2.4）', () => {
  it('常用 8 種照順序在前，其餘 5 種在「更多型別」；合起來正好是既有 FIELD_TYPES 的 13 種、不重複', () => {
    expect(MAIN_FIELD_TYPES).toEqual(['text', 'textarea', 'radio', 'checkbox', 'select', 'file', 'date', 'paragraph'])
    const all = [...MAIN_FIELD_TYPES, ...MORE_FIELD_TYPES]
    expect(new Set(all).size).toBe(13)
    expect([...all].sort()).toEqual(
      ['checkbox', 'date', 'email', 'file', 'heading', 'number', 'paragraph', 'radio', 'select', 'text', 'textarea', 'time', 'url'],
    )
  })
})
