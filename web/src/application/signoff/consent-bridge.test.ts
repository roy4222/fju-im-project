import { describe, expect, it } from 'vitest'
import {
  consentSkipReason,
  contentChangedRecipients,
  contentChangedTitle,
  describeMissingDrafts,
  GROUP_REMOVED_REASON,
  rebuildsOnContentChange,
} from '@/application/signoff/consent-bridge'
import { describeCause, VOID_CAUSE, type Participants, type SignoffState } from '@/application/signoff/version'

/** C1-03 同意書橋接的純規則（C 階段規格① §1.2、§3.1；AC-21、AC-21b、AC-23、AC-23a、AC-25）。 */

describe('發布同意書作業：哪些組建包、哪些跳過（AC-21、AC-25）', () => {
  it('沒有主指導 → no_advisor（先看老師）；有老師沒組員 → no_members；兩者都有 → 可以建', () => {
    expect(consentSkipReason({ memberCount: 0, hasAdvisor: false })).toBe('no_advisor')
    expect(consentSkipReason({ memberCount: 3, hasAdvisor: false })).toBe('no_advisor')
    expect(consentSkipReason({ memberCount: 0, hasAdvisor: true })).toBe('no_members')
    expect(consentSkipReason({ memberCount: 3, hasAdvisor: true })).toBeNull()
  })

  it('最終文件授權缺草稿的句子列出組別（AC-21b）', () => {
    expect(describeMissingDrafts(['G01', 'G04'])).toBe('這些組還沒有成果展示草稿：G01、G04')
  })
})

describe('內容改版（AC-23、AC-23a）', () => {
  it('收集中、等老師、已完成、退回修正中都建新版；已失效、已作廢不動', () => {
    const yes: SignoffState[] = ['collecting', 'teacher_pending', 'complete', 'revision']
    const no: SignoffState[] = ['superseded', 'void']
    for (const s of yes) expect(rebuildsOnContentChange(s)).toBe(true)
    for (const s of no) expect(rebuildsOnContentChange(s)).toBe(false)
  })

  it('content_changed 收件人＝被取代那一版的全部學生＋主指導（含已同意的人），不重複、不含空 ID', () => {
    const previous: Participants = {
      students: [
        { userId: 's1', displayName: '甲', studentNo: '1', membershipId: 'm1' },
        { userId: 's2', displayName: '乙', studentNo: '2', membershipId: 'm2' },
      ],
      advisor: { userId: 't1', displayName: '老師', assignmentId: 'a1' },
    }
    expect(contentChangedRecipients(previous)).toEqual(['s1', 's2', 't1'])
    expect(contentChangedRecipients({ ...previous, advisor: { userId: '', displayName: '（無）', assignmentId: '' } })).toEqual(['s1', 's2'])
  })

  it('通知標題帶組別、用途、版本', () => {
    expect(contentChangedTitle('G01', '期中結果確認')).toBe('G01「期中結果確認」同意書內容已更新，請重新閱讀並同意')
  })
})

describe('固定代碼（§1.4：理由選填後 cause 不再放理由）', () => {
  it('void 翻成「系辦作廢」、沒填理由的不同意／退回翻成角色；移出對象的理由固定', () => {
    expect(VOID_CAUSE).toBe('void')
    expect(describeCause('void')).toBe('系辦作廢')
    expect(describeCause('disagree')).toBe('學生不同意')
    expect(describeCause('return')).toBe('指導老師退回')
    expect(describeCause('第三章數據有誤')).toBe('第三章數據有誤')
    expect(describeCause('content_change')).toBe('內容變更')
    expect(GROUP_REMOVED_REASON).toBe('系辦移出對象')
  })
})
