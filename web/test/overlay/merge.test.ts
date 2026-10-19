/**
 * overlay 合併器（D-23 放寬，INFRA-2）：I2-1 真實資料夾＝基底、I2-2 判定不變、I2-3 撞鍵報錯、I2-4 正常用法、I2-5 fold。
 * fixtures 在 `./fixtures/`（README 有說明）；單條錯誤直接用字串餵。
 */
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { BASE_FINGERPRINTS, FINGERPRINTS } from '../../e2e/fingerprints'
import { OverlayError, mergeFromBaseFile, mergeFromDir, mergeOverlay, overlayDirFor, readOverlayFiles, type OverlayFile, type OverlayKind } from '../../scripts/overlay/merge.mjs'
// scripts/perf 是純 JS、沒有型別檔（只有 overlay/merge.d.mts 有）。
// @ts-expect-error 沒有型別檔
import { HARD_CAP_KB, SHARED_LIMIT_KB, limitFor } from '../../scripts/perf/limits.mjs'
// @ts-expect-error 沒有型別檔
import { judge } from '../../scripts/perf/sql.mjs'

const WEB = fileURLToPath(new URL('../..', import.meta.url))
const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url))
const BUDGET = path.join(WEB, 'scripts/perf/budget.json')
const SQL_EXPECT = path.join(WEB, 'scripts/perf/sql-expect.json')
const FINGERPRINTS_D = path.join(WEB, 'e2e/fingerprints.d')
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>

const file = (name: string, doc: unknown): OverlayFile => ({ name, text: typeof doc === 'string' ? doc : JSON.stringify(doc) })
const budgetBase = { $comment: 'c', $shared: { baseline: 100, limit: 230 }, $rules: { homeRoutesMustNotContain: ['recharts'] }, '/a': { baseline: 0, limit: 0 } }
const fpBase = { '/a': 'A', '/b': 'B', '/c': 'C' }

/** 斷言丟 OverlayError，而且訊息同時含每一段文字（兩個小檔名與鍵）。 */
function expectOverlayError(fn: () => unknown, ...parts: string[]) {
  let caught: unknown
  try {
    fn()
  } catch (e) {
    caught = e
  }
  expect(caught, '應該要丟錯').toBeInstanceOf(OverlayError)
  for (const p of parts) expect((caught as Error).message).toContain(p)
}

const tmpDirs: string[] = []
const mkTmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-overlay-'))
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

/** 假的 web 目錄：一個 chunk、三個路由（/a、/b、/d），給 bundle.mjs --dir 用。 */
function fakeWebDir(routes: string[]) {
  const dir = mkTmp()
  fs.mkdirSync(path.join(dir, '.next/diagnostics'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'chunks'))
  fs.writeFileSync(path.join(dir, 'chunks/x.js'), randomBytes(1500).toString('hex')) // 壓不掉，gz 約 1.5 KB
  fs.writeFileSync(path.join(dir, '.next/diagnostics/route-bundle-stats.json'), JSON.stringify(routes.map((route) => ({ route, firstLoadChunkPaths: ['chunks/x.js'] }))))
  return dir
}
const runNode = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, args, { cwd: WEB, encoding: 'utf8', env: { ...process.env, ...env } })

/**
 * I2-1：三個真實資料夾（`e2e/fingerprints.d/`、`scripts/perf/budget.d/`、`scripts/perf/sql-expect.d/`）。
 * 「合併不報錯」任何時候都驗；「合併後＝基底」只在那個資料夾**沒有小檔**時驗（有小檔的票合進後自動 skip，
 * 之後的票不用改這個檔）。小檔數讀不出來（檔名不合規則等）算 -1：等於基底那條 skip，不報錯那條會紅。
 */
