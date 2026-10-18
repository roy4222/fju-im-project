import { describe, expect, it } from 'vitest'
import type { ResolvedActor } from '@/application/accounts/actor'
import {
  applyDenial,
  autoApprovalEligible,
  BULK_APPROVAL_SKIP_LABEL,
  bulkApprovalSkip,
  evidenceFlags,
  MANUAL_VERIFICATION_METHODS,
  matchRoster,
  normalizeApplicationFields,
  normalizeApproval,
  normalizeRegistrationInput,
  normalizeRejection,
  ownApplicationDenied,
  PASSWORD_MIN_LENGTH,
  resolveApprovalCohort,
  reviewAccessDenied,
  suggestedApprovalCohort,
  type RosterCandidate,
  VERIFICATION_LABEL,
  VERIFICATION_METHODS,
  VERIFICATION_NOTE_HINT,
  VERIFICATION_NOTE_REQUIRED,
} from '@/application/accounts/registration'

/** 票 7：註冊、名單比對與審核的純規則（產品模組 01 §2.4）。 */

const validInput = {
  appliedName: '  王小明 ',
  studentNo: '411410123',
  departmentClass: ' 資管二甲 ',
  phone: '0912-345-678',
  loginEmail: ' S01@Example.com ',
  password: 'Correct-Horse-9',
  passwordConfirm: 'Correct-Horse-9',
}

describe('註冊欄位', () => {
  it('去頭尾空白、Email 轉小寫；聯絡 Email 預設等於登入 Email；姓名保留原文', () => {
    const result = normalizeRegistrationInput(validInput)
    expect(result).toMatchObject({
      ok: true,
      value: {
        appliedName: '王小明',
        studentNo: '411410123',
        departmentClass: '資管二甲',
        phone: '0912-345-678',
        loginEmail: 's01@example.com',
        contactEmail: 's01@example.com',
      },
    })
  })

  it.each([
    [{ appliedName: '' }, 'appliedName'],
    [{ appliedName: 'x'.repeat(51) }, 'appliedName'],
    [{ appliedName: '王\n小明' }, 'appliedName'],
    [{ studentNo: '' }, 'studentNo'],
    [{ studentNo: '4114-10123' }, 'studentNo'],
    [{ studentNo: '1'.repeat(21) }, 'studentNo'],
    [{ departmentClass: '' }, 'departmentClass'],
    [{ departmentClass: '資'.repeat(21) }, 'departmentClass'],
    [{ phone: '' }, 'phone'],
    [{ phone: 'abc' }, 'phone'],
    [{ phone: '123' }, 'phone'],
    [{ loginEmail: 'not-an-email' }, 'loginEmail'],
    [{ loginEmail: '' }, 'loginEmail'],
    [{ password: 'short', passwordConfirm: 'short' }, 'password'],
    [{ password: 'x'.repeat(129), passwordConfirm: 'x'.repeat(129) }, 'password'],
    [{ passwordConfirm: 'Different-Horse-9' }, 'passwordConfirm'],
  ])('%j → 擋在欄位 %s', (patch, field) => {
    const result = normalizeRegistrationInput({ ...validInput, ...patch })
    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', details: { field } })
  })

  it(`密碼下限是 ${PASSWORD_MIN_LENGTH}（與改密碼同一個數字）`, () => {
    const exact = 'x'.repeat(PASSWORD_MIN_LENGTH)
    expect(normalizeRegistrationInput({ ...validInput, password: exact, passwordConfirm: exact }).ok).toBe(true)
    const short = 'x'.repeat(PASSWORD_MIN_LENGTH - 1)
    expect(normalizeRegistrationInput({ ...validInput, password: short, passwordConfirm: short }).ok).toBe(false)
  })

  it('修改資料可以改聯絡 Email，格式一樣要對', () => {
    const base = { appliedName: '王小明', studentNo: '411410123', departmentClass: '資管二甲', phone: '0912345678' }
    expect(normalizeApplicationFields({ ...base, contactEmail: 'me@gmail.com' }).ok).toBe(true)
    expect(normalizeApplicationFields({ ...base, contactEmail: 'nope' })).toMatchObject({
      ok: false,
      details: { field: 'contactEmail' },
    })
  })
})

