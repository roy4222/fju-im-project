import { describe, expect, it } from 'vitest'
import {
  adminGrantProblem,
  isOrphan,
  normalizeOrphanRepair,
  normalizeRoleChange,
  remainingEffectiveAdmins,
} from '@/application/accounts/roles'
import { REASON_MAX_LENGTH } from '@/application/accounts/registration'

/** 票 10b：管理員角色授予／取消與孤兒帳號的純規則。寫入與鎖在 `role-assignment.integration.test.ts`。 */

describe('normalizeRoleChange', () => {
  it('只收管理員角色；理由必填、去頭尾空白、有上限、不收控制字元', () => {
    expect(normalizeRoleChange({ role: 'admin', reason: '  新任承辦人 ' })).toEqual({ ok: true, value: { role: 'admin', reason: '新任承辦人' } })
    expect(normalizeRoleChange({ role: 'teacher', reason: '理由' })).toMatchObject({ ok: false, details: { field: 'role' } })
    expect(normalizeRoleChange({ role: 'admin', reason: '   ' })).toMatchObject({ ok: false, details: { field: 'reason' } })
    expect(normalizeRoleChange({ role: 'admin', reason: undefined })).toMatchObject({ ok: false, details: { field: 'reason' } })
    expect(normalizeRoleChange({ role: 'admin', reason: 'x'.repeat(REASON_MAX_LENGTH + 1) })).toMatchObject({ ok: false, details: { field: 'reason' } })
    expect(normalizeRoleChange({ role: 'admin', reason: 'a\u0000b' })).toMatchObject({ ok: false, details: { field: 'reason' } })
    expect(normalizeRoleChange({ role: 'admin', reason: '第一行\n第二行' })).toMatchObject({ ok: true })
  })
})

describe('adminGrantProblem：誰可以被設為管理員', () => {
  it('老師、沒有角色的職員（active）可以', () => {
    expect(adminGrantProblem({ status: 'active', roles: ['teacher'] })).toBeNull()
    expect(adminGrantProblem({ status: 'active', roles: [] })).toBeNull()
  })
  it('學生不行；待審、停用、去識別化不行；已經是管理員回 CONFLICT', () => {
    expect(adminGrantProblem({ status: 'active', roles: ['student'] })).toMatchObject({ code: 'VALIDATION_FAILED' })
    expect(adminGrantProblem({ status: 'pending', roles: [] })).toMatchObject({ code: 'CONFLICT' })
    expect(adminGrantProblem({ status: 'disabled', roles: ['teacher'] })).toMatchObject({ code: 'CONFLICT' })
    expect(adminGrantProblem({ status: 'deidentified', roles: ['teacher'] })).toMatchObject({ code: 'CONFLICT' })
    expect(adminGrantProblem({ status: 'active', roles: ['admin', 'teacher'] })).toMatchObject({ code: 'CONFLICT' })
  })
})

describe('remainingEffectiveAdmins：最後一位管理員保護', () => {
  const admins = [
    { userId: 'a', effective: true },
    { userId: 'b', effective: true },
    { userId: 'c', effective: false },
  ]
  it('移除一位之後只算有效的（停用的管理員登不進來，不算）', () => {
    expect(remainingEffectiveAdmins(admins, 'a')).toBe(1)
    expect(remainingEffectiveAdmins(admins.slice(1), 'b')).toBe(0)
    expect(remainingEffectiveAdmins(admins, 'c')).toBe(2)
  })
})

describe('isOrphan：孤兒帳號', () => {
  const base = { status: 'pending' as const, activeRoles: 0, applications: 0, hasProfile: false }
  it('待審或已開通、沒有角色、沒有申請、沒有個人資料', () => {
    expect(isOrphan(base)).toBe(true)
    expect(isOrphan({ ...base, status: 'active' })).toBe(true)
  })
  it('有任何一樣就不是；停用與去識別化也不是（已經處理過了）', () => {
    expect(isOrphan({ ...base, activeRoles: 1 })).toBe(false)
    expect(isOrphan({ ...base, applications: 1 })).toBe(false)
    expect(isOrphan({ ...base, hasProfile: true })).toBe(false)
    expect(isOrphan({ ...base, status: 'disabled' })).toBe(false)
    expect(isOrphan({ ...base, status: 'deidentified' })).toBe(false)
  })
})

describe('normalizeOrphanRepair', () => {
  it('只能補老師或管理員；理由必填', () => {
    expect(normalizeOrphanRepair({ role: 'teacher', reason: '補建' })).toEqual({ ok: true, value: { role: 'teacher', reason: '補建' } })
    expect(normalizeOrphanRepair({ role: 'admin', reason: '補建' })).toMatchObject({ ok: true })
    expect(normalizeOrphanRepair({ role: 'student', reason: '補建' })).toMatchObject({ ok: false, details: { field: 'role' } })
    expect(normalizeOrphanRepair({ role: 'teacher', reason: '' })).toMatchObject({ ok: false, details: { field: 'reason' } })
  })
})