const REAL_DIRS = [
  { kind: 'fingerprints', dir: FINGERPRINTS_D, merge: () => mergeFromDir(BASE_FINGERPRINTS, FINGERPRINTS_D, 'fingerprints'), base: () => BASE_FINGERPRINTS as Record<string, unknown> },
  { kind: 'budget', dir: overlayDirFor(BUDGET), merge: () => mergeFromBaseFile(BUDGET, 'budget'), base: () => readJson(BUDGET) },
  { kind: 'sql-expect', dir: overlayDirFor(SQL_EXPECT), merge: () => mergeFromBaseFile(SQL_EXPECT, 'sql-expect'), base: () => readJson(SQL_EXPECT) },
].map((d) => {
  let count = -1
  try {
    count = readOverlayFiles(d.dir).length
  } catch {
    /* 讓「合併不報錯」那條去報 */
  }
  return { ...d, count, hasFiles: count !== 0 }
})
const anyRealFiles = REAL_DIRS.some((d) => d.hasFiles)

describe('I2-1 真實資料夾', () => {
  for (const d of REAL_DIRS) {
    test(`${d.kind}：真實資料夾合併不報錯（小檔 ${d.count} 個）`, () => {
      expect(d.merge).not.toThrow()
    })

    // 有小檔的資料夾 skip（只驗上一條）；之後的票放了小檔不用改這個檔。
    test.skipIf(d.hasFiles)(`${d.kind}：資料夾沒有小檔時，合併結果與基底深度相等`, () => {
      const r = d.merge()
      expect(r.files).toEqual([])
      expect(r.merged).toEqual(d.base())
    })
  }

  test.skipIf(REAL_DIRS[0]!.hasFiles)('fingerprints.d/ 沒有小檔時，FINGERPRINTS 與 BASE_FINGERPRINTS 深度相等', () => {
    expect(FINGERPRINTS).toEqual(BASE_FINGERPRINTS)
  })

  test('overlay print budget／sql-expect 的輸出與程式內合併結果相等（沒有小檔時＝JSON.parse(基底)）；overlay check exit 0', () => {
    for (const d of REAL_DIRS.filter((d) => d.kind !== 'fingerprints')) {
      const r = runNode(['scripts/overlay/cli.mjs', 'print', d.kind])
      expect(r.status, r.stderr).toBe(0)
      expect(JSON.parse(r.stdout)).toEqual(d.merge().merged)
      if (!d.hasFiles) expect(JSON.parse(r.stdout)).toEqual(d.base())
    }
    const check = runNode(['scripts/overlay/cli.mjs', 'check'])
    expect(check.status, check.stderr).toBe(0)
    expect(check.stdout).toContain('budget.d')
    if (!anyRealFiles) expect(check.stdout).not.toContain('刪')
  })
})

describe('I2-2 判定不變', () => {
  test('sql.mjs 的 judge 對同一份假量測，用合併後的期望與用基底的期望結果相同', () => {
    const base = readJson(SQL_EXPECT) as Record<string, { max: number; identity: number; noDuplicate?: string[] }>
    const merged = mergeFromBaseFile<typeof base>(SQL_EXPECT, 'sql-expect').merged
    const sig = 'select (select count(*) from registration_applications ra join users x on x.id = ra.user_id where ra.state = ? and x.status = ?) as pendingapplications, count(*) filter (where x)'
    const row = { total: 999, identity: 3, duplicates: [{ sig, count: 2 }] }
    for (const route of Object.keys(base).filter((k) => !k.startsWith('$'))) {
      const want = judge(row, base[route], [sig])
      expect(want.length, route).toBeGreaterThan(0) // 假量測刻意超標，判定不是空的
      expect(judge(row, merged[route], [sig])).toEqual(want)
    }
  })

  test('limitFor：250 以下封頂 250、以上不封頂（Q106）', () => {
    expect(HARD_CAP_KB).toBe(250)
    expect(SHARED_LIMIT_KB).toBe(230)
    expect(limitFor(222)).toBe(245)
    expect(limitFor(223.5)).toBe(246)
    expect(limitFor(240)).toBe(250)
    expect(limitFor(250)).toBe(250)
    expect(limitFor(250.1)).toBe(276)
    expect(limitFor(300)).toBe(330)
  })
})

