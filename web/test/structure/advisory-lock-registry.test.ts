import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * CL-7（#823 第 3 條）：`pg_advisory*` 的鍵都要登記在 `docs/engineering/README.md`「寫入規則」第 2 條的鍵表。
 *
 * 每個呼叫處要對得上表上的一列：鍵前綴（`<` 前面那段）、雜湊函式（`hashtext`／`hashtextextended` 與 seed）、檔名。
 * 同一個字串用不同雜湊函式是兩把互不排斥的鎖，所以函式也要比。
 *
 * - 只比檔名、不比行號：行號每次改程式都會跑掉（表上原本寫的行號就已經過時）。
 * - **同一把鍵可以出現在好幾個檔**（例如 `groups.code:` 在 `pg-groups.ts` 與 `pg-group-import.ts`）：
 *   每個用到的檔都要列進那一列的「程式位置」。新檔沿用既有的鎖，就在那一列多加一個檔名，不用新開一列。
 * - 表上列了、程式裡卻找不到的組合也算錯（舊列沒清）。
 * - 鍵要寫得出來：SQL 裡的字串、`$N` 對到的字串／樣板字串，或同檔內一層函式回傳／參數轉交的字串。解不出來就紅，
 *   請改成這幾種寫法之一，別讓鍵藏在別的檔。
 */

const webRoot = path.resolve(import.meta.dirname, '../..')
const readmePath = path.resolve(webRoot, '../docs/engineering/README.md')
const SCAN_DIRS = ['src', 'scripts']

type Entry = { prefix: string; hash: string; seed: string | null; files: string[] }
type Site = { file: string; line: number; prefix: string | null; hash: string; seed: string | null; why?: string }

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim())
}

/** 讀「寫入規則」那一節裡表頭含「雜湊函式」的表格（交易層級與 session 層級兩張）。 */
function parseRegistry(md: string): Entry[] {
  const start = md.indexOf('## 寫入規則')
  if (start < 0) throw new Error('docs/engineering/README.md 找不到「## 寫入規則」')
  const next = md.indexOf('\n## ', start + 1)
  const section = md.slice(start, next < 0 ? undefined : next)
  const entries: Entry[] = []
  let inTable = false
  for (const raw of section.split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('|')) {
      inTable = false
      continue
    }
    const c = cells(line)
    const [keyCell = '', hashCell = '', , fileCell = ''] = c
    if (c.some((x) => x.includes('雜湊函式'))) {
      inTable = true
      continue
    }
    if (!inTable || /^-+$/.test(keyCell.replace(/[:\s]/g, ''))) continue
    const ticks = (s: string) => [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? '')
    const hash = ticks(hashCell)[0] ?? ''
    const seed = hashCell.match(/seed\s*(\d+)/)?.[1] ?? null
    const files = ticks(fileCell).filter((f) => /\.(ts|tsx|mjs)$/.test(f))
    for (const key of ticks(keyCell)) entries.push({ prefix: key.split('<')[0] ?? key, hash, seed, files })
  }
  return entries
}

/** 把 `src` 從 `open` 那格（`(` 或 `[`）切到對應的收尾，回傳裡面依頂層逗號切開的參數。字串與樣板字串裡的符號不算。 */
function splitArgs(src: string, open: number): string[] {
  const close: Record<string, string> = { '(': ')', '[': ']', '{': '}' }
  const stack: string[] = [close[src[open] ?? ''] ?? '']
  const args: string[] = []
  let cur = ''
  let i = open + 1
  while (i < src.length && stack.length) {
    const ch = src[i] ?? ''
    if (ch === "'" || ch === '"' || ch === '`') {
      const end = skipString(src, i)
      cur += src.slice(i, end)
      i = end
      continue
    }
    if (ch in close) stack.push(close[ch] ?? '')
    else if (ch === stack[stack.length - 1]) {
      stack.pop()
      if (!stack.length) break
    } else if (ch === ',' && stack.length === 1) {
      args.push(cur.trim())
      cur = ''
      i++
      continue
    }
    cur += ch
    i++
  }
  if (cur.trim()) args.push(cur.trim())
  return args
}

