import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ANONYMOUS, type Actor } from '@/application/accounts/actor'
import { analyzeRoster, normalizeName, pickCohort, rosterAccessDenied, type CohortOption } from '@/application/accounts/roster'

const fixture = fs.readFileSync(path.join(import.meta.dirname, '../../../test/fixtures/roster-115-test.csv'), 'utf8')

const C115: CohortOption = { id: 'c115', code: '115', name: '115 學年度專題', isRegistrationOpen: true, isDefaultWorking: true }
const C114: CohortOption = { id: 'c114', code: '114', name: '114 學年度專題', isRegistrationOpen: false, isDefaultWorking: false }
const cohorts = [C115, C114]

function analyze(text: string, selected: string | null = null) {
  const result = analyzeRoster(text, cohorts, selected)
  if (!result.ok) throw new Error(result.message)
  return result.analysis
}

describe('姓名正規化（模組 01 §2.4）', () => {
  it('去頭尾空白、中間空白縮成一個、全形英數轉半形、英文忽略大小寫', () => {
    expect(normalizeName('  Nguyen   Van\tAn ')).toBe('nguyen van an')
    expect(normalizeName('ＡＢＣ１２３')).toBe('abc123')
    expect(normalizeName('王　小明')).toBe('王 小明')
  })

  it('不替換台／臺異體字、不把空白刪光', () => {
    expect(normalizeName('臺灣')).not.toBe(normalizeName('台灣'))
    expect(normalizeName('Van An')).not.toBe(normalizeName('VanAn'))
  })
})

describe('ACC-01 的 15 列測試名單', () => {
  const analysis = analyze(fixture, 'c115')

  it('13 有效、1 重複、1 缺欄、0 衝突', () => {
    expect(analysis.counts).toMatchObject({ total: 15, valid: 13, duplicate: 1, missing: 1, conflict: 0, cohortMismatch: 0 })
  })

  it('重複的 S03 只留第一列；缺姓名那列不匯入並標行號', () => {
    expect(analysis.entries.filter((e) => e.studentNo === '411500003')).toHaveLength(1)
    expect(analysis.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ line: 15, studentNo: '411500003', kind: 'duplicate', action: 'skipped' }),
        expect.objectContaining({ line: 16, studentNo: '411500014', kind: 'missing_name', action: 'skipped' }),
      ]),
    )
  })

  it('S09 沒有 Email 仍然有效；系級照原文字保存、缺值留白', () => {
    const s09 = analysis.entries.find((e) => e.studentNo === '411500009')
    expect(s09).toMatchObject({ email: null, departmentClass: '資管二乙' })
    expect(analysis.entries.find((e) => e.studentNo === '411500006')?.departmentClass).toBeNull()
    expect(analysis.columns).toEqual({ cohort: true, email: true, departmentClass: true })
  })

  it('姓名裡有逗號（加了引號）照樣讀得對', () => {
    expect(analysis.entries.find((e) => e.studentNo === '411500013')?.nameRaw).toBe('Nguyen, Van An')
  })

  it('屆別欄全部是 115，建議選 115', () => {
    expect(analysis.suggestedCohortId).toBe('c115')
    expect(analysis.cohortValues).toEqual([{ value: '115', rows: 13, cohortId: 'c115' }])
  })
})

describe('去重與衝突（依學號）', () => {
  it('同學號不同姓名：整組不匯入，列為衝突', () => {
    const a = analyze('student_no,name\n1,王小明\n1,王大明\n2,林\n')
    expect(a.counts).toMatchObject({ total: 3, valid: 1, conflict: 2, duplicate: 0 })
    expect(a.entries.map((e) => e.studentNo)).toEqual(['2'])
    expect(a.issues.filter((i) => i.kind === 'name_mismatch')).toHaveLength(2)
  })

  it('正規化後相同的姓名算重複不算衝突（大小寫、全形、空白）', () => {
    const a = analyze('student_no,name\n1,Van An\n1,  VAN   an \n1,ＶＡＮ ＡＮ\n')
    expect(a.counts).toMatchObject({ valid: 1, duplicate: 2, conflict: 0 })
    // 保存的是第一列的原始姓名。
    expect(a.entries[0]!.nameRaw).toBe('Van An')
  })

  it('不因姓名相同就合併兩個不同學號的學生', () => {
    const a = analyze('student_no,name\n1,王小明\n2,王小明\n')
    expect(a.counts.valid).toBe(2)
  })

  it('學號保留前導零；缺學號、學號含符號、欄位比表頭多都算缺欄', () => {
    const a = analyze('student_no,name\n00123,王\n,林\n12-3,陳\n9,李,多一欄\n')
    expect(a.entries.map((e) => e.studentNo)).toEqual(['00123'])
    expect(a.counts).toMatchObject({ total: 4, valid: 1, missing: 3 })
    expect(a.issues.map((i) => i.kind)).toEqual(['missing_student_no', 'invalid_student_no', 'column_count'])
  })

  it('Email 格式不對：照樣匯入但 Email 留白並提醒', () => {
    const a = analyze('student_no,name,email\n1,王,not-an-email\n')
    expect(a.entries[0]!.email).toBeNull()
    expect(a.counts).toMatchObject({ valid: 1, invalidEmail: 1 })
    expect(a.issues[0]).toMatchObject({ kind: 'invalid_email', action: 'warning' })
  })

  it('total 一定等於 valid + duplicate + missing + conflict', () => {
    const a = analyze('student_no,name\n1,a\n1,a\n2,b\n2,c\n,d\n3,\n4,e\n')
    const { total, valid, duplicate, missing, conflict } = a.counts
    expect(total).toBe(valid + duplicate + missing + conflict)
  })
})

