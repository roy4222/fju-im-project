import { describe, expect, it } from 'vitest'
import {
  accountAdminDenied,
  buildAccountsCsv,
  classifyBulk,
  directoryQueryString,
  likePattern,
  normalizeDirectoryFilter,
  normalizeExportSelection,
  normalizeStatusReason,
  parseBulkStudentNos,
  rosterFileDownloadable,
  sameTargets,
  type AccountRow,
  type BulkCandidate,
  type ResolvedActor,
} from '@/application/accounts'

/** 票 9：帳號列表、停用、批次停用、匯出的純規則（ACC-09、ACC-15）。 */

const ADMIN_ID = '0190a0a0-0000-7000-8000-000000000001'
function actor(roles: ('student' | 'teacher' | 'admin')[], status: 'active' | 'pending' | 'disabled' = 'active'): ResolvedActor {
  return { kind: 'authenticated', userId: ADMIN_ID, roles, status, mustChangePassword: false, cohortMemberships: [] }
}

describe('授權：只有狀態正常的管理員', () => {
  it('管理員放行；老師、學生 FORBIDDEN；未登入與停用 UNAUTHENTICATED', () => {
    expect(accountAdminDenied(actor(['admin']))).toBeNull()
    expect(accountAdminDenied(actor(['teacher']))).toBe('FORBIDDEN')
    expect(accountAdminDenied(actor(['student']))).toBe('FORBIDDEN')
    expect(accountAdminDenied({ kind: 'anonymous' })).toBe('UNAUTHENTICATED')
    expect(accountAdminDenied(actor(['admin'], 'disabled'))).toBe('UNAUTHENTICATED')
  })
})

describe('名單原檔下載政策（票 6 審查建議）', () => {
  it('沒有綁到名單版本的原檔，管理員也拿不到', () => {
    expect(rosterFileDownloadable(actor(['admin']), [])).toBe(false)
    expect(rosterFileDownloadable(actor(['admin']), [{ refType: 'draft' }])).toBe(false)
  })
  it('已匯入的原檔：管理員可以，其他人不行', () => {
    const refs = [{ refType: 'roster_version' }]
    expect(rosterFileDownloadable(actor(['admin']), refs)).toBe(true)
    expect(rosterFileDownloadable(actor(['teacher']), refs)).toBe(false)
  })
})

describe('網址篩選', () => {
  it('認不得的值當作沒指定，排序只收白名單', () => {
    const f = normalizeDirectoryFilter({ q: '  王  小明 ', role: 'root', status: 'disabled', sort: 'name; drop table', dir: 'up', page: '-3', cohort: 'x' })
    expect(f).toEqual({ q: '王 小明', role: null, cohortId: null, status: 'disabled', sort: 'createdAt', dir: 'desc', page: 1 })
  })
  it('合法值原樣保留，轉回網址時預設值不寫', () => {
    const cohort = '0190a0a0-0000-7000-8000-00000000000c'
    const f = normalizeDirectoryFilter({ q: 'abc', role: 'student', cohort, sort: 'studentNo', dir: 'asc', page: '2' })
    expect(f).toMatchObject({ role: 'student', cohortId: cohort, sort: 'studentNo', dir: 'asc', page: 2 })
    expect(directoryQueryString(f)).toBe(`?q=abc&role=student&cohort=${cohort}&sort=studentNo&dir=asc&page=2`)
    expect(directoryQueryString(normalizeDirectoryFilter({}))).toBe('')
  })
  it('搜尋字裡的 % _ \\ 當一般字元', () => {
    expect(likePattern('50%_a\\b')).toBe('%50\\%\\_a\\\\b%')
  })
})

describe('匯出範圍', () => {
  it('勾選：一定要有、一定要是合法 ID', () => {
    expect(normalizeExportSelection({ kind: 'ids', userIds: [] }).ok).toBe(false)
    expect(normalizeExportSelection({ kind: 'ids', userIds: ['not-a-uuid'] }).ok).toBe(false)
    const ok = normalizeExportSelection({ kind: 'ids', userIds: [ADMIN_ID, ADMIN_ID] })
    expect(ok.ok && ok.value).toEqual({ kind: 'ids', userIds: [ADMIN_ID] })
  })
  it('全部篩選結果：不限分頁', () => {
    const ok = normalizeExportSelection({ kind: 'filter', filter: { status: 'active', page: '3' } })
    expect(ok.ok && ok.value.kind === 'filter' && ok.value.filter).toMatchObject({ status: 'active', page: 1 })
  })
  it('其他說法一律拒絕', () => {
    expect(normalizeExportSelection(null).ok).toBe(false)
    expect(normalizeExportSelection({ kind: 'rows', rows: [] }).ok).toBe(false)
  })
})

function row(patch: Partial<AccountRow>): AccountRow {
  return {
    userId: ADMIN_ID,
    name: '王小明',
    studentNo: '0411500001',
    departmentClass: '資管二甲',
    cohortId: null,
    cohortCode: '114',
    cohortName: '114 學年度',
    phone: '0912-345-678',
    loginEmail: 's@example.com',
    contactEmail: 'c@example.com',
    roles: ['student'],
    status: 'active',
    applicationState: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    ...patch,
  }
}

