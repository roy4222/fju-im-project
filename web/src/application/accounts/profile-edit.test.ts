import { describe, expect, it } from 'vitest'
import {
  canChangeCohort,
  canChangeRole,
  cohortLockedMessage,
  mainRoleOf,
  membershipPhrase,
  normalizeProfileEdit,
  profileEditRowBlocker,
  STUDENT_FIELDS_REQUIRED,
} from '@/application/accounts/profile-edit'
import { TEACHER_NAME_MAX_LENGTH } from '@/application/accounts/teachers'

/** C2-08：帳號列「編輯」的純規則（調屆、學生↔老師互轉；設計方案 §3.8、§3.9）。寫入在 `pg-profile-edit.integration.test.ts`。 */

const USER = '0190f0f0-0000-7000-8000-000000000001'
const COHORT = '0190f0f0-0000-7000-8000-0000000000c1'
const REQUEST = '0190f0f0-0000-7000-8000-0000000000aa'

const g3 = { groupId: '0190f0f0-0000-7000-8000-0000000000a3', groupCode: '第 3 組', cohortCode: '115' }

describe('normalizeProfileEdit', () => {
  const base = { userId: USER, name: ' 王  小明 ', role: 'student', studentNo: ' 411012345 ', cohortId: COHORT, requestId: REQUEST }

  it('學生：姓名去頭尾空白、合併連續空白；學號去空白；屆別照收', () => {
    expect(normalizeProfileEdit(base)).toEqual({
      ok: true,
      value: { userId: USER, name: '王 小明', role: 'student', studentNo: '411012345', cohortId: COHORT, requestId: REQUEST, admin: null },
    })
  })

  it('老師：學號與屆別一律清成 null（視窗選「老師」後兩欄消失）', () => {
    expect(normalizeProfileEdit({ ...base, role: 'teacher' })).toMatchObject({
      ok: true,
      value: { role: 'teacher', studentNo: null, cohortId: null },
    })
  })

  it('沒有主角色的職員：只改姓名', () => {
    expect(normalizeProfileEdit({ ...base, role: null })).toMatchObject({ ok: true, value: { role: null, studentNo: null, cohortId: null } })
  })

  it('管理員勾：沒給＝不動（null）；學生不能勾', () => {
    expect(normalizeProfileEdit({ ...base, role: 'teacher', admin: true })).toMatchObject({ ok: true, value: { admin: true } })
    expect(normalizeProfileEdit({ ...base, role: 'teacher', admin: false })).toMatchObject({ ok: true, value: { admin: false } })
    expect(normalizeProfileEdit({ ...base, admin: false })).toMatchObject({ ok: true, value: { admin: false } })
    expect(normalizeProfileEdit({ ...base, admin: true })).toMatchObject({ ok: false, details: { field: 'admin' } })
  })

  it('學生缺學號或屆別：「學生要有學號和屆別」', () => {
    expect(normalizeProfileEdit({ ...base, studentNo: '  ' })).toMatchObject({ ok: false, message: STUDENT_FIELDS_REQUIRED })
    expect(normalizeProfileEdit({ ...base, cohortId: '' })).toMatchObject({ ok: false, message: STUDENT_FIELDS_REQUIRED })
    expect(STUDENT_FIELDS_REQUIRED).toBe('學生要有學號和屆別')
  })

  it('格式不對擋下：姓名空白或太長、學號含符號、角色亂填、編號不是 uuid', () => {
    expect(normalizeProfileEdit({ ...base, name: '  ' })).toMatchObject({ ok: false, details: { field: 'name' } })
    expect(normalizeProfileEdit({ ...base, name: 'x'.repeat(TEACHER_NAME_MAX_LENGTH + 1) })).toMatchObject({ ok: false, details: { field: 'name' } })
    expect(normalizeProfileEdit({ ...base, studentNo: '411-01' })).toMatchObject({ ok: false, details: { field: 'studentNo' } })
    expect(normalizeProfileEdit({ ...base, role: 'admin' })).toMatchObject({ ok: false, details: { field: 'role' } })
    expect(normalizeProfileEdit({ ...base, cohortId: 'x' })).toMatchObject({ ok: false, details: { field: 'cohortId' } })
    expect(normalizeProfileEdit({ ...base, userId: 'x' })).toMatchObject({ ok: false })
    expect(normalizeProfileEdit({ ...base, requestId: 'x' })).toMatchObject({ ok: false })
  })
})

