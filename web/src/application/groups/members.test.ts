import { describe, expect, it } from 'vitest'
import {
  CHANGE_REASON_MAX_LENGTH,
  decideLeaderChange,
  decideRemoval,
  describeLeaderChangeReceipt,
  describeMemberChangeReceipt,
  groupSizeWarning,
  normalizeProposeInput,
  normalizeReason,
} from '@/application/groups'

/** 票 14：管理員調整組員與換組長的純規則。 */

const [A, B, C] = ['aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000003']

describe('理由：必填、去空白、有上限', () => {
  it('空白被拒並說是哪個動作；前後空白去掉；超過上限被拒', () => {
    expect(normalizeReason('   ', '加入組員')).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', message: '加入組員一定要填理由。' })
    expect(normalizeReason('  休學  ', '移出組員')).toEqual({ ok: true, value: '休學' })
    expect(normalizeReason('字'.repeat(CHANGE_REASON_MAX_LENGTH + 1), '換組長')).toMatchObject({ ok: false })
    expect(normalizeReason('字'.repeat(CHANGE_REASON_MAX_LENGTH), '換組長')).toMatchObject({ ok: true })
  })
})

describe('人數與設定不符：只提醒', () => {
  it('落在範圍內沒有提醒；少於最少、多於最多各有一句', () => {
    expect(groupSizeWarning(5, { min: 5, max: 5 })).toBeNull()
    expect(groupSizeWarning(4, { min: 3, max: 5 })).toBeNull()
    expect(groupSizeWarning(4, { min: 5, max: 5 })).toBe('人數與設定不符：4 人，少於本屆每組最少 5 人')
    expect(groupSizeWarning(6, { min: 5, max: 5 })).toBe('人數與設定不符：6 人，超過本屆每組最多 5 人')
  })

  it('學生提案那一端照設定擋（票 13 已做；這裡再釘一次：設定改成 3–4 人，五人提案被拒）', () => {
    const others = ['410000002', '410000003', '410000004', '410000005']
    expect(normalizeProposeInput({ groupType: 'general', memberStudentNos: others }, { min: 3, max: 4 }, '410000001')).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
    })
    expect(
      normalizeProposeInput({ groupType: 'general', memberStudentNos: others.slice(0, 3) }, { min: 3, max: 4 }, '410000001'),
    ).toMatchObject({ ok: true })
  })
})

describe('移出的前置條件', () => {
  it('移出普通成員：不需要接任；多給接任被拒', () => {
    expect(decideRemoval({ memberIds: [A, B, C], leaderId: A, targetId: B, successorId: null })).toEqual({ ok: true, leaderChange: false })
    expect(decideRemoval({ memberIds: [A, B, C], leaderId: A, targetId: B, successorId: C })).toMatchObject({ ok: false })
  })

  it('移出組長：沒指定接任被拒；接任不能是自己或組外的人；指定留下的成員就換組長', () => {
    expect(decideRemoval({ memberIds: [A, B, C], leaderId: A, targetId: A, successorId: null })).toMatchObject({
      ok: false,
      message: '要移出的是組長：請同時指定接任的組長。',
    })
    expect(decideRemoval({ memberIds: [A, B, C], leaderId: A, targetId: A, successorId: A })).toMatchObject({ ok: false })
    expect(
      decideRemoval({ memberIds: [A, B], leaderId: A, targetId: A, successorId: 'bbbbbbbb-0000-4000-8000-000000000009' }),
    ).toMatchObject({ ok: false })
    expect(decideRemoval({ memberIds: [A, B, C], leaderId: A, targetId: A, successorId: C })).toEqual({ ok: true, leaderChange: true })
  })

  it('移出最後一人：要走解散（之後才開放），先擋；已經不在組裡 → NOT_MEMBER', () => {
    expect(decideRemoval({ memberIds: [A], leaderId: A, targetId: A, successorId: null })).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
    })
    const last = decideRemoval({ memberIds: [A], leaderId: A, targetId: A, successorId: null })
    if (!last.ok) expect(last.message).toContain('解散')
    expect(decideRemoval({ memberIds: [A, B], leaderId: A, targetId: C, successorId: null })).toMatchObject({ ok: false, code: 'NOT_MEMBER' })
  })
})

describe('換組長的前置條件', () => {
  it('新組長要是成員、不能是現任', () => {
    expect(decideLeaderChange({ memberIds: [A, B], leaderId: A, newLeaderId: B })).toEqual({ ok: true })
    expect(decideLeaderChange({ memberIds: [A, B], leaderId: A, newLeaderId: A })).toMatchObject({ ok: false })
    expect(decideLeaderChange({ memberIds: [A, B], leaderId: A, newLeaderId: C })).toMatchObject({ ok: false })
  })
})

describe('回饋句子', () => {
  it('加入且超過設定：說現在幾人並帶提醒；移出組長：說誰接任；換組長：說不需要重簽', () => {
    expect(
      describeMemberChangeReceipt({
        groupId: A,
        groupCode: 'G01',
        change: 'added',
        memberName: '王小明',
        memberCount: 6,
        sizeWarning: groupSizeWarning(6, { min: 5, max: 5 }),
        newLeaderName: null,
      }),
    ).toBe('已把 王小明 加入 G01；現在 6 人（人數與設定不符：6 人，超過本屆每組最多 5 人）。全組已收到通知。')
    expect(
      describeMemberChangeReceipt({
        groupId: A,
        groupCode: 'G01',
        change: 'removed',
        memberName: '王小明',
        memberCount: 4,
        sizeWarning: null,
        newLeaderName: '李小華',
      }),
    ).toBe('已把 王小明 移出 G01，組長改由 李小華 接任；現在 4 人。全組已收到通知。')
    expect(describeLeaderChangeReceipt({ groupId: A, groupCode: 'G01', previousLeaderName: '王小明', leaderName: '李小華' })).toContain(
      '不需要重簽',
    )
  })
})
