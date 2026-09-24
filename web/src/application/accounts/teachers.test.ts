import { describe, expect, it } from 'vitest'
import {
  accountAdminDenied,
  normalizeApproval,
  normalizeTeacherAccountInput,
  normalizeTeacherProfile,
  normalizeTemporaryPasswordRequest,
  teacherSetupDenied,
  type ResolvedActor,
  type Role,
} from '@/application/accounts'

/** 票 8：老師帳號與臨時密碼的純規則（產品模組 01 §2.4「老師帳號」、§2.5）。 */

function actor(roles: Role[], patch: Partial<Extract<ResolvedActor, { kind: 'authenticated' }>> = {}): ResolvedActor {
  return {
    kind: 'authenticated',
    userId: '0190a0a0-0000-7000-8000-000000000001',
    roles,
    status: 'active',
    mustChangePassword: false,
    cohortMemberships: [],
    ...patch,
  }
}

const base = { email: ' T1@Example.com ', name: ' 林  老師 ', verificationMethod: '', verificationNote: '' }

describe('新增老師的欄位', () => {
  it('直接新增：姓名必填、Email 轉小寫、姓名中間空白縮成一個', () => {
    const result = normalizeTeacherAccountInput({ ...base, mode: 'direct', verificationMethod: 'id_document' })
    expect(result).toMatchObject({ ok: true, value: { mode: 'direct', email: 't1@example.com', name: '林 老師' } })
    expect(normalizeTeacherAccountInput({ ...base, name: '', mode: 'direct', verificationMethod: 'id_document' })).toMatchObject({
      ok: false,
      details: { field: 'name' },
    })
  })

  it('直接新增會發臨時密碼，所以核實方式必選；選「其他」要寫說明', () => {
    expect(normalizeTeacherAccountInput({ ...base, mode: 'direct' })).toMatchObject({
      ok: false,
      details: { field: 'verificationMethod' },
    })
    expect(normalizeTeacherAccountInput({ ...base, mode: 'direct', verificationMethod: 'other' })).toMatchObject({
      ok: false,
      details: { field: 'verificationNote' },
    })
    expect(
      normalizeTeacherAccountInput({ ...base, mode: 'direct', verificationMethod: 'other', verificationNote: '電話回撥系上分機確認' }),
    ).toMatchObject({ ok: true, value: { verification: { verificationMethod: 'other' } } })
  })

  it('沒有「班代確認」這個核實方式', () => {
    expect(normalizeTeacherAccountInput({ ...base, mode: 'direct', verificationMethod: 'class_rep' })).toMatchObject({ ok: false })
  })

  it('預授權：只要 Email，姓名選填、不需要核實方式', () => {
    expect(normalizeTeacherAccountInput({ ...base, name: '', mode: 'preauthorize' })).toMatchObject({
      ok: true,
      value: { mode: 'preauthorize', email: 't1@example.com', name: null, verification: null },
    })
  })

  it('Email 格式不對、姓名有控制字元都擋下', () => {
    expect(normalizeTeacherAccountInput({ ...base, email: 'not-an-email', mode: 'preauthorize' })).toMatchObject({
      ok: false,
      details: { field: 'email' },
    })
    expect(normalizeTeacherAccountInput({ ...base, name: '林\u0000老師', mode: 'preauthorize' })).toMatchObject({
      ok: false,
      details: { field: 'name' },
    })
  })

  it('不認得的新增方式一律擋下', () => {
    expect(normalizeTeacherAccountInput({ ...base, mode: 'admin' as never })).toMatchObject({ ok: false })
  })
})

describe('核發臨時密碼的欄位（跟註冊核准同一套核實方式）', () => {
  it('核實方式必選；校方管道要寫由誰、透過什麼管道', () => {
    expect(normalizeTemporaryPasswordRequest({ verificationMethod: '', verificationNote: '', reason: '' })).toMatchObject({ ok: false })
    expect(
      normalizeTemporaryPasswordRequest({ verificationMethod: 'school_channel', verificationNote: '', reason: '' }),
    ).toMatchObject({ ok: false, details: { field: 'verificationNote' } })
    expect(
      normalizeTemporaryPasswordRequest({ verificationMethod: 'id_document', verificationNote: '', reason: '忘記密碼' }),
    ).toMatchObject({ ok: true, value: { verificationMethod: 'id_document', verificationNote: null, reason: '忘記密碼' } })
  })
})

describe('核准說明與理由拒絕控制字元（票 7 審查建議）', () => {
  it('換行與 tab 可以，其他控制字元不行', () => {
    expect(normalizeApproval({ verificationMethod: 'other', verificationNote: '第一行\n第二行\t結束', reason: '' })).toMatchObject({
      ok: true,
    })
    expect(normalizeApproval({ verificationMethod: 'other', verificationNote: '說明\u001b[31m', reason: '' })).toMatchObject({
      ok: false,
      details: { field: 'verificationNote' },
    })
    expect(normalizeApproval({ verificationMethod: 'id_document', verificationNote: '', reason: '理由\u0007' })).toMatchObject({
      ok: false,
      details: { field: 'reason' },
    })
  })
})

describe('老師補資料', () => {
  it('姓名與聯絡 Email 必填、手機選填', () => {
    expect(normalizeTeacherProfile({ displayName: ' 林老師 ', phone: '', contactEmail: 'T1@Example.com' })).toEqual({
      ok: true,
      value: { displayName: '林老師', phone: null, contactEmail: 't1@example.com' },
    })
    expect(normalizeTeacherProfile({ displayName: '', phone: '', contactEmail: 't1@example.com' })).toMatchObject({
      ok: false,
      details: { field: 'displayName' },
    })
    expect(normalizeTeacherProfile({ displayName: '林老師', phone: '', contactEmail: '' })).toMatchObject({
      ok: false,
      details: { field: 'contactEmail' },
    })
    expect(normalizeTeacherProfile({ displayName: '林老師', phone: 'abc', contactEmail: 't1@example.com' })).toMatchObject({
      ok: false,
      details: { field: 'phone' },
    })
  })
})

describe('誰能做', () => {
  it('新增老師、發臨時密碼：只有狀態正常的管理員', () => {
    expect(accountAdminDenied(actor(['admin']))).toBeNull()
    expect(accountAdminDenied(actor(['teacher']))).toBe('FORBIDDEN')
    expect(accountAdminDenied(actor(['admin'], { mustChangePassword: true }))).toBe('PASSWORD_CHANGE_REQUIRED')
    expect(accountAdminDenied(actor(['admin'], { status: 'disabled' }))).toBe('UNAUTHENTICATED')
    expect(accountAdminDenied({ kind: 'anonymous' })).toBe('UNAUTHENTICATED')
  })

  it('補資料：已改過臨時密碼的老師本人', () => {
    expect(teacherSetupDenied(actor(['teacher']))).toBeNull()
    expect(teacherSetupDenied(actor(['student']))).toBe('FORBIDDEN')
    expect(teacherSetupDenied(actor(['teacher'], { mustChangePassword: true }))).toBe('PASSWORD_CHANGE_REQUIRED')
  })
})
