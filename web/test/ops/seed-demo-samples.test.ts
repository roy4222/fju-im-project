import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseBulkStudentNos } from '@/application/accounts/directory'
import { analyzeRoster, type CohortOption } from '@/application/accounts/roster'
import { analyzeAdvisorCsv, type BatchGroupFact, type BatchTeacherFact } from '@/application/groups/advisors'

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
  GROUPS: { key: string; code: string; advisor: string | null; members: { studentNo: string }[] }[]
  UNGROUPED: { studentNo: string; name: string }[]
  DISABLED: { studentNo: string }[]
  PENDING: { studentNo: string }[]
  AUTO_APPROVED: { studentNo: string }[]
}
const demo = (await import(pathToFileURL(path.join(webRoot, 'scripts', 'demo', 'data.mjs')).href)) as DemoData

const SAMPLES = {
  roster: '名單匯入範例.csv',
  advisors: '批次指派指導老師範例.csv',
  disable: '批次停用範例.txt',
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

describe('對話框的「下載範例檔」連結', () => {
  const dialogs = [
    ['src/app/dashboard/admin/accounts/import-roster-dialog.tsx', SAMPLES.roster],
    ['src/app/dashboard/admin/groups/advisor-forms.tsx', SAMPLES.advisors],
    ['src/app/dashboard/admin/accounts/bulk-disable-dialog.tsx', SAMPLES.disable],
  ] as const
  for (const [file, sample] of dialogs) {
    it(`${path.basename(file)} 連到 /samples/${sample}（帶 download），檔案存在`, () => {
      const source = fs.readFileSync(path.join(webRoot, file), 'utf8')
      expect(source).toMatch(new RegExp(`<a href="/samples/${sample.replace('.', '\\.')}" download[\\s\\S]*?下載範例檔`))
      expect(fs.existsSync(path.join(samples, sample))).toBe(true)
    })
  }
})
