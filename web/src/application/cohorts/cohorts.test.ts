import { describe, expect, it } from 'vitest'
import {
  canManageCohorts,
  COHORT_CODE_MAX_LENGTH,
  COHORT_NAME_MAX_LENGTH,
  describeFlagReceipt,
  isRequestId,
  normalizeCreateInput,
} from '@/application/cohorts'
import type { ResolvedActor } from '@/application/accounts'

function actor(roles: ('student' | 'teacher' | 'admin')[]): ResolvedActor {
  return {
    kind: 'authenticated',
    userId: '0190a0a0-0000-7000-8000-000000000001',
    roles,
    status: 'active',
    mustChangePassword: false,
    cohortMemberships: [],
  }
}

describe('新增屆別的輸入', () => {
  it('去掉前後空白，大小寫照原樣保留', () => {
    const result = normalizeCreateInput({ code: '  115-TEST ', name: ' 115 學年度 ' })
    expect(result).toEqual({ ok: true, value: { code: '115-TEST', name: '115 學年度' } })
  })

  it('代碼或名稱空白都被擋，並指出是哪一欄', () => {
    const noCode = normalizeCreateInput({ code: '   ', name: '115' })
    expect(noCode.ok).toBe(false)
    if (!noCode.ok) {
      expect(noCode.code).toBe('VALIDATION_FAILED')
      expect(noCode.details).toEqual({ field: 'code' })
    }

    const noName = normalizeCreateInput({ code: '115', name: '' })
    expect(noName.ok).toBe(false)
    if (!noName.ok) expect(noName.details).toEqual({ field: 'name' })
  })

  it.each(['115 TEST', '115/TEST', '-115', '一一五', '115;drop'])('代碼 %j 含不允許的字元被擋', (code) => {
    const result = normalizeCreateInput({ code, name: '名稱' })
    expect(result.ok).toBe(false)
  })

  it.each(['115', '115-TEST', 'y2026_b'])('代碼 %j 可以', (code) => {
    expect(normalizeCreateInput({ code, name: '名稱' }).ok).toBe(true)
  })

  it('長度上限含邊界', () => {
    expect(normalizeCreateInput({ code: 'A'.repeat(COHORT_CODE_MAX_LENGTH), name: 'n' }).ok).toBe(true)
    expect(normalizeCreateInput({ code: 'A'.repeat(COHORT_CODE_MAX_LENGTH + 1), name: 'n' }).ok).toBe(false)
    expect(normalizeCreateInput({ code: 'A', name: '名'.repeat(COHORT_NAME_MAX_LENGTH) }).ok).toBe(true)
    expect(normalizeCreateInput({ code: 'A', name: '名'.repeat(COHORT_NAME_MAX_LENGTH + 1) }).ok).toBe(false)
  })
})

describe('誰能管理屆別', () => {
  it('只有 admin', () => {
    expect(canManageCohorts(actor(['admin']))).toBe(true)
    expect(canManageCohorts(actor(['teacher']))).toBe(false)
    expect(canManageCohorts(actor(['student']))).toBe(false)
    expect(canManageCohorts({ kind: 'anonymous' })).toBe(false)
  })
})

describe('請求編號', () => {
  it('必須是 uuid', () => {
    expect(isRequestId('0190a0a0-0000-7000-8000-000000000001')).toBe(true)
    expect(isRequestId('')).toBe(false)
    expect(isRequestId('not-a-uuid')).toBe(false)
  })
})

describe('設旗標的回饋句子', () => {
  it('有被取消的舊屆別時一併說出來', () => {
    expect(
      describeFlagReceipt({
        flag: 'registrationOpen',
        cohortId: 'b',
        code: '116',
        previousCohortId: 'a',
        previousCode: '115',
      }),
    ).toBe('已把 116 設為開放註冊屆別；115 的開放註冊屆別已自動取消。')
  })

  it('原本沒有持有者時只說設定了哪一屆', () => {
    expect(
      describeFlagReceipt({
        flag: 'defaultWorking',
        cohortId: 'a',
        code: '115',
        previousCohortId: null,
        previousCode: null,
      }),
    ).toBe('已把 115 設為預設工作屆別。')
  })
})
