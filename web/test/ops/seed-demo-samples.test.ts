import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseBulkStudentNos } from '@/application/accounts/directory'
import { analyzeRoster, type CohortOption } from '@/application/accounts/roster'
import { analyzeAdvisorCsv, type BatchGroupFact, type BatchTeacherFact } from '@/application/groups/advisors'
import { analyzeGroupImportCsv, GROUP_IMPORT_COLUMNS, type ImportGroupFact, type ImportStudentFact } from '@/application/groups/import'

/**
 * 第三波 W8（Q20，AC-28）：三個匯入對話框的「下載範例檔」。不需要資料庫。
 *
 * 範例檔放在 `web/public/samples/`，對話框用 `<a download>` 直接連。這裡證明：
 * - 三個檔都是 UTF-8 含 BOM（Excel／Numbers 打開中文不會亂碼）。
 * - 原樣丟進各自真正的解析函式（伺服器預覽用的同一支）沒有任何格式錯誤或逐列問題。
 * - 用的學號、組別、老師登入 Email 都是示範資料裡有的人（`scripts/demo/data.mjs`），不是真名、真信箱。
 * - 對話框裡的連結指得到檔案。
 */

const webRoot = path.join(import.meta.dirname, '..', '..')
const samples = path.join(webRoot, 'public', 'samples')
const read = (name: string) => fs.readFileSync(path.join(samples, name))

type DemoData = {
  EMAIL_DOMAIN: string
  COHORT: { code: string }
  TEACHERS: { key: string; name: string; email: string }[]
  GROUPS: { key: string; code: string; advisor: string | null; industry?: string; linkState?: string; members: { studentNo: string }[] }[]
  UNGROUPED: { studentNo: string; name: string; openToJoin: boolean; card: { bio: string; skills: string[] } }[]
  PROPOSAL: { type: string; industry: string }
  INDUSTRY: { key: string; owner: string }[]
  EVENTS: { key: string; date: string; endDate?: string; from?: string; to?: string; allDay?: boolean; audience: string }[]
  DISABLED: { studentNo: string }[]
  PENDING: { studentNo: string }[]
  AUTO_APPROVED: { studentNo: string }[]
}
const demo = (await import(pathToFileURL(path.join(webRoot, 'scripts', 'demo', 'data.mjs')).href)) as DemoData

const SAMPLES = {
  roster: '名單匯入範例.csv',
  advisors: '批次指派指導老師範例.csv',
  disable: '批次停用範例.txt',
  groupImport: '分組匯入範例.csv',
} as const

describe('範例檔：UTF-8 含 BOM', () => {
  for (const name of Object.values(SAMPLES)) {
    it(`${name} 開頭是 UTF-8 BOM、內容是合法 UTF-8`, () => {
      const bytes = read(name)
      expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
      expect(() => new TextDecoder('utf-8', { fatal: true }).decode(bytes)).not.toThrow()
    })
  }
})

