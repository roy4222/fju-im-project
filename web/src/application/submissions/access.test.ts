import { describe, expect, it } from 'vitest'
import { canReadSubmission, describeReceipt, type SubmissionHolder, type SubmissionViewer } from '@/application/submissions'

/**
 * 票 21：誰能讀一份繳交與它的附件（契約 03 §1 的「組別共用草稿」「組別正式版本」「個人回答」三列）。
 * 下載政策每次都經這個函式；事實（此刻的組員、目前主指導、閱覽設定）由 infrastructure 當下重查。
 */

const S1 = 'user-s1'
const S6 = 'user-s6'
const T1 = 'user-t1'
const T3 = 'user-t3'
const G1 = 'group-g1'
const G2 = 'group-g2'

function viewer(patch: Partial<SubmissionViewer> = {}): SubmissionViewer {
  return { userId: S1, isAdmin: false, isTeacher: false, memberOfGroupIds: [], ...patch }
}

const groupDraft: SubmissionHolder = { kind: 'draft', receiverKind: 'group', receiverId: G1 }
const groupVersion: SubmissionHolder = {
  kind: 'version',
  receiverKind: 'group',
  receiverId: G1,
  schemaVersionNo: 1,
  currentAdvisorUserId: T1,
  visibility: null,
  membershipSnapshot: [S1, 'user-s2'],
}
const personalVersion = (patch: Partial<Extract<SubmissionHolder, { kind: 'version' }>> = {}): SubmissionHolder => ({
  kind: 'version',
  receiverKind: 'user',
  receiverId: S1,
  schemaVersionNo: 2,
  currentAdvisorUserId: T1,
  visibility: { enabled: true, effectiveFromVersionNo: 2 },
  membershipSnapshot: null,
  ...patch,
})

describe('組別共用草稿', () => {
  it('此刻的有效組員與管理員可以讀；別組、被移出的人、主指導都不行', () => {
    expect(canReadSubmission(viewer({ memberOfGroupIds: [G1] }), groupDraft)).toBe(true)
    expect(canReadSubmission(viewer({ isAdmin: true }), groupDraft)).toBe(true)
    expect(canReadSubmission(viewer({ userId: S6, memberOfGroupIds: [G2] }), groupDraft)).toBe(false)
    expect(canReadSubmission(viewer({ memberOfGroupIds: [] }), groupDraft)).toBe(false)
    expect(canReadSubmission(viewer({ userId: T1, isTeacher: true }), groupDraft)).toBe(false)
  })
})

describe('組別正式版本', () => {
  it('有效組員、目前主指導、管理員可以讀；換掉的老師與別組不行', () => {
    expect(canReadSubmission(viewer({ memberOfGroupIds: [G1] }), groupVersion)).toBe(true)
    expect(canReadSubmission(viewer({ userId: T1, isTeacher: true }), groupVersion)).toBe(true)
    expect(canReadSubmission(viewer({ isAdmin: true }), groupVersion)).toBe(true)
    expect(canReadSubmission(viewer({ userId: T3, isTeacher: true }), groupVersion)).toBe(false)
    expect(canReadSubmission(viewer({ userId: S6, memberOfGroupIds: [G2] }), groupVersion)).toBe(false)
    // 老師角色被撤銷了，就算還掛著主指導也不行；沒有主指導時誰都不是。
    expect(canReadSubmission(viewer({ userId: T1, isTeacher: false }), groupVersion)).toBe(false)
    expect(canReadSubmission(viewer({ userId: T1, isTeacher: true }), { ...groupVersion, currentAdvisorUserId: null })).toBe(false)
  })
})