/** 回傳字串結尾的下一格；樣板字串的 `${…}` 會整段跳過。 */
function skipString(src: string, start: number): number {
  const q = src[start]
  let i = start + 1
  while (i < src.length) {
    if (src[i] === '\\') i += 2
    else if (src[i] === q) return i + 1
    else if (q === '`' && src[i] === '$' && src[i + 1] === '{') {
      let depth = 1
      i += 2
      while (i < src.length && depth) {
        if (src[i] === "'" || src[i] === '"' || src[i] === '`') i = skipString(src, i)
        else {
          if (src[i] === '{') depth++
          else if (src[i] === '}') depth--
          i++
        }
      }
    } else i++
  }
  return i
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 把一個運算式解成鍵前綴：字串 → 整串；樣板字串 → `${` 前面那段；同檔的常數、一層函式回傳、外層函式參數轉交。 */
function resolveKey(expr: string, file: string, at: number, depth = 0): string[] | null {
  expr = expr.trim()
  if (depth > 3) return null
  const lit = expr.match(/^(['"])((?:\\.|(?!\1).)*)\1$/)
  if (lit) return [lit[2] ?? '']
  if (expr.startsWith('`') && expr.endsWith('`')) return [expr.slice(1, -1).split('${')[0] ?? '']
  const call = expr.match(/^(\w+)\(/)
  if (call) {
    const def = new RegExp(`function ${escapeRe(call[1] ?? '')}\\s*\\(`).exec(file)
    if (!def) return null
    const body = file.indexOf('{', file.indexOf(')', def.index))
    const ret = /return\s+/.exec(file.slice(body))
    if (!ret) return null
    const retStart = body + ret.index + ret[0].length
    const retExpr = file.slice(retStart).split('\n')[0] ?? ''
    return resolveKey(retExpr, file, retStart, depth + 1)
  }
  if (!/^\w+$/.test(expr)) return null
  const constDef = new RegExp(`const ${escapeRe(expr)}\\s*(?::[^=]+)?=\\s*([^\\n]+)`).exec(file)
  if (constDef) return resolveKey(constDef[1] ?? '', file, constDef.index, depth + 1)
  // 外層函式的參數：有預設值用預設值，沒有就去找同檔所有呼叫處對應位置的參數。
  const fns = [...file.slice(0, at).matchAll(/function (\w+)\s*\(/g)]
  const fn = fns[fns.length - 1]
  if (!fn) return null
  const params = splitArgs(file, fn.index + fn[0].length - 1)
  const idx = params.findIndex((p) => (p.split(/[:=]/)[0] ?? '').trim() === expr)
  if (idx < 0) return null
  const dflt = (params[idx] ?? '').match(/=\s*(.+)$/)
  if (dflt) return resolveKey(dflt[1] ?? '', file, at, depth + 1)
  const keys: string[] = []
  for (const m of file.matchAll(new RegExp(`(?<!function )\\b${escapeRe(fn[1] ?? '')}\\(`, 'g'))) {
    const arg = splitArgs(file, m.index + m[0].length - 1)[idx]
    const got = arg === undefined ? null : resolveKey(arg, file, m.index, depth + 1)
    if (!got) return null
    keys.push(...got)
  }
  return keys.length ? keys : null
}

const CALL = /pg_(?:try_)?advisory_(?:xact_)?(?:un)?lock(?:_shared)?\s*\(/g

/** 找出一個檔裡所有 `pg_advisory*(` 呼叫，解出雜湊函式、seed 與鍵前綴。 */
function findSites(rel: string, src: string): Site[] {
  const sites: Site[] = []
  for (const m of src.matchAll(CALL)) {
    const line = src.slice(0, m.index).split('\n').length
    const base = path.basename(rel)
    const after = src.slice(m.index + m[0].length)
    const h = after.match(/^\s*(hashtext(?:extended)?)\s*\(/)
    if (!h) {
      sites.push({ file: base, line, prefix: null, hash: '?', seed: null, why: '鎖的參數要是 hashtext(…) 或 hashtextextended(…, 0)' })
      continue
    }
    const hashFn = h[1] ?? ''
    const hashOpen = m.index + m[0].length + h[0].length - 1
    const hashArgs = splitArgs(src, hashOpen)
    const seed = hashFn === 'hashtextextended' ? (hashArgs[1] ?? null) : null
    const first = (hashArgs[0] ?? '').split('||')[0]?.trim() ?? ''
    let prefixes: string[] | null
    const param = first.match(/^\$(\d+)(?:::\w+)*$/)
    if (param) {
      const q = [...src.slice(0, m.index).matchAll(/\.query(?:<[^>]*>)?\(/g)].pop()
      const qArgs = q ? splitArgs(src, q.index + q[0].length - 1) : []
      const arr = qArgs[1]
      const params = arr?.startsWith('[') ? splitArgs(arr, 0) : []
      const expr = params[Number(param[1]) - 1]
      prefixes = expr === undefined ? null : resolveKey(expr, src, m.index)
    } else {
      prefixes = resolveKey(first, src, m.index)
    }
    if (!prefixes) {
      sites.push({ file: base, line, prefix: null, hash: hashFn, seed, why: '解不出鍵（請寫成字串、$N 對到字串／樣板字串，或同檔一層函式）' })
      continue
    }
    for (const prefix of new Set(prefixes)) sites.push({ file: base, line, prefix, hash: hashFn, seed })
  }
  return sites
}

/** 比對呼叫處與鍵表，回傳所有違規（空陣列＝對得上）。 */
function check(sources: Map<string, string>, md: string): string[] {
  const registry = parseRegistry(md)
  const sites = [...sources].flatMap(([rel, src]) => findSites(rel, src))
  const bad: string[] = []
  const used = new Set<string>()
  for (const s of sites) {
    const where = `${s.file}:${s.line}`
    if (!s.prefix) {
      bad.push(`${where}：${s.why}`)
      continue
    }
    const rows = registry.filter((e) => e.prefix === s.prefix)
    if (!rows.length) {
      bad.push(`${where}：鍵「${s.prefix}」沒有登記在 docs/engineering/README.md 的鍵表`)
      continue
    }
    const row = rows.find((e) => e.hash === s.hash && (e.seed === null || e.seed === s.seed))
    if (!row) {
      const want = rows.map((e) => `${e.hash}${e.seed === null ? '' : `（seed ${e.seed}）`}`).join('／')
      bad.push(`${where}：鍵「${s.prefix}」表上用 ${want}，這裡用 ${s.hash}${s.seed === null ? '' : `（seed ${s.seed}）`}——不同函式是兩把不同的鎖`)
      continue
    }
    if (!row.files.includes(s.file)) {
      bad.push(`${where}：鍵「${s.prefix}」的「程式位置」沒有列 ${s.file}（同一把鍵可以多檔，在那一列加上檔名）`)
      continue
    }
    used.add(`${row.prefix}\0${s.file}`)
  }
  for (const e of registry) {
    for (const f of e.files) {
      if (!used.has(`${e.prefix}\0${f}`)) bad.push(`鍵表：「${e.prefix}」列了 ${f}，但那個檔裡找不到用 ${e.hash} 取這把鍵的呼叫`)
    }
  }
  return bad
}

function walk(dir: string, out: string[] = []): string[] {
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name)
    if (d.isDirectory()) {
      if (d.name !== 'node_modules') walk(p, out)
    } else if (/\.(ts|tsx|mjs)$/.test(d.name) && !/\.test\.(ts|tsx)$/.test(d.name)) out.push(p)
  }
  return out
}

function repoSources(): Map<string, string> {
  const map = new Map<string, string>()
  for (const d of SCAN_DIRS) {
    for (const f of walk(path.join(webRoot, d))) {
      const src = readFileSync(f, 'utf8')
      if (src.includes('advisory')) map.set(path.relative(webRoot, f), src)
    }
  }
  return map
}

describe('advisory lock 的鍵都登記在 docs/engineering/README.md（CL-7 #823 第 3 條）', () => {
  const md = readFileSync(readmePath, 'utf8')
  const sources = repoSources()

  it('鍵表讀得到，而且涵蓋交易層級與 session 層級', () => {
    const prefixes = parseRegistry(md).map((e) => e.prefix)
    expect(prefixes).toContain('signup-resume:')
    expect(prefixes).toContain('fju.worker')
    expect(prefixes.length).toBeGreaterThanOrEqual(10)
  })

  it('目前程式裡每個 pg_advisory* 呼叫都對得上鍵表（鍵前綴、雜湊函式、檔名），表上也沒有多出來的列', () => {
    const sites = [...sources].flatMap(([rel, src]) => findSites(rel, src))
    expect(sites.length).toBeGreaterThanOrEqual(15)
    expect(check(sources, md)).toEqual([])
  })

  describe('反例（在記憶體裡變造原始碼，不動真的檔）', () => {
    const mutate = (file: string, fn: (src: string) => string) => {
      const copy = new Map(sources)
      const key = [...copy.keys()].find((k) => k.endsWith(file))!
      copy.set(key, fn(copy.get(key)!))
      return check(copy, md)
    }

    it('多一個沒登記的鍵 → 紅', () => {
      const bad = mutate('pg-business-clock.ts', (s) =>
        s.replace(
          "select pg_advisory_xact_lock(hashtext('business_clock_overrides'))",
          "select pg_advisory_xact_lock(hashtext('business_clock_overrides')); select pg_advisory_xact_lock(hashtext('new.key'))",
        ),
      )
      expect(bad).toEqual([expect.stringContaining('鍵「new.key」沒有登記')])
    })

    it('hashtext 換成 hashtextextended → 紅（兩把不同的鎖）', () => {
      const bad = mutate('pg-cohorts.ts', (s) =>
        s.replace("pg_advisory_xact_lock(hashtext($1))', [`cohorts.", "pg_advisory_xact_lock(hashtextextended($1, 0))', [`cohorts."),
      )
      expect(bad).toEqual(expect.arrayContaining([expect.stringContaining('鍵「cohorts.」表上用 hashtext，這裡用 hashtextextended')]))
    })

    it('hashtextextended 的 seed 改掉 → 紅', () => {
      const bad = mutate('pg-items.ts', (s) => s.replace("hashtextextended('items.resource_category', 0)", "hashtextextended('items.resource_category', 1)"))
      expect(bad).toEqual(expect.arrayContaining([expect.stringContaining('鍵「items.resource_category」表上用 hashtextextended（seed 0）')]))
    })

    it('既有的鍵用在沒列的新檔 → 紅，訊息指出在那一列加檔名', () => {
      const copy = new Map(sources)
      copy.set(
        'src/infrastructure/submissions/new-writer.ts',
        "await tx.query('select pg_advisory_xact_lock(hashtext($1))', [`groups.code:${cohortId}`])",
      )
      expect(check(copy, md)).toEqual([expect.stringContaining('「程式位置」沒有列 new-writer.ts')])
    })

    it('樣板字串的鍵改了前綴、或鍵經由解不出來的寫法傳入 → 紅', () => {
      expect(mutate('pg-groups.ts', (s) => s.replace('[`groups.code:${proposal.cohort_id}`]', '[`groups.kode:${proposal.cohort_id}`]'))).toEqual(
        expect.arrayContaining([expect.stringContaining('鍵「groups.kode:」沒有登記')]),
      )
      expect(mutate('pg-business-clock.ts', (s) => s.replace("hashtext('business_clock_overrides')", 'hashtext($1)'))).toEqual(
        expect.arrayContaining([expect.stringContaining('解不出鍵')]),
      )
    })

    it('表上列了、程式裡已經沒有 → 紅', () => {
      const bad = check(sources, md.replace('`pg-business-clock.ts`', '`pg-business-clock.ts`、`gone.ts`'))
      expect(bad).toEqual([expect.stringContaining('「business_clock_overrides」列了 gone.ts')])
    })
  })
})