describe('匯出 CSV', () => {
  it('UTF-8 BOM、固定欄位、學號保留前導零、CRLF', () => {
    const csv = buildAccountsCsv([row({})])
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    const [header, line, tail] = csv.slice(1).split('\r\n')
    expect(header).toBe('"姓名","學號","系級","屆別","手機","登入 Email","聯絡 Email","角色","狀態"')
    expect(line).toBe('"王小明","0411500001","資管二甲","114","0912-345-678","s@example.com","c@example.com","學生","已核准"')
    expect(tail).toBe('')
  })
  it('公式字首加 \'、引號加倍、逗號與換行留在格子裡', () => {
    const csv = buildAccountsCsv([
      row({ name: '=HYPERLINK("http://x")', departmentClass: '資管,二甲', phone: '+886 912', contactEmail: null, roles: ['teacher', 'admin'], status: 'disabled' }),
    ])
    const line = csv.slice(1).split('\r\n')[1]!
    expect(line).toContain('"\'=HYPERLINK(""http://x"")"')
    expect(line).toContain('"資管,二甲"')
    expect(line).toContain('"\'+886 912"')
    expect(line).toContain('""')
    expect(line).toContain('"老師、管理員","已停用"')
  })
  it('待審的人沒有角色、沒有屆別時是空白，不是 null 字樣', () => {
    const csv = buildAccountsCsv([row({ roles: [], cohortCode: null, status: 'pending' })])
    const line = csv.slice(1).split('\r\n')[1]!
    expect(line).not.toContain('null')
    expect(line.endsWith('"","待審核"')).toBe(true)
  })
})

describe('停用理由', () => {
  it('必填、有上限、不收控制字元', () => {
    expect(normalizeStatusReason('  ').ok).toBe(false)
    expect(normalizeStatusReason('x'.repeat(501)).ok).toBe(false)
    expect(normalizeStatusReason('a\u0000b').ok).toBe(false)
    const ok = normalizeStatusReason(' 休學\n一學期 ')
    expect(ok.ok && ok.value).toBe('休學\n一學期')
  })
})

describe('批次停用 TXT', () => {
  it('一行一個學號，允許空白行與 BOM，重複的留第一行', () => {
    const parsed = parseBulkStudentNos(String.fromCharCode(0xfeff) + '411500001\r\n\r\n  411500002  \n411500001\na411\nA411\n')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.entries).toEqual([
      { line: 1, studentNo: '411500001' },
      { line: 3, studentNo: '411500002' },
      { line: 5, studentNo: 'a411' },
    ])
    expect(parsed.duplicates).toEqual([
      { line: 4, studentNo: '411500001', firstLine: 1 },
      { line: 6, studentNo: 'A411', firstLine: 5 },
    ])
  })
  it('其他自由格式整份退件，並指出第幾行', () => {
    const bad = parseBulkStudentNos('411500001\n411500002,王小明\n411500003 411500004\n')
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.message).toContain('第 2、3 行')
  })
  it('空檔、太多行都擋', () => {
    expect(parseBulkStudentNos('\n\n').ok).toBe(false)
    expect(parseBulkStudentNos('1\n'.repeat(2001)).ok).toBe(false)
  })

  const cand = (userId: string, studentNo: string, status: BulkCandidate['status'], cohortCode = '114'): BulkCandidate => ({
    userId,
    name: `人${userId.slice(-1)}`,
    studentNo,
    cohortCode,
    status,
  })

  it('分成將停用／已停用／找不到／重複，以及要人工處理的', () => {
    const parsed = parseBulkStudentNos('411A\n411B\n411C\n411D\n411E\n411a\n')
    if (!parsed.ok) throw new Error('parse')
    const preview = classifyBulk(
      parsed,
      [
        cand('u1', '411a', 'active'),
        cand('u2', '411B', 'disabled'),
        cand('u3', '411D', 'active', '113'),
        cand('u4', '411D', 'active', '114'),
        cand(ADMIN_ID, '411E', 'active'),
        cand('u6', '411C', 'pending'),
      ],
      ADMIN_ID,
    )
    expect(preview.hits.map((h) => [h.userId, h.line])).toEqual([['u1', 1]])
    expect(preview.alreadyDisabled.map((h) => h.userId)).toEqual(['u2'])
    expect(preview.notFound.map((n) => n.studentNo)).toEqual(['411C'])
    expect(preview.duplicates.map((d) => d.line)).toEqual([6])
    expect(preview.skipped.map((s) => [s.studentNo, s.accounts.length])).toEqual([
      ['411D', 2],
      ['411E', 1],
    ])
    expect(preview.skipped[1]!.reason).toBe('不能停用自己')
  })

  it('執行前再算一次，要停用的人要跟預覽一樣', () => {
    expect(sameTargets(['a', 'b'], ['b', 'a'])).toBe(true)
    expect(sameTargets(['a'], ['a', 'b'])).toBe(false)
    expect(sameTargets(['a', 'b'], ['a', 'c'])).toBe(false)
  })
})