const V115 = 'v-115'
const C115 = 'c-115'
const C114 = 'c-114'

function candidate(patch: Partial<RosterCandidate> = {}): RosterCandidate {
  return {
    rosterVersionId: V115,
    cohortId: C115,
    cohortCode: '115',
    cohortName: '115 學年度專題',
    studentNo: '411410123',
    nameRaw: '王小明',
    nameNormalized: '王小明',
    email: 's01@example.com',
    departmentClass: '資管二甲',
    ...patch,
  }
}

const app = { appliedName: '王小明', studentNo: '411410123', departmentClass: '資管二甲', loginEmail: 's01@example.com' }
const noDuplicates = { activeHolders: [], otherPending: 0 }

describe('名單比對（student_no＋正規化姓名）', () => {
  it('學號與姓名都對上＝名單符合；Email 相同也照樣要審（沒有自動核准）', () => {
    const match = matchRoster(app, [candidate()], C115)
    expect(match.status).toBe('matched')
    expect(match.emailComparison).toBe('same')
    expect(match.departmentClassComparison).toBe('same')
    expect(evidenceFlags(match, noDuplicates)).toEqual(['roster_matched', 'email_same'])
  })

  it('學號對上、姓名不同＝資料不符，兩個姓名都留著給系辦看', () => {
    const match = matchRoster({ ...app, appliedName: '王小名' }, [candidate()], C115)
    expect(match.status).toBe('name_mismatch')
    expect(match.hit?.nameRaw).toBe('王小明')
    expect(evidenceFlags(match, noDuplicates)).toContain('name_mismatch')
  })

  it('姓名只做保守正規化：全形英數、大小寫、多餘空白算相同；台／臺不算相同', () => {
    const english = candidate({ nameRaw: 'John Smith', nameNormalized: 'john smith' })
    expect(matchRoster({ ...app, appliedName: 'ＪＯＨＮ   smith' }, [english], null).status).toBe('matched')
    const tai = candidate({ nameRaw: '臺小明', nameNormalized: '臺小明' })
    expect(matchRoster({ ...app, appliedName: '台小明' }, [tai], null).status).toBe('name_mismatch')
  })

  it('學號大小寫不分', () => {
    const letter = candidate({ studentNo: 'a1234567' })
    expect(matchRoster({ ...app, studentNo: 'A1234567' }, [letter], null).status).toBe('matched')
  })

  it('找不到＝未命中；Email 與系級都不比', () => {
    const match = matchRoster({ ...app, studentNo: '499999999' }, [candidate()], C115)
    expect(match).toMatchObject({ status: 'not_found', hit: null, emailComparison: 'not_applicable' })
    expect(evidenceFlags(match, noDuplicates)).toEqual(['not_found'])
  })

  it('Email 不同、名單沒填 Email 都照樣送件，只標記', () => {
    expect(matchRoster({ ...app, loginEmail: 'other@gmail.com' }, [candidate()], null).emailComparison).toBe('different')
    expect(matchRoster(app, [candidate({ email: null })], null).emailComparison).toBe('roster_blank')
    expect(matchRoster({ ...app, departmentClass: '資管二乙' }, [candidate()], null).departmentClassComparison).toBe(
      'different',
    )
  })

  it('同學號出現在兩屆：兩列都列出、標跨屆；並列那一列優先挑姓名相符的，再來是開放註冊屆別', () => {
    const in114 = candidate({ rosterVersionId: 'v-114', cohortId: C114, cohortCode: '114', cohortName: '114 學年度專題' })
    const match = matchRoster(app, [in114, candidate()], C115)
    expect(match.hits).toHaveLength(2)
    expect(match.hit?.cohortId).toBe(C115)
    expect(evidenceFlags(match, noDuplicates)).toContain('multiple_cohorts')

    const renamed114 = { ...in114, nameRaw: '王大明', nameNormalized: '王大明' }
    expect(matchRoster(app, [renamed114, candidate({ nameRaw: '王小明' })], C114).hit?.cohortId).toBe(C115)
  })

  it('重複學號：有人已占用、或另有待審申請填同一個學號', () => {
    const match = matchRoster(app, [candidate()], C115)
    expect(evidenceFlags(match, { activeHolders: [{ name: '王小明', cohortCode: '115' }], otherPending: 0 })).toContain(
      'duplicate_student_no',
    )
    expect(evidenceFlags(match, { activeHolders: [], otherPending: 1 })).toContain('duplicate_student_no')
  })
})

