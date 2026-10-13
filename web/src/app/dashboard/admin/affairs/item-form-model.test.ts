import { describe, expect, it } from 'vitest'
import { notifyPreviewText } from '@/app/dashboard/admin/affairs/item-form-model'

describe('發布前檢查的「會通知幾位」說明（驗收第 2 章 P-06）', () => {
  it('新發布的公告／資源：只有勾「重要公告」才通知，句子照實寫條件', () => {
    expect(notifyPreviewText(12, 'important')).toBe('若勾選「重要公告」，會通知 12 位。')
  })

  it('修改已發布的項目：勾了通知這次的修改才通知', () => {
    expect(notifyPreviewText(8, 'update')).toBe('若勾選通知這次的修改，會通知 8 位。')
  })

  it('榮譽榜不發通知；對象裡沒有人時照舊說沒有可以通知的人', () => {
    expect(notifyPreviewText(12, 'never')).toBe('榮譽榜不發站內通知。')
    expect(notifyPreviewText(0, 'important')).toBe('這個對象目前沒有可以通知的人。')
  })
})
