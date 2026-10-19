import { describe, expect, it } from 'vitest'
import {
  analyzeGroupImportCsv,
  describeGroupImportReceipt,
  GROUP_IMPORT_COLUMNS,
  groupImportResultCsv,
  groupImportTemplate,
  planGroupImport,
  type GroupImportLookup,
  type GroupImportReceipt,
  type ImportGroupFact,
  type ImportStudentFact,
} from '@/application/groups/import'

/**
 * C3-16：系辦匯入分組的六類判定（設計方案③ §6.4；AC-C3-21、22）。
 */

const student = (no: string, patch: Partial<ImportStudentFact> = {}): [string, ImportStudentFact] => [
  no,
  { userId: `user-${no}`, name: `學生${no}`, groupCode: null, proposerName: null, ...patch },
]
const group = (code: string, memberCount: number, patch: Partial<ImportGroupFact> = {}): [string, ImportGroupFact] => [
  code,
  { id: `group-${code}`, code, status: 'active', memberCount, ...patch },
]

function lookup(): GroupImportLookup {
  return {
    studentsByNo: new Map([
      student('a'),
      student('b'),
      student('c'),
      student('d'),
      student('e', { proposerName: '發起人' }),
      student('f', { groupCode: 'G02' }),
      student('x', { groupCode: 'G01' }),
      ...['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].map((no) => student(no)),
    ]),
    groupsByCode: new Map([group('G01', 3), group('G02', 2), group('G05', 2, { status: 'dissolved' })]),
    sizeMax: 5,
  }
}

function analyze(body: string) {
  const result = analyzeGroupImportCsv(`學號,組別代碼,類型\n${body}`, lookup())
  if (!result.ok) throw new Error(result.message)
  return result.analysis
}

describe('analyzeGroupImportCsv', () => {
  it('AC-C3-21：新代碼建組（第一個學號是組長）、既有代碼加人、類型可省略', () => {
    const { rows, counts } = analyze('a,G07,一般\nb,G07,\nc,G01,\nd,G09,產學')
    expect(rows.map((r) => [r.studentNo, r.kind, r.leader, r.groupType])).toEqual([
      ['a', 'create', true, 'general'],
      ['b', 'create', false, 'general'],
      ['c', 'add', false, null],
      ['d', 'create', true, 'industry'],
    ])
    expect(rows[0]!.message).toBe('建新組 G07（一般）・組長')
    expect(rows[2]!.message).toBe('加入 G01')
    expect(counts).toMatchObject({ create: 3, add: 1, total: 4 })
  })

  it('AC-C3-22：建立中、在別組、不在本屆、代碼格式錯、超過人數上限各自的原因', () => {
    const six = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].map((no) => `${no},G10,`).join('\n')
    const { rows, counts } = analyze(`e,G08\nf,G08\ng,G08\nh,G1\n${six}`)
    const byNo = new Map(rows.map((r) => [r.studentNo, r]))
    expect(byNo.get('e')).toMatchObject({ kind: 'conflict_proposal', message: '在建立中的組別裡，請先終止' })
    expect(byNo.get('f')).toMatchObject({ kind: 'conflict_other_group', message: '已在 G02' })
    expect(byNo.get('g')).toMatchObject({ kind: 'invalid', message: '不在本屆名單' })
    expect(byNo.get('h')).toMatchObject({ kind: 'invalid', message: '代碼格式要像 G01' })
    for (const no of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']) {
      expect(byNo.get(no)).toMatchObject({ kind: 'invalid', message: '超過每組 5 人' })
    }
    expect(counts).toMatchObject({ conflict_proposal: 1, conflict_other_group: 1, invalid: 8, create: 0, total: 10 })
  })

  it('已在這組是 skip_same；加人時既有組員也算進人數上限', () => {
    const { rows } = analyze('x,G01\na,G01\nb,G01\nc,G01')
    expect(rows[0]).toMatchObject({ kind: 'skip_same', message: '已在 G01' })
    // G01 已有 3 人，再加 3 人＝6 > 5
    expect(rows.slice(1).map((r) => r.kind)).toEqual(['invalid', 'invalid', 'invalid'])
    expect(analyze('a,G01\nb,G01').rows.map((r) => r.kind)).toEqual(['add', 'add'])
  })

  it('代碼小寫會轉大寫；已刪除的代碼、重複學號、看不懂的類型都是 invalid', () => {
    expect(analyze('a,g07').rows[0]).toMatchObject({ kind: 'create', groupCode: 'G07' })
    expect(analyze('a,G05').rows[0]).toMatchObject({ kind: 'invalid', message: 'G05 已刪除，請換一個代碼' })
    expect(analyze('a,G07\na,G08').rows.map((r) => r.kind)).toEqual(['invalid', 'invalid'])
    expect(analyze('a,G07,特殊').rows[0]).toMatchObject({ kind: 'invalid', message: '類型只能填「一般」或「產學」' })
    expect(analyze(',G07').rows[0]).toMatchObject({ kind: 'invalid', message: '沒有填學號' })
  })

  it('新組的類型由第一個有填類型的列決定', () => {
    const { rows } = analyze('a,G07,\nb,G07,產學')
    expect(rows.map((r) => r.groupType)).toEqual(['industry', 'industry'])
  })

  it('整份檔案看不懂就整份退件', () => {
    expect(analyzeGroupImportCsv('', lookup())).toMatchObject({ ok: false })
    expect(analyzeGroupImportCsv('學號,老師\n1,2', lookup())).toMatchObject({ ok: false, message: expect.stringContaining('不認得的欄位「老師」') })
    expect(analyzeGroupImportCsv('組別代碼\nG01', lookup())).toMatchObject({ ok: false, message: expect.stringContaining('少了「學號」') })
    expect(analyzeGroupImportCsv('學號,組別代碼', lookup())).toMatchObject({ ok: false, message: expect.stringContaining('只有表頭') })
    // BOM 可有可無
    expect(analyzeGroupImportCsv('\uFEFF學號,組別代碼\na,G07', lookup())).toMatchObject({ ok: true })
  })
})