describe('I2-3 同鍵衝突與格式錯誤一律報錯（訊息含小檔名與鍵）', () => {
  const okRow = { baseline: 1, limit: 2 }
  const cases: Array<[string, OverlayKind, Record<string, unknown>, OverlayFile[], string[]]> = [
    ['set 撞基底', 'budget', budgetBase, [file('C1-01.json', { ticket: 'C1-01', set: { '/a': okRow } })], ['C1-01.json', '/a', '基底']],
    ['set 撞 set', 'budget', budgetBase, [file('C1-01.json', { ticket: 'C1-01', set: { '/z': okRow } }), file('C1-02.json', { ticket: 'C1-02', set: { '/z': okRow } })], ['C1-01.json', 'C1-02.json', '/z']],
    ['from 不對（不是目前主人）', 'budget', budgetBase, [file('C1-01.json', { ticket: 'C1-01', override: { '/a': { from: 'C9-99', value: okRow } } })], ['C1-01.json', '/a', 'C9-99', '基底']],
    ['from 不對（主人已是別張票）', 'budget', budgetBase, [file('C1-01.json', { ticket: 'C1-01', override: { '/a': { from: 'base', value: okRow } } }), file('C1-02.json', { ticket: 'C1-02', override: { '/a': { from: 'C9-99', value: okRow } } })], ['C1-02.json', '/a', 'C1-01.json']],
    ['分叉：兩張都從 base 改同一鍵', 'budget', budgetBase, [file('C1-01.json', { ticket: 'C1-01', override: { '/a': { from: 'base', value: okRow } } }), file('C1-02.json', { ticket: 'C1-02', override: { '/a': { from: 'base', value: okRow } } })], ['C1-01.json', 'C1-02.json', '/a', '分叉']],
    ['刪了又改', 'budget', budgetBase, [file('C1-01.json', { ticket: 'C1-01', delete: [{ key: '/a', from: 'base' }] }), file('C1-02.json', { ticket: 'C1-02', override: { '/a': { from: 'C1-01', value: okRow } } })], ['C1-02.json', '/a', 'C1-01.json', '刪']],
    ['override 不存在的鍵', 'budget', budgetBase, [file('C1-01.json', { ticket: 'C1-01', override: { '/nope': { from: 'base', value: okRow } } })], ['C1-01.json', '/nope', '不存在']],
    ['delete 不存在的鍵', 'budget', budgetBase, [file('C1-01.json', { ticket: 'C1-01', delete: [{ key: '/nope', from: 'base' }] })], ['C1-01.json', '/nope', '不存在']],
    ['帶 from 的 set 但鍵還在', 'budget', budgetBase, [file('C1-01.json', { ticket: 'C1-01', set: { '/a': { from: 'base', value: okRow } } })], ['C1-01.json', '/a', '還在']],
    ['override 缺 from', 'budget', budgetBase, [file('C1-01.json', { ticket: 'C1-01', override: { '/a': { value: okRow } } })], ['C1-01.json', '/a', 'from']],
    ['同檔重複鍵（set 與 override）', 'budget', budgetBase, [file('C1-01.json', { ticket: 'C1-01', set: { '/z': okRow }, override: { '/z': { from: 'base', value: okRow } } })], ['C1-01.json', '/z', '兩次']],
    ['未知欄位', 'budget', budgetBase, [file('C1-01.json', { ticket: 'C1-01', foo: 1 })], ['C1-01.json', 'foo']],
    ['ticket 與檔名不符', 'budget', budgetBase, [file('C1-01.json', { ticket: 'C1-02' })], ['C1-01.json', 'C1-02']],
    ['檔名不合規則', 'budget', budgetBase, [file('foo.json', { ticket: 'foo' })], ['foo.json', '不合規則']],
    ['非 JSON', 'budget', budgetBase, [file('C1-01.json', '{ ticket: ')], ['C1-01.json', 'JSON']],
    ['limit 不等於 limitFor(baseline)', 'budget', budgetBase, [file('C1-01.json', { ticket: 'C1-01', set: { '/z': { baseline: 100, limit: 250 } } })], ['C1-01.json', '/z', 'limitFor', '111']],
    ['預算列形狀不對', 'budget', budgetBase, [file('C1-01.json', { ticket: 'C1-01', set: { '/z': { baseline: 1, limit: 2, extra: 1 } } })], ['C1-01.json', '/z', 'extra']],
    ['$shared.limit 改了', 'budget', budgetBase, [file('C1-01.json', { ticket: 'C1-01', override: { $shared: { from: 'base', value: { baseline: 100, limit: 999 } } } })], ['C1-01.json', '$shared', '999', '230']],
    ['$shared 不准 set／delete', 'budget', budgetBase, [file('C1-01.json', { ticket: 'C1-01', delete: [{ key: '$shared', from: 'base' }] })], ['C1-01.json', '$shared', 'override']],
    ['動到 $rules', 'budget', budgetBase, [file('C1-01.json', { ticket: 'C1-01', override: { $rules: { from: 'base', value: {} } } })], ['C1-01.json', '$rules']],
    ['動到 $comment', 'sql-expect', { $comment: 'c' }, [file('C1-01.json', { ticket: 'C1-01', override: { $comment: { from: 'base', value: 'x' } } })], ['C1-01.json', '$comment']],
    ['其他 $ 鍵', 'budget', budgetBase, [file('C1-01.json', { ticket: 'C1-01', set: { $foo: okRow } })], ['C1-01.json', '$foo']],
    ['指紋沒有 $ 鍵', 'fingerprints', fpBase, [file('C1-01.json', { ticket: 'C1-01', set: { $shared: 'x' } })], ['C1-01.json', '$shared']],
    ['指紋必須是非空字串', 'fingerprints', fpBase, [file('C1-01.json', { ticket: 'C1-01', set: { '/z': '' } })], ['C1-01.json', '/z']],
    ['查詢數期望列形狀不對', 'sql-expect', { '/a': { as: 'admin', baseline: 1, max: 1, identity: 0 } }, [file('C1-01.json', { ticket: 'C1-01', set: { '/z': { as: 'admin', baseline: 1, max: 1 } } })], ['C1-01.json', '/z', 'identity']],
  ]
  test.each(cases)('%s', (_name, kind, base, files, parts) => {
    expectOverlayError(() => mergeOverlay(base, files, kind), ...parts)
  })

  test('readOverlayFiles：資料夾裡不合規則的檔名報錯（README 與 . 開頭略過）', () => {
    const dir = path.join(mkTmp(), 'budget.d')
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'README.md'), '#')
    fs.writeFileSync(path.join(dir, '.keep'), '')
    expect(readOverlayFiles(dir)).toEqual([])
    fs.writeFileSync(path.join(dir, 'notes.txt'), '')
    expectOverlayError(() => readOverlayFiles(dir), 'notes.txt', '不合規則')
    expect(readOverlayFiles(path.join(dir, 'missing.d'))).toEqual([])
  })

  test('perf:bundle --budget <衝突 fixture> exit 1，訊息含兩個小檔名與鍵', () => {
    const r = runNode(['scripts/perf/bundle.mjs', '--budget', path.join(FIXTURES, 'conflict/budget.json'), '--dir', fakeWebDir(['/a'])])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('C1-01.json')
    expect(r.stderr).toContain('C1-02.json')
    expect(r.stderr).toContain('/z')
  })

  test('fingerprints.ts 用衝突資料夾載入時丟錯', async () => {
    vi.stubEnv('FINGERPRINTS_OVERLAY_DIR', path.join(FIXTURES, 'conflict/fingerprints.d'))
    vi.resetModules()
    await expect(import('../../e2e/fingerprints')).rejects.toThrow(/C1-01\.json.*C1-02\.json.*\/dashboard\/admin/)
  })
})

