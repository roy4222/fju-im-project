import { describe, expect, it } from 'vitest'
import { describePreviewFinal } from '@/app/dashboard/admin/grading/preview-final'

describe('改派與新版影響頁的最終成績：有人工更正時標「更正前計算值」（驗收 P-33）', () => {
  it('有生效中的更正：標更正前計算值，並說明之後更正要重新確認', () => {
    const d = describePreviewFinal({ before: '87.92', after: '86.07', hasOverride: true })
    expect(d.label).toBe('最終成績（更正前計算值）')
    expect(d.value).toBe('更正前 87.92 → 重算後 86.07')
    expect(d.note).toBe('這一組已有人工更正，成績表目前採更正值；這裡是更正前算出來的值。執行後更正要重新確認，確認前成績採重算後的值。')
  })

  it('有更正但數字不變：仍標更正前計算值', () => {
    expect(describePreviewFinal({ before: '87.92', after: '87.92', hasOverride: true }).value).toBe('更正前 87.92')
  })

  it('沒有更正：照舊顯示，沒有註記', () => {
    expect(describePreviewFinal({ before: '87.59', after: '88.32', hasOverride: false })).toEqual({ label: '最終成績', value: '87.59 → 88.32', note: '' })
    expect(describePreviewFinal({ before: null, after: null, hasOverride: false }).value).toBe('尚未完成')
  })
})