describe('planGroupImport', () => {
  it('新組依代碼合併、組長在前；加人逐列；其他列跳過', () => {
    const plan = planGroupImport(analyze('b,G07\nc,G01\nf,G07\nd,G09,產學\na,G07'))
    expect(plan.creates.map((c) => [c.code, c.groupType, c.rows.map((r) => r.studentNo)])).toEqual([
      ['G07', 'general', ['b', 'a']],
      ['G09', 'industry', ['d']],
    ])
    expect(plan.adds.map((r) => r.studentNo)).toEqual(['c'])
    expect(plan.skipped.map((r) => r.studentNo)).toEqual(['f'])
  })
})

describe('回執、結果表、範本', () => {
  const receipt: GroupImportReceipt = {
    cohortId: 'c',
    fileName: 'x.csv',
    results: [
      { line: 2, studentNo: 'a', groupCode: 'G07', studentName: '甲', outcome: 'created', message: '建新組 G07' },
      { line: 3, studentNo: 'g', groupCode: 'G08', studentName: null, outcome: 'skipped', message: '不在本屆名單' },
    ],
    createdGroups: 2,
    added: 1,
    skipped: 1,
    failed: 0,
  }

  it('status 句子', () => {
    expect(describeGroupImportReceipt({ ...receipt, skipped: 0 })).toBe('已匯入：新組 2、加入 1。')
    expect(describeGroupImportReceipt(receipt)).toBe('已匯入：新組 2、加入 1；1 列沒有匯入，原因寫在結果表。')
  })

  it('結果表逐列寫結果與原因', () => {
    const csv = groupImportResultCsv(receipt)
    expect(csv.startsWith('\uFEFF"行號","學號","姓名","組別代碼","結果","說明"\r\n')).toBe(true)
    expect(csv).toContain('"3","g","","G08","跳過","不在本屆名單"')
  })

  it('範本表頭就是欄位常數，而且自己就能被解析', () => {
    const template = groupImportTemplate()
    expect(template.split('\r\n')[0]).toBe(GROUP_IMPORT_COLUMNS.join(','))
    expect(GROUP_IMPORT_COLUMNS).toEqual(['學號', '組別代碼', '類型'])
    expect(analyzeGroupImportCsv(template, { ...lookup(), studentsByNo: new Map() })).toMatchObject({ ok: true })
  })
})