describe('核准與退回的欄位', () => {
  it('核實方式不用選：沒帶就是 office_review；不認得的值一律擋', () => {
    expect(normalizeApproval({ verificationMethod: '', verificationNote: '', reason: '' })).toEqual({
      ok: true,
      value: { verificationMethod: 'office_review', verificationNote: null, reason: null },
    })
    expect(normalizeApproval({ verificationMethod: 'office_review', verificationNote: '', reason: '' }).ok).toBe(true)
    expect(normalizeApproval({ verificationMethod: 'class_rep', verificationNote: '', reason: '' })).toMatchObject({
      ok: false,
      details: { field: 'verificationMethod' },
    })
    expect(normalizeApproval({ verificationMethod: 'email_roster_match', verificationNote: '', reason: '' }).ok).toBe(false)
  })

  it('當面核對證件：說明與理由都選填', () => {
    expect(normalizeApproval({ verificationMethod: 'id_document', verificationNote: ' ', reason: '' })).toEqual({
      ok: true,
      value: { verificationMethod: 'id_document', verificationNote: null, reason: null },
    })
  })

  it('其他方式的選項與提示用白話（第三波 Q26）；沒寫說明的錯誤訊息跟選項同名', () => {
    expect(VERIFICATION_LABEL.other).toBe('用其他方式確認本人')
    expect(VERIFICATION_NOTE_HINT.other).toBe('必填：說明用了什麼方式確認本人')
    expect(normalizeApproval({ verificationMethod: 'other', verificationNote: '', reason: '' })).toMatchObject({
      ok: false,
      message: '選「用其他方式確認本人」時要說明用了什麼方式。',
      details: { field: 'verificationNote' },
    })
  })

  it('校方管道要寫由誰、什麼管道；其他方式要說明', () => {
    for (const method of ['school_channel', 'other']) {
      expect(normalizeApproval({ verificationMethod: method, verificationNote: '', reason: '' })).toMatchObject({
        ok: false,
        details: { field: 'verificationNote' },
      })
      expect(normalizeApproval({ verificationMethod: method, verificationNote: '教務處陳組長電話確認', reason: '' }).ok).toBe(true)
    }
  })

  it('退回理由必填、有長度上限，可以換行', () => {
    expect(normalizeRejection({ reason: '  ' })).toMatchObject({ ok: false, details: { field: 'reason' } })
    expect(normalizeRejection({ reason: 'x'.repeat(501) }).ok).toBe(false)
    expect(normalizeRejection({ reason: '學號填錯\n請改成學生證上的學號' })).toEqual({
      ok: true,
      value: { reason: '學號填錯\n請改成學生證上的學號' },
    })
  })
})

