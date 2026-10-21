import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * CL-2（#818）：驗收矩陣欄位完整性。`docs/plans/<份>/驗收結果.md` 的「AC 逐條」每一列都要有
 * 負責票、至少一條 `` `檔:行` test／it「名稱」 ``，而且測試檔真的存在、名稱真的出現在那個檔裡。
 *
 * 行號不比對：別的票改同一個測試檔就會跑掉（`pg-consent-bridge.integration.test.ts` 的 :743 → :762 就是例子），
 * 名稱才是穩的。設計上不靠自動測試守的列放進 `EXEMPT` 並寫理由；例外列後來補上了測試也會紅，讓清單保持乾淨。
 */

const webRoot = path.resolve(import.meta.dirname, '../..')
const plansRoot = path.resolve(webRoot, '../docs/plans')

/** key＝`docs/plans` 底下的相對路徑；值＝AC → 不靠自動測試守的理由。 */
const EXEMPT: Record<string, Record<string, string>> = {
  '2026-10-19-c-affairs-grading/驗收結果.md': {
    'AC-8': '打包大小由 `pnpm -C web build && pnpm -C web perf:bundle` 的預算擋門守（CI 也跑），沒有 test(／it(',
    'AC-37': '端到端十步是 C1-18 用 Playwright 手跑，腳本不進 repo；結果寫在同一份的「AC-37 端到端」一節',
  },
}

type TestRef = { file: string; line: number; name: string }
type Row = { ac: string; owner: string; testsCell: string; refs: TestRef[]; unparsed: string[] }
type Source = { exists: (file: string) => boolean; read: (file: string) => string }

/** 用沒跳脫的 `|` 切表格列（`\|` 是儲存格裡的字）。 */
function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim())
}

const REF = /^`([^`]+?):(\d+)` (?:test|it)「(.*)」$/

/** 只讀「## AC 逐條」那一節（到下一個 `## ` 為止）裡 `| AC-` 開頭的列。 */
function parseMatrix(md: string): Row[] {
  const lines = md.split('\n')
  const start = lines.findIndex((l) => l.trim() === '## AC 逐條')
  if (start < 0) return []
  const rows: Row[] = []
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) break
    if (!/^\|\s*AC-/.test(line)) continue
    const [ac = '', , owner = '', testsCell = ''] = cells(line)
    const refs: TestRef[] = []
    const unparsed: string[] = []
    for (const part of testsCell.split('<br>').map((p) => p.trim())) {
      const m = REF.exec(part)
      if (m) refs.push({ file: m[1]!, line: Number(m[2]), name: m[3]!.replace(/\\\|/g, '|') })
      else if (part.includes('`')) unparsed.push(part)
    }
    rows.push({ ac, owner, testsCell, refs, unparsed })
  }
  return rows
}

/** 回每個不合格的地方（一句一個）；空陣列＝整份合格。 */
function checkMatrix(rows: readonly Row[], src: Source, exempt: Record<string, string> = {}): string[] {
  const problems: string[] = []
  if (rows.length === 0) problems.push('找不到「## AC 逐條」或裡面沒有 AC 列')
  for (const row of rows) {
    const where = row.ac || '(沒有 AC 編號)'
    if (!row.owner || row.owner === '—') problems.push(`${where}：沒有負責票`)
    if (row.ac in exempt) {
      if (row.refs.length > 0) problems.push(`${where}：已經有測試了，從 EXEMPT 拿掉`)
      continue
    }
    if (row.refs.length === 0) problems.push(`${where}：沒有 \`檔:行\` test／it「名稱」`)
    for (const part of row.unparsed) problems.push(`${where}：測試格式看不懂：${part}`)
    for (const ref of row.refs) {
      if (!src.exists(ref.file)) {
        problems.push(`${where}：測試檔不存在 ${ref.file}`)
        continue
      }
      if (!src.read(ref.file).includes(ref.name)) problems.push(`${where}：${ref.file} 裡找不到測試名稱「${ref.name}」`)
    }
  }
  const acs = new Set(rows.map((r) => r.ac))
  for (const ac of Object.keys(exempt)) if (!acs.has(ac)) problems.push(`${ac}：在 EXEMPT 裡但表格沒有這一列`)
  return problems
}

/** `docs/plans/*\/驗收結果.md`，回相對 `docs/plans` 的路徑。 */
function matrices(): string[] {
  return readdirSync(plansRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => `${d.name}/驗收結果.md`)
    .filter((rel) => existsSync(path.join(plansRoot, rel)))
    .sort()
}

