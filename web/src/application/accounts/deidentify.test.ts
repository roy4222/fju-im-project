import { describe, expect, it } from 'vitest'
import {
  deidentifiedEmail,
  deidentifiedPseudonym,
  deidentifyConfirmationMatches,
  deidentifyStatusBlocker,
  retainedList,
} from '@/application/accounts'

/** 票 40：去識別化的純規則（ACC-14）。查表與交易的部分在 account-directory-command 的整合測試。 */

const USER = '0190f5a2-7b3c-7d4e-8f90-a1b2c3d4e5f6'

describe('去識別化的代稱與置換值', () => {
  it('代稱只由系統 ID 推得，同一個人永遠同一個', () => {
    expect(deidentifiedPseudonym(USER)).toBe('已去識別化使用者 D4E5F6')
    expect(deidentifiedPseudonym(USER.toUpperCase())).toBe(deidentifiedPseudonym(USER))
  })

  it('置換的 Email 含系統 ID、在保留的 .invalid 網域下（收不到信、不會撞號）', () => {
    expect(deidentifiedEmail(USER)).toBe(`deidentified-${USER}@deidentified.invalid`)
    expect(deidentifiedEmail(USER.toUpperCase())).toBe(deidentifiedEmail(USER))
  })
})

describe('二次確認：照打登入 Email', () => {
  it('不分大小寫、忽略頭尾空白', () => {
    expect(deidentifyConfirmationMatches('  S01@Example.com ', 's01@example.com')).toBe(true)
  })

  it('打錯、空白、不是字串都不算', () => {
    expect(deidentifyConfirmationMatches('s02@example.com', 's01@example.com')).toBe(false)
    expect(deidentifyConfirmationMatches('   ', '')).toBe(false)
    expect(deidentifyConfirmationMatches(undefined, 's01@example.com')).toBe(false)
    expect(deidentifyConfirmationMatches('去識別化', 's01@example.com')).toBe(false)
  })
})

describe('狀態上的前置條件', () => {
  it('已核准與已停用可以做', () => {
    expect(deidentifyStatusBlocker('active')).toBeNull()
    expect(deidentifyStatusBlocker('disabled')).toBeNull()
  })

  it('待審與已去識別化不行；孤兒帳號提示先停用', () => {
    expect(deidentifyStatusBlocker('pending')).toMatch(/待審核/)
    expect(deidentifyStatusBlocker('pending', true)).toMatch(/先停用/)
    expect(deidentifyStatusBlocker('deidentified')).toMatch(/已經去識別化/)
  })
})

describe('保留紀錄清單', () => {
  it('固定順序、帶標籤與筆數', () => {
    const list = retainedList({
      groupMemberships: 1,
      submissions: 2,
      evaluatorAssignments: 0,
      advisorAssignments: 0,
      approvals: 3,
      auditEvents: 7,
    })
    expect(list.map((r) => r.label)).toEqual(['組別成員紀錄', '繳交版本', '評分指派', '指導紀錄', '簽核表態', '操作紀錄'])
    expect(list.map((r) => r.count)).toEqual([1, 2, 0, 0, 3, 7])
  })
})