describe('核准時的屆別', () => {
  const cohorts = [
    { id: C115, code: '115', name: '115 學年度專題' },
    { id: C114, code: '114', name: '114 學年度專題' },
  ]
  const matched = matchRoster(app, [candidate()], C115)
  const notFound = matchRoster({ ...app, studentNo: '499999999' }, [candidate()], C115)

  it('名單上只有一屆：用名單的屆別，不看畫面送來的值', () => {
    expect(resolveApprovalCohort(matched, C114, cohorts)).toEqual({ ok: true, cohortId: C115 })
    expect(resolveApprovalCohort(matched, null, cohorts)).toEqual({ ok: true, cohortId: C115 })
  })

  it('名單所屬的屆別已封存（不在可指派清單）就不能核准進去', () => {
    expect(resolveApprovalCohort(matched, null, [cohorts[1]!])).toMatchObject({ ok: false })
  })

  it('未命中：一定要指定，伺服器不代選；指定的屆別要存在', () => {
    expect(resolveApprovalCohort(notFound, null, cohorts)).toMatchObject({ ok: false, details: { field: 'cohortId' } })
    expect(resolveApprovalCohort(notFound, 'c-nope', cohorts)).toMatchObject({ ok: false })
    expect(resolveApprovalCohort(notFound, C114, cohorts)).toEqual({ ok: true, cohortId: C114 })
  })

  it('跨屆：只能在命中的那幾屆裡選', () => {
    const in114 = candidate({ rosterVersionId: 'v-114', cohortId: C114, cohortCode: '114' })
    const both = matchRoster(app, [in114, candidate()], C115)
    const c113 = { id: 'c-113', code: '113', name: '113' }
    expect(resolveApprovalCohort(both, 'c-113', [...cohorts, c113])).toMatchObject({ ok: false })
    expect(resolveApprovalCohort(both, C114, cohorts)).toEqual({ ok: true, cohortId: C114 })
  })

  it('畫面預設值：名單屆別 → 開放註冊屆別 → 不預選（沒有開放註冊屆別時不猜）', () => {
    expect(suggestedApprovalCohort(matched, C114)).toBe(C115)
    expect(suggestedApprovalCohort(notFound, C114)).toBe(C114)
    expect(suggestedApprovalCohort(notFound, null)).toBeNull()
  })
})

describe('批次核准：哪些人會自動略過（第三波 W6，N-09）', () => {
  const cohorts = [
    { id: C115, code: '115', name: '115 學年度專題' },
    { id: C114, code: '114', name: '114 學年度專題' },
  ]
  const matched = matchRoster(app, [candidate()], C115)
  const holder = { activeHolders: [{ name: '王小明', cohortCode: '115' }], otherPending: 0 }

  it('名單比對到、學號沒人用、名單屆別可以指派：可以一起核准', () => {
    expect(bulkApprovalSkip({ match: matched, duplicates: noDuplicates }, cohorts)).toBeNull()
  })

  it('學號已被別人占用：略過，原因是「學號已被使用」', () => {
    expect(bulkApprovalSkip({ match: matched, duplicates: holder }, cohorts)).toBe('student_no_taken')
    expect(BULK_APPROVAL_SKIP_LABEL.student_no_taken).toBe('學號已被使用')
  })

  it('名單比對不到、姓名不符：略過，請個別審核', () => {
    const notFound = matchRoster({ ...app, studentNo: '499999999' }, [candidate()], C115)
    expect(bulkApprovalSkip({ match: notFound, duplicates: noDuplicates }, cohorts)).toBe('not_found')
    const mismatch = matchRoster({ ...app, appliedName: '王小名' }, [candidate()], C115)
    expect(bulkApprovalSkip({ match: mismatch, duplicates: noDuplicates }, cohorts)).toBe('name_mismatch')
  })

  it('跨屆、另有人用同一個學號申請、名單屆別已封存：略過（這些要人判斷，不替系辦選）', () => {
    const in114 = candidate({ rosterVersionId: 'v-114', cohortId: C114, cohortCode: '114' })
    const both = matchRoster(app, [in114, candidate()], C115)
    expect(bulkApprovalSkip({ match: both, duplicates: noDuplicates }, cohorts)).toBe('multiple_cohorts')
    expect(bulkApprovalSkip({ match: matched, duplicates: { activeHolders: [], otherPending: 1 } }, cohorts)).toBe(
      'other_pending',
    )
    expect(bulkApprovalSkip({ match: matched, duplicates: noDuplicates }, [cohorts[1]!])).toBe('cohort_unavailable')
  })

  it('每一種略過都有給系辦看的中文原因', () => {
    for (const label of Object.values(BULK_APPROVAL_SKIP_LABEL)) expect(label).toMatch(/[\u4e00-\u9fff]/)
  })
})