describe('canChangeCohort：有有效組別就不能調屆', () => {
  it('沒有組別 → 可以', () => {
    expect(canChangeCohort([])).toEqual({ ok: true })
  })
  it('在組裡 → 不行，原因連到那一組', () => {
    expect(canChangeCohort([g3])).toEqual({
      ok: false,
      reason: '他在 115 屆第 3 組，先到分組把他移出才能改屆別',
      groupId: g3.groupId,
    })
    expect(membershipPhrase(g3)).toBe('他在 115 屆第 3 組')
    expect(cohortLockedMessage(g3)).toBe('他在 115 屆第 3 組，先到分組把他移出才能改屆別')
  })
})

describe('canChangeRole：學生↔老師互轉的前置條件（只寫不成立的那半句）', () => {
  const none = { memberships: [], submissions: 0, advising: 0, evaluating: 0 }

  it('角色沒變一律可以', () => {
    expect(canChangeRole('student', 'student', { ...none, memberships: [g3], submissions: 2 })).toBeNull()
    expect(canChangeRole('teacher', 'teacher', { ...none, advising: 1 })).toBeNull()
  })

  it('學生 → 老師：不在組、沒有繳交紀錄才行', () => {
    expect(canChangeRole('student', 'teacher', none)).toBeNull()
    expect(canChangeRole('student', 'teacher', { ...none, memberships: [g3] })).toBe('他在 115 屆第 3 組，不能改成老師')
    expect(canChangeRole('student', 'teacher', { ...none, submissions: 2 })).toBe('有 2 筆繳交紀錄，不能改成老師')
    expect(canChangeRole('student', 'teacher', { ...none, memberships: [g3], submissions: 2 })).toBe(
      '他在 115 屆第 3 組、有 2 筆繳交紀錄，不能改成老師',
    )
  })

  it('老師 → 學生：沒有指導中的組、沒有評分指派才行', () => {
    expect(canChangeRole('teacher', 'student', none)).toBeNull()
    expect(canChangeRole('teacher', 'student', { ...none, advising: 1 })).toBe('他指導中 1 組，不能改成學生')
    expect(canChangeRole('teacher', 'student', { ...none, evaluating: 3 })).toBe('有 3 筆評分指派，不能改成學生')
    expect(canChangeRole('teacher', 'student', { ...none, advising: 1, evaluating: 3 })).toBe('他指導中 1 組、有 3 筆評分指派，不能改成學生')
  })

  it('沒有主角色（職員）不能在這裡變學生或老師', () => {
    expect(canChangeRole(null, 'teacher', none)).toBe('這個帳號沒有學生或老師身分，請用「補上身分」')
    expect(canChangeRole('teacher', null, none)).toBe('這個帳號沒有學生或老師身分，請用「補上身分」')
    expect(canChangeRole(null, null, none)).toBeNull()
  })
})

describe('mainRoleOf', () => {
  it('學生優先於老師；都沒有回 null', () => {
    expect(mainRoleOf(['admin', 'teacher'])).toBe('teacher')
    expect(mainRoleOf(['student'])).toBe('student')
    expect(mainRoleOf(['admin'])).toBeNull()
  })
})

describe('profileEditRowBlocker：列上「編輯」什麼時候不能按', () => {
  const row = { userId: USER, status: 'active' as const, roles: ['student' as const], orphan: false }
  it('已核准、有身分 → 可以', () => {
    expect(profileEditRowBlocker(row, 'someone-else')).toBeNull()
    expect(profileEditRowBlocker({ ...row, roles: ['admin'] }, 'someone-else')).toBeNull()
  })
  it('自己、已去識別化、停用、待審、未設定身分 → 各自一句', () => {
    expect(profileEditRowBlocker(row, USER)).toBe('自己的資料請到我的帳號改')
    expect(profileEditRowBlocker({ ...row, status: 'deidentified' }, 'x')).toBe('已刪除個人資料，不能再改')
    expect(profileEditRowBlocker({ ...row, status: 'disabled' }, 'x')).toBe('已停用，先恢復才能編輯')
    expect(profileEditRowBlocker({ ...row, status: 'pending' }, 'x')).toBe('還在待審核，請到待審核分頁處理')
    expect(profileEditRowBlocker({ ...row, roles: [], orphan: true }, 'x')).toBe('還沒設定身分，請先用「補上身分」')
  })
})
