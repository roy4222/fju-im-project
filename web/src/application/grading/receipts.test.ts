import { describe, expect, it } from 'vitest'
import { describeSchemeVersionReceipt } from '@/application/grading/receipts'

/**
 * 第三波 W9（AC-29）：建立方案草稿後的那句話要說清楚「發布」鈕在哪；原句不刪（既有 e2e 比對前半句）。
 */

const receipt = { schemeId: 's', versionId: 'v', versionNo: 2 }

describe('describeSchemeVersionReceipt', () => {
  it('草稿：保留原句，並指出「發布」在版本紀錄裡', () => {
    const text = describeSchemeVersionReceipt({ ...receipt, status: 'draft' })
    expect(text).toContain('已建立方案 v2（草稿）；按「發布」後老師才會用這一版。')
    expect(text).toContain('「發布」在旁邊的「版本紀錄」裡，點開後按 v2 那列的「發布」（方案已鎖定時那列是「看影響並套用」）')
  })

  it('已發布：只說已發布，不再提要按發布', () => {
    const text = describeSchemeVersionReceipt({ ...receipt, status: 'published' })
    expect(text).toBe('方案 v2 已發布，老師評分用這一版。')
  })
})