describe('範例檔原樣上傳：預覽沒有格式錯誤', () => {
  const text = (name: string) => read(name).toString('utf8')

  it('名單匯入：3 列全部有效、沒有任何逐列問題，屆別欄對到示範屆別，學號與姓名都是示範學生', () => {
    const cohort: CohortOption = { id: 'demo', code: demo.COHORT.code, name: '示範 114 屆', isRegistrationOpen: false, isDefaultWorking: false }
    const r = analyzeRoster(text(SAMPLES.roster), [cohort], cohort.id)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.analysis.issues).toEqual([])
    expect(r.analysis.counts).toMatchObject({ total: 3, valid: 3, cohortMismatch: 0 })
    expect(r.analysis.columns).toEqual({ cohort: true, email: true, departmentClass: true })
    expect(r.analysis.suggestedCohortId).toBe(cohort.id)
    const known = new Map(demo.UNGROUPED.map((s) => [s.studentNo, s.name]))
    for (const e of r.analysis.entries) {
      expect(known.get(e.studentNo), e.studentNo).toBe(e.nameRaw)
      expect(e.email).toBe(`${e.studentNo}@${demo.EMAIL_DOMAIN}`)
    }
  })

  it('批次指派：3 列都是「新指派」（示範資料裡還沒有主指導的組、示範老師的登入 Email），沒有任何錯誤列', () => {
    const userId = (key: string) => `user:${key}`
    const groupsByCode = new Map<string, BatchGroupFact>(
      demo.GROUPS.map((g) => [
        g.code,
        {
          id: g.key,
          code: g.code,
          status: 'active',
          revision: 1,
          advisor: g.advisor ? { teacherUserId: userId(g.advisor), teacherName: g.advisor } : null,
        },
      ]),
    )
    const teachersByLoginEmail = new Map<string, BatchTeacherFact>(
      demo.TEACHERS.map((t) => {
        const loginEmail = `${t.email}@${demo.EMAIL_DOMAIN}`
        return [loginEmail, { userId: userId(t.key), name: t.name, loginEmail, eligible: true }]
      }),
    )
    const r = analyzeAdvisorCsv(text(SAMPLES.advisors), { groupsByCode, teachersByLoginEmail, teacherLoginByContactEmail: new Map() })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.analysis.rows.map((row) => [row.groupCode, row.kind])).toEqual([
      ['G03', 'new'],
      ['G06', 'new'],
      ['G09', 'new'],
    ])
  })

  it('批次停用：一行一個學號、沒有壞行或重複，學號都是示範帳號（兩位已停用、一位待審），不會停到在組裡的學生', () => {
    const r = parseBulkStudentNos(text(SAMPLES.disable))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.duplicates).toEqual([])
    const nos = r.entries.map((e) => e.studentNo)
    expect(nos).toHaveLength(3)
    const harmless = new Set([...demo.DISABLED, ...demo.PENDING].map((s) => s.studentNo))
    const grouped = new Set(demo.GROUPS.flatMap((g) => g.members.map((m) => m.studentNo)))
    for (const no of nos) {
      expect(harmless.has(no), no).toBe(true)
      expect(grouped.has(no), no).toBe(false)
    }
    // C2-12：自動開通的新人不在批次停用樣本裡。
    const autoApproved = new Set(demo.AUTO_APPROVED.map((s) => s.studentNo))
    for (const no of nos) expect(autoApproved.has(no), no).toBe(false)
  })
})