describe('I2-4 正常用法', () => {
  const expectedBudget = {
    $comment: 'fixture 基底',
    $shared: { baseline: 101, limit: 230 },
    $rules: { homeRoutesMustNotContain: ['recharts'] },
    '/a': { baseline: 300, limit: 330 },
    '/b': { baseline: 240, limit: 250 },
    '/d': { baseline: 2, limit: 3 },
  }

  test('budget：set／override（from base 與 from 票號）／delete／加回被刪的鍵／只改 $shared.baseline、子票與修補票檔名', () => {
    const r = mergeFromBaseFile(path.join(FIXTURES, 'ok/budget.json'), 'budget')
    expect(r.files).toEqual(['C1-13.json', 'C2-22-fix1.json', 'C5-12a.json'])
    expect(r.merged).toEqual(expectedBudget)
    expect(Object.keys(r.merged)).toEqual(Object.keys(expectedBudget)) // 基底順序＋新增鍵排序
    expect(r.changed.sort()).toEqual(['$shared', '/a', '/b', '/d'])
    expect(r.deleted).toEqual(['/c'])
  })

  test('檔名順序不影響結果', () => {
    const files = readOverlayFiles(overlayDirFor(path.join(FIXTURES, 'ok/budget.json')))
    const base = readJson(path.join(FIXTURES, 'ok/budget.json'))
    expect(mergeOverlay(base, [...files].reverse(), 'budget').merged).toEqual(expectedBudget)
  })

  test('sql-expect 與 fingerprints 同一套規則', () => {
    expect(mergeFromBaseFile(path.join(FIXTURES, 'ok/sql-expect.json'), 'sql-expect').merged).toEqual({
      $comment: 'fixture 基底',
      '/a': { as: 'admin', baseline: 7, max: 7, identity: 0 },
      '/b': { as: 'teacher', baseline: 6, max: 6, identity: 0 },
      '/d': { as: 'admin', baseline: 8, max: 8, identity: 0 },
    })
    expect(mergeFromDir(fpBase, path.join(FIXTURES, 'ok/fingerprints.d'), 'fingerprints').merged).toEqual({ '/a': 'A2', '/b': 'B2', '/d': 'D2' })
  })

  test('perf:bundle --budget <fixture> 用合併後的列判定', () => {
    const webDir = fakeWebDir(['/a', '/b', '/d'])
    const merged = runNode(['scripts/perf/bundle.mjs', '--budget', path.join(FIXTURES, 'ok/budget.json'), '--dir', webDir])
    expect(merged.status, merged.stderr + merged.stdout).toBe(0)
    expect(merged.stdout).toContain('全部 3 個路由都在預算內')
    expect(merged.stdout).toMatch(/\/a\s+300\s+[\d.]+\s+330/) // 用的是合併後的 /a 列
    // 同一份基底沒有小檔：/a 的 limit 是 0、/d 沒有列 → exit 1。證明上面是靠合併後的列才過的。
    const bare = path.join(mkTmp(), 'budget.json')
    fs.copyFileSync(path.join(FIXTURES, 'ok/budget.json'), bare)
    const alone = runNode(['scripts/perf/bundle.mjs', '--budget', bare, '--dir', webDir])
    expect(alone.status).toBe(1)
    expect(alone.stdout).toContain('/d：沒有預算列')
  })
})

