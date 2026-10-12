import { describe, expect, it } from 'vitest'
import { describeRemoveAssignmentReceipt, describeSchemeVersionReceipt } from '@/application/grading/receipts'

/**
 * 第三波 W9（AC-29）：建立方案草稿後的那句話要說清楚「發布」鈕在哪；原句不刪（既有 e2e 比對前半句）。
 */

const receipt = { schemeId: 's', versionId: 'v', versionNo: 2 }

describe('describeSchemeVersionReceipt', () => {
  it('草稿：保留原句，並指出「發布」在版本紀錄裡', () => {
    const text = describeSchemeVersionReceipt({ ...receipt, status: 'draft' })
    expect(text).toContain('已建立評分規則第 2 版（草稿）；按「發布」後老師才會用這一版。')
    expect(text).toContain('「發布」在下方「評分規則」區塊的「版本紀錄」裡，點開後按第 2 版那列的「發布」（評分規則已鎖定時那列是「查看重算影響（尚不套用）」）')
  })

  it('已發布：只說已發布，不再提要按發布', () => {
    const text = describeSchemeVersionReceipt({ ...receipt, status: 'published' })
    expect(text).toBe('評分規則第 2 版已發布，老師評分用這一版。')
  })
})

describe('describeRemoveAssignmentReceipt（第三波 W13b：「要求份數」改白話）', () => {
  it('改派後說「每組需要幾位老師評分」，不再出現「要求份數」', () => {
    const text = describeRemoveAssignmentReceipt({
      groupCode: 'G01',
      stageName: '期中',
      teacherName: '甲',
      newTeacherName: '丁',
      choice: 'replace',
      requiredCount: 2,
    })
    expect(text).toBe('G01「期中」甲 老師 → 丁 老師（替換評分老師、重新評分；每組需要 2 位老師評分）。')
    expect(text).not.toContain('要求份數')
  })
})