describe('C3-16 分組匯入範例', () => {
  it('表頭是 學號,組別代碼,類型；4 列都能做（建新組 G10 兩人＋G11 一人、加入 G09 一人），學號都是示範資料的未分組學生', () => {
    const text = read(SAMPLES.groupImport).toString('utf8')
    expect(text.replace(/^\uFEFF/, '').split('\r\n')[0]).toBe(GROUP_IMPORT_COLUMNS.join(','))
    const studentsByNo = new Map<string, ImportStudentFact>(
      demo.UNGROUPED.map((u) => [u.studentNo, { userId: `user:${u.studentNo}`, name: u.name, groupCode: null, proposerName: null }]),
    )
    const groupsByCode = new Map<string, ImportGroupFact>(
      demo.GROUPS.map((g) => [g.code, { id: g.key, code: g.code, status: 'active', memberCount: g.members.length }]),
    )
    const r = analyzeGroupImportCsv(text, { studentsByNo, groupsByCode, sizeMax: 5 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.analysis.rows).toHaveLength(4)
    expect(r.analysis.rows.map((row) => [row.groupCode, row.kind])).toEqual([
      ['G10', 'create'],
      ['G10', 'create'],
      ['G09', 'add'],
      ['G11', 'create'],
    ])
  })
})

describe('C3-01 示範資料（規格③ §10.3）', () => {
  const SKILL_PRESETS = ['前端', '後端', '資料庫', '資料分析', 'AI', 'UI 設計', '簡報', '企劃', 'Python', 'JavaScript', 'Figma']

  it('未分組四人都有名片：自介 1～50 字、技能 2～3 個不重複；至少兩人公開找隊員；技能涵蓋預設清單至少 6 種', () => {
    for (const u of demo.UNGROUPED) {
      expect([...u.card.bio].length, u.name).toBeGreaterThan(0)
      expect([...u.card.bio].length, u.name).toBeLessThanOrEqual(50)
      expect(u.card.skills.length, u.name).toBeGreaterThanOrEqual(2)
      expect(u.card.skills.length, u.name).toBeLessThanOrEqual(3)
      expect(new Set(u.card.skills).size, u.name).toBe(u.card.skills.length)
    }
    expect(demo.UNGROUPED.filter((u) => u.openToJoin).length).toBeGreaterThanOrEqual(2)
    const used = new Set(demo.UNGROUPED.flatMap((u) => u.card.skills))
    expect(SKILL_PRESETS.filter((p) => used.has(p)).length).toBeGreaterThanOrEqual(6)
  })

  it('產學：g-02 已確認（指導老師＝負責老師）、g-03 待確認且沒有指導老師；提案是產學、選 ind-03', () => {
    const owner = (key?: string) => demo.INDUSTRY.find((o) => o.key === key)?.owner
    const g02 = demo.GROUPS.find((g) => g.key === 'g-02')!
    const g03 = demo.GROUPS.find((g) => g.key === 'g-03')!
    expect(g02.linkState ?? 'active').toBe('active')
    expect(g02.advisor).toBe(owner(g02.industry))
    expect(g03).toMatchObject({ linkState: 'pending', advisor: null })
    expect(demo.PROPOSAL).toMatchObject({ type: 'industry', industry: 'ind-03' })
    expect(owner(demo.PROPOSAL.industry)).toBeTruthy()
  })

  it('活動：6 筆每筆都有結束（全天的 endDate 晚於 date、有時段的 to 晚於 from）；有一筆跨三天、對象是老師的全天活動', () => {
    expect(demo.EVENTS).toHaveLength(6)
    const days = (a: string, b: string) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000
    for (const e of demo.EVENTS) {
      if (e.allDay) expect(days(e.date, e.endDate!), e.key).toBeGreaterThanOrEqual(1)
      else expect(e.to! > e.from!, e.key).toBe(true)
    }
    const spans = demo.EVENTS.filter((e) => e.allDay && days(e.date, e.endDate!) === 3)
    expect(spans.map((e) => e.audience)).toEqual(['teachers'])
  })
})

describe('對話框的「下載範例檔」連結', () => {
  const dialogs = [
    ['src/app/dashboard/admin/accounts/import-roster-dialog.tsx', SAMPLES.roster],
    ['src/app/dashboard/admin/groups/advisor-forms.tsx', SAMPLES.advisors],
    ['src/app/dashboard/admin/accounts/bulk-disable-dialog.tsx', SAMPLES.disable],
  ] as const
  it(`import-dialog.tsx 連到 /samples/${SAMPLES.groupImport}（帶 download、文字「下載範本」），檔案存在`, () => {
    const source = fs.readFileSync(path.join(webRoot, 'src/app/dashboard/admin/groups/import-dialog.tsx'), 'utf8')
    expect(source).toMatch(new RegExp(`<a href="/samples/${SAMPLES.groupImport.replace('.', '\\.')}" download[\\s\\S]*?下載範本`))
    expect(fs.existsSync(path.join(samples, SAMPLES.groupImport))).toBe(true)
  })
  for (const [file, sample] of dialogs) {
    it(`${path.basename(file)} 連到 /samples/${sample}（帶 download），檔案存在`, () => {
      const source = fs.readFileSync(path.join(webRoot, file), 'utf8')
      expect(source).toMatch(new RegExp(`<a href="/samples/${sample.replace('.', '\\.')}" download[\\s\\S]*?下載範例檔`))
      expect(fs.existsSync(path.join(samples, sample))).toBe(true)
    })
  }
})
