import { describe, expect, it } from 'vitest'
import {
  describeUnassignedStatus,
  describeUnassignedVoid,
  skillChips,
  summarizeUnassigned,
  unassignedStatus,
  type UnassignedProposal,
} from '@/application/groups/unassigned'

/**
 * C3-15：系辦「未分組學生」每列狀態與頂端數字（設計方案③ §6.3；AC-C3-19）。
 */

// 臺灣 3/9 23:30（UTC 3/9 15:30）：M/D 要照臺灣日期算，不是 UTC。
const proposalOf = (id: string, proposerName = '發起人E'): UnassignedProposal => ({
  id,
  proposerName,
  expiresBusinessAt: new Date('2027-03-09T15:30:00Z'),
})

describe('unassignedStatus', () => {
  it('在建立中的組別裡優先，就算本人有公開找隊員', () => {
    expect(unassignedStatus({ openToJoin: true, proposal: proposalOf('p1') })).toBe('in_proposal')
    expect(unassignedStatus({ openToJoin: false, proposal: proposalOf('p1') })).toBe('in_proposal')
  })

  it('不在建立中：公開找隊員或可加入', () => {
    expect(unassignedStatus({ openToJoin: true, proposal: null })).toBe('open_to_join')
    expect(unassignedStatus({ openToJoin: false, proposal: null })).toBe('available')
  })
})

describe('describeUnassignedStatus', () => {
  it('三種狀態字', () => {
    expect(describeUnassignedStatus({ openToJoin: false, proposal: null })).toBe('可加入')
    expect(describeUnassignedStatus({ openToJoin: true, proposal: null })).toBe('公開找隊員')
    expect(describeUnassignedStatus({ openToJoin: true, proposal: proposalOf('p1', 'E') })).toBe('建立中（發起人 E，到期 3/9）')
  })

  it('到期日照臺灣時間：UTC 3/9 16:00 是臺灣 3/10', () => {
    const proposal = { ...proposalOf('p1', 'E'), expiresBusinessAt: new Date('2027-03-09T16:00:00Z') }
    expect(describeUnassignedStatus({ openToJoin: false, proposal })).toBe('建立中（發起人 E，到期 3/10）')
  })
})

describe('summarizeUnassigned', () => {
  it('人數、公開找隊員人數、建立中以組別計（同一份兩個人只算一份）', () => {
    const p = proposalOf('p1')
    expect(
      summarizeUnassigned([
        { openToJoin: false, proposal: null },
        { openToJoin: true, proposal: null },
        { openToJoin: false, proposal: p },
        { openToJoin: false, proposal: p },
      ]),
    ).toBe('4 人未分組・1 人公開找隊員・1 份建立中')
  })

  it('兩份不同的建立中各算一份；公開找隊員照本人設定算（在建立中也算）', () => {
    expect(
      summarizeUnassigned([
        { openToJoin: true, proposal: proposalOf('p1') },
        { openToJoin: false, proposal: proposalOf('p2') },
      ]),
    ).toBe('2 人未分組・1 人公開找隊員・2 份建立中')
  })

  it('沒有人', () => {
    expect(summarizeUnassigned([])).toBe('0 人未分組・0 人公開找隊員・0 份建立中')
  })
})

describe('skillChips', () => {
  it('最多 3 個，其餘收成 +N', () => {
    expect(skillChips(['前端', 'AI', '後端', '設計', '簡報'])).toEqual({ shown: ['前端', 'AI', '後端'], more: 2 })
  })

  it('不滿 3 個全部顯示，沒有 +N', () => {
    expect(skillChips(['前端', 'AI'])).toEqual({ shown: ['前端', 'AI'], more: 0 })
    expect(skillChips([])).toEqual({ shown: [], more: 0 })
    expect(skillChips(['a', 'b', 'c'])).toEqual({ shown: ['a', 'b', 'c'], more: 0 })
  })
})

describe('describeUnassignedVoid', () => {
  it('成功的回饋句', () => {
    expect(describeUnassignedVoid('E')).toBe('已終止 E 建立中的組別')
  })
})