describe('I2-5 --write-baseline 拒絕、overlay fold', () => {
  test('budget.d/ 有小檔時 --write-baseline 拒絕並提示 overlay fold；fold 後小檔消失、基底含合併結果、print 不變', () => {
    const dir = mkTmp()
    const budget = path.join(dir, 'budget.json')
    fs.cpSync(path.join(FIXTURES, 'ok/budget.json'), budget)
    fs.cpSync(path.join(FIXTURES, 'ok/budget.d'), path.join(dir, 'budget.d'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'budget.d/README.md'), '# 留著')
    const webDir = fakeWebDir(['/a', '/b', '/d'])

    const refused = runNode(['scripts/perf/bundle.mjs', '--write-baseline', '--budget', budget, '--dir', webDir])
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain('overlay fold')
    expect(readJson(budget)['/c']).toBeDefined() // 基底沒被重寫

    const before = runNode(['scripts/overlay/cli.mjs', 'print', 'budget', '--base', budget])
    expect(before.status, before.stderr).toBe(0)
    const folded = runNode(['scripts/overlay/cli.mjs', 'fold', 'budget', '--base', budget])
    expect(folded.status, folded.stderr).toBe(0)
    expect(fs.readdirSync(path.join(dir, 'budget.d'))).toEqual(['README.md'])
    expect(readJson(budget)).toEqual(JSON.parse(before.stdout))
    const after = runNode(['scripts/overlay/cli.mjs', 'print', 'budget', '--base', budget])
    expect(JSON.parse(after.stdout)).toEqual(JSON.parse(before.stdout))

    // fold 之後 --write-baseline 可以跑了。
    const ok = runNode(['scripts/perf/bundle.mjs', '--write-baseline', '--budget', budget, '--dir', webDir])
    expect(ok.status, ok.stderr + ok.stdout).toBe(0)
  })
})