describe('表頭', () => {
  it('舊三欄 CSV（沒有系級、沒有屆別）也可以匯入', () => {
    const a = analyze('student_no,name,email\n1,王,a@b.tw\n')
    expect(a.columns).toEqual({ cohort: false, email: true, departmentClass: false })
    expect(a.entries[0]!.departmentClass).toBeNull()
    expect(a.suggestedCohortId).toBeNull()
  })

  it('欄位順序不拘；系級欄可以寫中文「系級」；表頭大小寫不拘', () => {
    const a = analyze('NAME,系級,Student_No\n王,資管二甲,1\n')
    expect(a.entries[0]).toMatchObject({ studentNo: '1', nameRaw: '王', departmentClass: '資管二甲' })
  })

  it('不認得的欄位、缺必填欄、重複欄、只有表頭：整份退件並說明', () => {
    expect(analyzeRoster('student_no,name,phone\n1,王,0912\n', cohorts, null)).toMatchObject({ ok: false })
    expect(analyzeRoster('student_no,email\n1,a@b.tw\n', cohorts, null)).toMatchObject({ ok: false })
    expect(analyzeRoster('student_no,name,name\n1,a,b\n', cohorts, null)).toMatchObject({ ok: false })
    expect(analyzeRoster('student_no,name\n', cohorts, null)).toMatchObject({ ok: false })
    expect(analyzeRoster('', cohorts, null)).toMatchObject({ ok: false })
  })
})

describe('屆別欄（CSV 屆別對不到時讓管理員選既有屆別）', () => {
  it('對不到既有屆別：沒有建議值，選了之後標成提醒但照樣匯入', () => {
    const text = 'student_no,name,cohort\n1,王,116\n2,林,116\n'
    const before = analyze(text)
    expect(before.suggestedCohortId).toBeNull()
    expect(before.cohortValues).toEqual([{ value: '116', rows: 2, cohortId: null }])

    const after = analyze(text, 'c115')
    expect(after.counts).toMatchObject({ valid: 2, cohortMismatch: 2 })
    // 按值彙總（cohortValues），不逐列洗版。
    expect(after.issues).toEqual([])
  })

  it('屆別欄可以寫代碼或名稱；跟所選屆別不同就提醒', () => {
    const text = 'student_no,name,cohort\n1,王,115 學年度專題\n2,林,114\n'
    const a = analyze(text, 'c115')
    expect(a.cohortValues.map((v) => v.cohortId)).toEqual(['c115', 'c114'])
    expect(a.suggestedCohortId).toBeNull()
    expect(a.counts.cohortMismatch).toBe(1)
  })

  it('預設選哪一屆：指定的 → CSV 建議 → 開放註冊 → 預設工作屆別', () => {
    expect(pickCohort('c114', 'c115', cohorts)).toBe('c114')
    expect(pickCohort('nope', null, cohorts)).toBe('c115')
    expect(pickCohort(null, 'c114', cohorts)).toBe('c114')
    expect(pickCohort(null, null, [C114])).toBeNull()
  })
})

describe('授權：只有狀態正常的管理員', () => {
  const base: Actor = { userId: 'u', roles: ['admin'], status: 'active', mustChangePassword: false, cohortMemberships: [] }
  const as = (patch: Partial<Actor>) => ({ kind: 'authenticated' as const, ...base, ...patch })

  it('管理員放行；學生、老師、待審、必須改密、未登入一律擋', () => {
    expect(rosterAccessDenied(as({}))).toBeNull()
    expect(rosterAccessDenied(as({ roles: ['student'] }))).toBe('FORBIDDEN')
    expect(rosterAccessDenied(as({ roles: ['teacher'] }))).toBe('FORBIDDEN')
    expect(rosterAccessDenied(as({ status: 'pending' }))).toBe('ACCOUNT_PENDING')
    expect(rosterAccessDenied(as({ mustChangePassword: true }))).toBe('PASSWORD_CHANGE_REQUIRED')
    expect(rosterAccessDenied(as({ status: 'disabled' }))).toBe('UNAUTHENTICATED')
    expect(rosterAccessDenied(ANONYMOUS)).toBe('UNAUTHENTICATED')
  })
})