describe('授權', () => {
  const base = { kind: 'authenticated' as const, userId: 'u', mustChangePassword: false, cohortMemberships: [] }
  const admin: ResolvedActor = { ...base, roles: ['admin'], status: 'active' }
  const student: ResolvedActor = { ...base, roles: ['student'], status: 'active' }
  const pending: ResolvedActor = { ...base, roles: [], status: 'pending' }
  const disabledAdmin: ResolvedActor = { ...base, roles: ['admin'], status: 'disabled' }
  const mustChangeAdmin: ResolvedActor = { ...base, roles: ['admin'], status: 'active', mustChangePassword: true }

  it('審核只有狀態正常的管理員', () => {
    expect(reviewAccessDenied(admin)).toBeNull()
    expect(reviewAccessDenied(student)).toBe('FORBIDDEN')
    expect(reviewAccessDenied(pending)).toBe('ACCOUNT_PENDING')
    expect(reviewAccessDenied(disabledAdmin)).toBe('UNAUTHENTICATED')
    expect(reviewAccessDenied(mustChangeAdmin)).toBe('PASSWORD_CHANGE_REQUIRED')
    expect(reviewAccessDenied({ kind: 'anonymous' })).toBe('UNAUTHENTICATED')
  })

  it('看與改自己的申請只有待審的本人；已開通的人不能再改學號', () => {
    expect(ownApplicationDenied(pending, 'registration.viewOwn')).toBeNull()
    expect(ownApplicationDenied(pending, 'registration.reviseOwn')).toBeNull()
    expect(ownApplicationDenied(student, 'registration.reviseOwn')).toBe('FORBIDDEN')
    expect(ownApplicationDenied({ kind: 'anonymous' }, 'registration.viewOwn')).toBe('UNAUTHENTICATED')
    expect(ownApplicationDenied({ ...pending, mustChangePassword: true }, 'registration.reviseOwn')).toBe(
      'PASSWORD_CHANGE_REQUIRED',
    )
  })
})

describe('送申請前的 Email 驗證（VB-2，AC-VI-50）', () => {
  it('密碼註冊、還沒驗證 Email → 「請先完成 Email 驗證。」', () => {
    expect(applyDenial({ loginMethod: 'password', emailVerified: false })).toBe('請先完成 Email 驗證。')
  })

  it('已驗證、或 Google 來的人放行', () => {
    expect(applyDenial({ loginMethod: 'password', emailVerified: true })).toBeNull()
    expect(applyDenial({ loginMethod: 'google', emailVerified: false })).toBeNull()
    expect(applyDenial({ loginMethod: 'google', emailVerified: true })).toBeNull()
  })

  it('讀不到登入方式（舊 session）不在這條擋，交給呼叫端的其他規則', () => {
    expect(applyDenial({ loginMethod: undefined, emailVerified: false })).toBeNull()
  })
})

