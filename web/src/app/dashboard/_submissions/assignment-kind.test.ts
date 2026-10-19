import { describe, expect, it } from 'vitest'
import { formLabel } from '@/app/dashboard/_submissions/assignment-kind'

describe('formLabel：清單「形式」欄（AC-16、AC-24）', () => {
  it('一般作業看欄位：檔案／表單／表單＋檔案', () => {
    expect(formLabel({ kind: 'assignment', formType: 'file' })).toBe('檔案')
    expect(formLabel({ kind: 'assignment', formType: 'form' })).toBe('表單')
    expect(formLabel({ kind: 'assignment', formType: 'mixed' })).toBe('表單＋檔案')
  })

  it('同意書兩種模式都寫「同意書」（上傳簽名檔的也是，不寫「檔案」）', () => {
    expect(formLabel({ kind: 'consent_form', formType: 'form' })).toBe('同意書')
    expect(formLabel({ kind: 'consent_upload', formType: 'file' })).toBe('同意書')
  })

  it('沒帶種類與形式：當一般作業的表單', () => {
    expect(formLabel({})).toBe('表單')
    expect(formLabel({ formType: 'file' })).toBe('檔案')
  })
})