describe('被移出的人（票 22；契約 03 §1「被移出／解散後」、產品模組 05 SUB-20、25）', () => {
  const S2 = 'user-s2'
  // S2 被移出 G1：此刻不是任何組的組員。第 1 版送出時 S2 在組裡；第 3 版是移出之後組裡再送的。
  const removed = viewer({ userId: S2, memberOfGroupIds: [] })
  const v1 = { ...groupVersion, membershipSnapshot: [S1, S2] } as const
  const v3 = { ...groupVersion, membershipSnapshot: [S1] } as const

  it('只讀得到自己還在組裡時送出的版本；移出之後的版本與共用草稿都不行', () => {
    expect(canReadSubmission(removed, v1)).toBe(true)
    expect(canReadSubmission(removed, v3)).toBe(false)
    expect(canReadSubmission(removed, groupDraft)).toBe(false)
  })

  it('換到別組也一樣：舊組只看快照裡有自己的那幾版，新組照有效組員', () => {
    const moved = viewer({ userId: S2, memberOfGroupIds: [G2] })
    expect(canReadSubmission(moved, v1)).toBe(true)
    expect(canReadSubmission(moved, v3)).toBe(false)
    expect(canReadSubmission(moved, { ...groupVersion, receiverId: G2, membershipSnapshot: [S6] })).toBe(true)
  })

  it('此刻的有效組員看得到全部版本（包含自己加入之前送的）', () => {
    const joinedLater = viewer({ userId: 'user-s5', memberOfGroupIds: [G1] })
    expect(canReadSubmission(joinedLater, v1)).toBe(true)
    expect(canReadSubmission(joinedLater, v3)).toBe(true)
  })

  it('快照只對組別版本有意義：老師、別組的人不會因為別人的快照拿到', () => {
    expect(canReadSubmission(viewer({ userId: T3, isTeacher: true }), v1)).toBe(false)
    expect(canReadSubmission(viewer({ userId: S6, memberOfGroupIds: [G2] }), v1)).toBe(false)
  })
})

describe('授權矩陣逐角色（契約 03 §1；同一份組別正式版本、同一份共用草稿）', () => {
  // [誰, 看的人, 共用草稿, 正式版本]
  const table: [string, SubmissionViewer, boolean, boolean][] = [
    ['本組有效組員', viewer({ memberOfGroupIds: [G1] }), true, true],
    ['目前主指導', viewer({ userId: T1, isTeacher: true }), false, true],
    ['換掉的舊老師', viewer({ userId: T3, isTeacher: true }), false, false],
    ['系辦管理員', viewer({ userId: 'admin', isAdmin: true }), true, true],
    ['別組學生', viewer({ userId: S6, memberOfGroupIds: [G2] }), false, false],
    ['被移出、快照裡有他', viewer({ userId: 'user-s2' }), false, true],
    ['被移出、快照裡沒有他', viewer({ userId: 'user-s7' }), false, false],
  ]
  it.each(table)('%s', (_label, who, draft, version) => {
    expect(canReadSubmission(who, groupDraft)).toBe(draft)
    expect(canReadSubmission(who, groupVersion)).toBe(version)
  })
})

describe('個人回答', () => {
  it('本人與管理員可以讀；別的學生不行；草稿主指導一律不行', () => {
    expect(canReadSubmission(viewer(), personalVersion())).toBe(true)
    expect(canReadSubmission(viewer({ isAdmin: true, userId: 'admin' }), personalVersion())).toBe(true)
    expect(canReadSubmission(viewer({ userId: S6 }), personalVersion())).toBe(false)
    expect(canReadSubmission(viewer({ userId: T1, isTeacher: true }), { kind: 'draft', receiverKind: 'user', receiverId: S1 })).toBe(false)
  })

  it('主指導只在「開放閱覽、版本 ≥ 生效版本、他是目前主指導」三個都成立時可以讀（舊回答不擴權）', () => {
    const t1 = viewer({ userId: T1, isTeacher: true })
    expect(canReadSubmission(t1, personalVersion())).toBe(true)
    expect(canReadSubmission(t1, personalVersion({ schemaVersionNo: 1 }))).toBe(false)
    expect(canReadSubmission(t1, personalVersion({ visibility: null }))).toBe(false)
    expect(canReadSubmission(t1, personalVersion({ visibility: { enabled: false, effectiveFromVersionNo: 1 } }))).toBe(false)
    expect(canReadSubmission(t1, personalVersion({ currentAdvisorUserId: T3 }))).toBe(false)
  })
})

describe('收件章的一句話', () => {
  it('整組一份時寫明代表哪一組', () => {
    const base = { title: '期中報告', versionNo: 2, receivedBusinessAt: '2026-11-10T04:05:06Z' }
    expect(describeReceipt({ ...base, groupCode: 'G01' })).toContain('代表 G01 組第 2 次正式送出')
    expect(describeReceipt(base)).toContain('：第 2 次正式送出')
  })
})