const repoSource: Source = {
  exists: (file) => existsSync(path.join(webRoot, file)),
  read: (file) => readFileSync(path.join(webRoot, file), 'utf8'),
}

describe('驗收矩陣檢查本身會擋（造好的壞表格）', () => {
  const fake: Record<string, string> = {
    'e2e/real.spec.ts': "test('AC-1：真的有這條', async () => {})\ntest('AC-2：a|b 也找得到', async () => {})",
  }
  const fakeSource: Source = { exists: (f) => f in fake, read: (f) => fake[f]! }
  const table = (body: string) =>
    ['# 標題', '## AC 逐條', '| AC | 狀態 | 負責票 | 測試 | 補充 |', '|---|---|---|---|---|', body, '## 下一節', '| AC-99 | ✅ | — | — | 不算 |'].join('\n')

  it('合格的列：不回任何問題；`\\|` 當成名稱裡的字；下一節的列不讀', () => {
    const rows = parseMatrix(
      table(
        [
          '| AC-1 | ✅ | C1-01 | `e2e/real.spec.ts:1` test「AC-1：真的有這條」 | — |',
          '| AC-2 | ✅ | C1-02 | `e2e/real.spec.ts:9` test「AC-2：a\\|b 也找得到」 | — |',
        ].join('\n'),
      ),
    )
    expect(rows.map((r) => r.ac)).toEqual(['AC-1', 'AC-2'])
    expect(checkMatrix(rows, fakeSource)).toEqual([])
  })

  it('沒負責票、沒測試、檔不存在、名稱對不上、格式看不懂，各自回一句', () => {
    const rows = parseMatrix(
      table(
        [
          '| AC-1 | ✅ | — | `e2e/real.spec.ts:1` test「AC-1：真的有這條」 | — |',
          '| AC-2 | ✅ | C1-02 | — | — |',
          '| AC-3 | ✅ | C1-03 | `e2e/gone.spec.ts:1` test「不存在的檔」 | — |',
          '| AC-4 | ✅ | C1-04 | `e2e/real.spec.ts:1` test「改過名的舊名稱」 | — |',
          '| AC-5 | ✅ | C1-05 | `e2e/real.spec.ts` 那條 | — |',
        ].join('\n'),
      ),
    )
    expect(checkMatrix(rows, fakeSource)).toEqual([
      'AC-1：沒有負責票',
      'AC-2：沒有 `檔:行` test／it「名稱」',
      'AC-3：測試檔不存在 e2e/gone.spec.ts',
      'AC-4：e2e/real.spec.ts 裡找不到測試名稱「改過名的舊名稱」',
      'AC-5：沒有 `檔:行` test／it「名稱」',
      'AC-5：測試格式看不懂：`e2e/real.spec.ts` 那條',
    ])
  })

  it('例外清單：沒測試的列放行；例外列補上測試、例外清單有表格沒有的列，都會紅', () => {
    const rows = parseMatrix(
      table(
        [
          '| AC-1 | ✅ | C1-01 | — | 手跑 |',
          '| AC-2 | ✅ | C1-02 | `e2e/real.spec.ts:1` test「AC-1：真的有這條」 | — |',
        ].join('\n'),
      ),
    )
    expect(checkMatrix(rows, fakeSource, { 'AC-1': '手跑' })).toEqual([])
    expect(checkMatrix(rows, fakeSource, { 'AC-1': '手跑', 'AC-2': '其實有測試', 'AC-9': '表格沒有' })).toEqual([
      'AC-2：已經有測試了，從 EXEMPT 拿掉',
      'AC-9：在 EXEMPT 裡但表格沒有這一列',
    ])
  })

  it('沒有「## AC 逐條」：整份不合格', () => {
    expect(checkMatrix(parseMatrix('# 只有標題'), fakeSource)).toEqual(['找不到「## AC 逐條」或裡面沒有 AC 列'])
  })
})

describe('docs/plans/*/驗收結果.md：每列都有負責票＋存在的測試檔＋對得上的測試名稱', () => {
  const files = matrices()

  it('至少找到一份驗收結果；EXEMPT 登記的檔都還在', () => {
    expect(files.length).toBeGreaterThan(0)
    expect(Object.keys(EXEMPT).filter((rel) => !files.includes(rel))).toEqual([])
  })

  it.each(files)('%s', (rel) => {
    const rows = parseMatrix(readFileSync(path.join(plansRoot, rel), 'utf8'))
    expect(checkMatrix(rows, repoSource, EXEMPT[rel] ?? {})).toEqual([])
  })
})
