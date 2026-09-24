import { describe, expect, it } from 'vitest'
import type { ResolvedActor } from '@/application/accounts'
import {
  canViewTeammates,
  describeConfirmReceipt,
  nextGroupCode,
  normalizeProposeInput,
  normalizeVoidReason,
  proposalExpiry,
  studentCohortOf,
  TERMINATION_KIND_LABEL,
} from '@/application/groups'

const COHORT = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'

function actor(roles: ('student' | 'teacher' | 'admin')[], cohortId: string | null = COHORT): ResolvedActor {
  return {
    kind: 'authenticated',
    userId: '33333333-3333-4333-8333-333333333333',
    roles,
    status: 'active',
    mustChangePassword: false,
    cohortMemberships: cohortId && roles.includes('student') ? [{ cohortId, role: 'student' }] : [],
  }
}

const FIVE = { min: 5, max: 5 }

describe('提案輸入：人數依屆別設定（含自己）', () => {
  it('預設五人：填四位同學剛好；空白欄略過、重複與自己的學號去掉', () => {
    const result = normalizeProposeInput(
      { groupType: 'general', memberStudentNos: [' 410000002 ', '410000003', '', '410000003', '410000001', '410000004', '410000005'] },
      FIVE,
      '410000001',
    )
    expect(result).toEqual({
      ok: true,
      value: { groupType: 'general', memberStudentNos: ['410000002', '410000003', '410000004', '410000005'] },
    })
  })

  it('人數不在範圍：被拒並說明本屆每組幾人', () => {
    const three = normalizeProposeInput({ groupType: 'general', memberStudentNos: ['a1', 'a2'] }, FIVE, null)
    expect(three).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    if (!three.ok) expect(three.message).toContain('本屆每組 5 人')

    const range = { min: 3, max: 4 }
    expect(normalizeProposeInput({ groupType: 'industry', memberStudentNos: ['a1', 'a2'] }, range, null).ok).toBe(true)
    expect(normalizeProposeInput({ groupType: 'industry', memberStudentNos: ['a1', 'a2', 'a3'] }, range, null).ok).toBe(true)
    const tooMany = normalizeProposeInput({ groupType: 'industry', memberStudentNos: ['a1', 'a2', 'a3', 'a4'] }, range, null)
    expect(tooMany.ok).toBe(false)
    if (!tooMany.ok) expect(tooMany.message).toContain('3–4 人')
  })

  it('類型只收一般／產學；學號只收英數', () => {
    expect(normalizeProposeInput({ groupType: 'exception', memberStudentNos: [] }, { min: 1, max: 5 }, null)).toMatchObject({
      ok: false,
      details: { field: 'groupType' },
    })
    expect(normalizeProposeInput({ groupType: 'general', memberStudentNos: ["41'; drop"] }, { min: 1, max: 5 }, null)).toMatchObject({
      ok: false,
      details: { field: 'memberStudentNos' },
    })
  })
})

describe('到期時間＝min(發起＋預設天數, 成組截止)', () => {
  const now = new Date('2026-09-20T02:00:00Z')
  it('天數先到：發起＋天數', () => {
    expect(proposalExpiry(now, 7, new Date('2026-10-31T16:00:00Z')).toISOString()).toBe('2026-09-27T02:00:00.000Z')
  })
  it('成組截止先到：成組截止', () => {
    const deadline = new Date('2026-09-23T16:00:00Z')
    expect(proposalExpiry(now, 7, deadline).toISOString()).toBe(deadline.toISOString())
  })
  it('剛好同一刻：兩邊一樣', () => {
    const deadline = new Date('2026-09-27T02:00:00Z')
    expect(proposalExpiry(now, 7, deadline).toISOString()).toBe(deadline.toISOString())
  })
})

describe('其他純規則', () => {
  it('組別代碼屆內遞增，不理會不是 Gnn 的代碼', () => {
    expect(nextGroupCode([])).toBe('G01')
    expect(nextGroupCode(['G01', 'G09', 'X99'])).toBe('G10')
  })

  it('作廢理由必填、去空白、有上限', () => {
    expect(normalizeVoidReason('  ')).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(normalizeVoidReason(' 名單有誤 ')).toEqual({ ok: true, value: '名單有誤' })
    expect(normalizeVoidReason('字'.repeat(201)).ok).toBe(false)
  })

  it('找組員名單：同屆學生、老師、管理員看得到；他屆學生、未登入看不到', () => {
    expect(canViewTeammates(actor(['student']), COHORT)).toBe(true)
    expect(canViewTeammates(actor(['student'], OTHER), COHORT)).toBe(false)
    expect(canViewTeammates(actor(['teacher']), COHORT)).toBe(true)
    expect(canViewTeammates(actor(['admin']), COHORT)).toBe(true)
    expect(canViewTeammates({ kind: 'anonymous' }, COHORT)).toBe(false)
  })

  it('學生的屆別來自學生身分；老師沒有', () => {
    expect(studentCohortOf(actor(['student']))).toBe(COHORT)
    expect(studentCohortOf(actor(['teacher']))).toBeNull()
  })

  it('五種終止加上衝突都有產品文件用的名稱', () => {
    expect(Object.values(TERMINATION_KIND_LABEL)).toEqual(['被拒絕', '成員撤回同意', '提案人撤回', '逾期', '管理員作廢', '成員已在其他組'])
  })

  it('確認回執的句子', () => {
    const base = { proposalId: COHORT, confirmedCount: 3, memberCount: 5, groupCode: null }
    expect(describeConfirmReceipt({ ...base, outcome: 'confirmed' })).toContain('3／5')
    expect(describeConfirmReceipt({ ...base, outcome: 'established', groupCode: 'G01' })).toContain('G01 成立')
  })
})
