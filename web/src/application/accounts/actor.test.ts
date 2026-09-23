import { describe, expect, it } from 'vitest'
import {
  ANONYMOUS,
  canPerform,
  hasRole,
  statusGate,
  type Actor,
  type Capability,
  type ResolvedActor,
} from '@/application/accounts'

/**
 * S01-03：帳號狀態閘門（契約 03 §2、ARCHITECTURE §4.12）。
 *
 * 這支是矩陣驅動的：把「狀態 × 能力」全部列出來，允許與拒絕都斷言，
 * 而且拒絕要回對的錯誤碼（UI 靠錯誤碼決定把人帶去哪裡，契約 02 §1）。
 */

function actor(overrides: Partial<Actor> = {}): ResolvedActor {
  return {
    kind: 'authenticated',
    userId: '01a00000-0000-7000-8000-000000000001',
    roles: ['student'],
    status: 'active',
    mustChangePassword: false,
    cohortMemberships: [],
    ...overrides,
  }
}

const CAPABILITIES: Capability[] = [
  'self.session',
  'self.changePassword',
  'registration.viewOwn',
  'registration.reviseOwn',
  'self.linkAccount',
  'business',
]

/** 每個狀態放行哪些能力；沒列到的就是要被擋（而且擋的理由要對）。 */
const MATRIX: { name: string; who: ResolvedActor; allowed: Capability[]; code: string }[] = [
  { name: '未登入', who: ANONYMOUS, allowed: [], code: 'UNAUTHENTICATED' },
  {
    name: 'pending（待審核）',
    who: actor({ status: 'pending' }),
    allowed: ['self.session', 'self.changePassword', 'registration.viewOwn', 'registration.reviseOwn'],
    code: 'ACCOUNT_PENDING',
  },
  {
    name: 'must-change（被要求改密）',
    who: actor({ mustChangePassword: true }),
    allowed: ['self.session', 'self.changePassword'],
    code: 'PASSWORD_CHANGE_REQUIRED',
  },
  { name: 'active', who: actor(), allowed: CAPABILITIES, code: '（不該被擋）' },
  { name: 'disabled（停用）', who: actor({ status: 'disabled' }), allowed: [], code: 'UNAUTHENTICATED' },
  {
    name: 'deidentified（去識別化）',
    who: actor({ status: 'deidentified' }),
    allowed: [],
    code: 'UNAUTHENTICATED',
  },
]

describe.each(MATRIX.map((row) => [row.name, row] as const))('%s', (_name, row) => {
  it.each(CAPABILITIES)('%s', (capability) => {
    const verdict = statusGate(row.who, capability)
    if (row.allowed.includes(capability)) {
      expect(verdict, '這個狀態應該放行').toBeNull()
      expect(canPerform(row.who, capability)).toBe(true)
    } else {
      expect(verdict, '這個狀態應該被擋').toBe(row.code)
      expect(canPerform(row.who, capability)).toBe(false)
    }
  })
})

describe('幾個容易寫錯的組合', () => {
  it('停用優先於 must-change：被停用的人連改密都不行', () => {
    const disabledAndMustChange = actor({ status: 'disabled', mustChangePassword: true })
    expect(statusGate(disabledAndMustChange, 'self.changePassword')).toBe('UNAUTHENTICATED')
  })

  it('must-change 優先於 pending：待審又被發臨時密碼時，先改密', () => {
    // A1 第一次登入是 active＋must-change；待審的人被系辦發臨時密碼則是 pending＋must-change。
    // 兩種都應該只剩改密與登出，而且錯誤碼要指向改密頁。
    const pendingAndMustChange = actor({ status: 'pending', mustChangePassword: true })
    expect(statusGate(pendingAndMustChange, 'registration.reviseOwn')).toBe('PASSWORD_CHANGE_REQUIRED')
    expect(statusGate(pendingAndMustChange, 'self.changePassword')).toBeNull()
  })

  it('停用不回 ACCOUNT_DISABLED：不讓人拿它來探測帳號狀態', () => {
    expect(statusGate(actor({ status: 'disabled' }), 'business')).toBe('UNAUTHENTICATED')
    expect(statusGate(actor({ status: 'disabled' }), 'business')).not.toBe('ACCOUNT_DISABLED')
  })

  it('active 但 must-change 時不能連結 Google（A1 首次登入的情境）', () => {
    expect(statusGate(actor({ mustChangePassword: true }), 'self.linkAccount')).toBe('PASSWORD_CHANGE_REQUIRED')
  })
})

describe('角色', () => {
  it('看得出有沒有某個角色', () => {
    expect(hasRole(actor({ roles: ['admin'] }), 'admin')).toBe(true)
    expect(hasRole(actor({ roles: ['student'] }), 'admin')).toBe(false)
  })

  it('未登入的人什麼角色都沒有', () => {
    expect(hasRole(ANONYMOUS, 'admin')).toBe(false)
    expect(hasRole(ANONYMOUS, 'student')).toBe(false)
  })

  it('一個人可以同時有多個角色（老師兼管理員）', () => {
    const both = actor({ roles: ['teacher', 'admin'] })
    expect(hasRole(both, 'teacher')).toBe(true)
    expect(hasRole(both, 'admin')).toBe(true)
  })
})