describe('Q42 自動開通的條件（VB-6，AC-VI-57）', () => {
  const cohorts = [
    { id: C115, code: '115', name: '115 學年度專題' },
    { id: C114, code: '114', name: '114 學年度專題' },
  ]
  const matched = matchRoster(app, [candidate()], C115)
  const eligible = {
    loginMethod: 'google' as const,
    emailVerified: true,
    match: matched,
    registrationOpenCohortId: C115,
    bulkApprovalSkip: bulkApprovalSkip({ match: matched, duplicates: noDuplicates }, cohorts),
  }

  it('Google 登入、Email 已驗證、Email＋學號＋姓名命中開放註冊屆別的同一列、學號沒人用：可以自動開通', () => {
    expect(matched.emailComparison).toBe('same')
    expect(eligible.bulkApprovalSkip).toBeNull()
    expect(autoApprovalEligible(eligible)).toBe(true)
  })

  it('密碼註冊（就算 Email 相同）、讀不到登入方式、Email 沒驗證：不自動開通', () => {
    expect(autoApprovalEligible({ ...eligible, loginMethod: 'password' })).toBe(false)
    expect(autoApprovalEligible({ ...eligible, loginMethod: undefined })).toBe(false)
    expect(autoApprovalEligible({ ...eligible, emailVerified: false })).toBe(false)
  })

  it('名單 Email 不同或沒填：不自動開通', () => {
    const different = matchRoster({ ...app, loginEmail: 's02@example.com' }, [candidate()], C115)
    expect(different.emailComparison).toBe('different')
    expect(autoApprovalEligible({ ...eligible, match: different })).toBe(false)
    const blank = matchRoster(app, [candidate({ email: null })], C115)
    expect(blank.emailComparison).toBe('roster_blank')
    expect(autoApprovalEligible({ ...eligible, match: blank })).toBe(false)
  })

  it('批次資格不成立（學號已被占用、別人同學號待審、跨屆）：不自動開通', () => {
    for (const skip of ['student_no_taken', 'other_pending', 'multiple_cohorts'] as const) {
      expect(autoApprovalEligible({ ...eligible, bulkApprovalSkip: skip }), skip).toBe(false)
    }
  })

  it('姓名不符、學號不在名單、名單那一列不在開放註冊屆別、沒有開放註冊屆別：不自動開通', () => {
    const mismatch = matchRoster({ ...app, appliedName: '王小名' }, [candidate()], C115)
    expect(autoApprovalEligible({ ...eligible, match: mismatch })).toBe(false)
    const notFound = matchRoster({ ...app, studentNo: '499999999' }, [candidate()], C115)
    expect(autoApprovalEligible({ ...eligible, match: notFound })).toBe(false)
    expect(autoApprovalEligible({ ...eligible, registrationOpenCohortId: C114 })).toBe(false)
    expect(autoApprovalEligible({ ...eligible, registrationOpenCohortId: null })).toBe(false)
  })

  it('Email 比對全址去空白＋小寫（R2）；不移除 +suffix、不合併全形字', () => {
    const upper = matchRoster({ ...app, loginEmail: ' S01@EXAMPLE.com ' }, [candidate()], C115)
    expect(autoApprovalEligible({ ...eligible, match: upper })).toBe(true)
    for (const loginEmail of ['s01+x@example.com', 'ｓ01@example.com', 's.01@example.com']) {
      const m = matchRoster({ ...app, loginEmail }, [candidate()], C115)
      expect(autoApprovalEligible({ ...eligible, match: m }), loginEmail).toBe(false)
    }
  })

  it('核實方式多一種 google_email_match（標籤固定）；系辦能選的清單沒有它，送進來也不收', () => {
    expect(VERIFICATION_METHODS).toContain('google_email_match')
    expect(VERIFICATION_LABEL.google_email_match).toBe('Google Email 與名單相同（自動開通）')
    expect(VERIFICATION_NOTE_REQUIRED.google_email_match).toBe(false)
    expect(MANUAL_VERIFICATION_METHODS).toEqual(['id_document', 'school_channel', 'other', 'office_review'])
    expect(normalizeApproval({ verificationMethod: 'google_email_match', verificationNote: '', reason: '' })).toMatchObject({
      ok: false,
      details: { field: 'verificationMethod' },
    })
  })
})
