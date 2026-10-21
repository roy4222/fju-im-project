import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * 延遲 chunk 不准靜態 import 共用模組（CL-7；`docs/engineering/前端慣例.md`「延遲 chunk」那條）。
 *
 * 「點開才下載」的模組（`import('…')`、`next/dynamic(() => import('…'))` 的目標）只要靜態 import 了
 * `cn`、`@/app/_ui/ui/button`、`@/app/_ui/dashboard/look` 或任何 `'use server'` 檔，Turbopack 會因此重切
 * 全站共用 chunk，每條路由都變大。要用的東西由呼叫端當參數傳進來（例：`_ui/staggered-menu.tsx`、
 * `dashboard/_timeline/gantt/gantt-dialogs.tsx` 開頭說明；server action 用 `provide*Actions` 注入）。
 *
 * 做法：掃 `src/` 找出所有動態 import 的目標當入口，沿靜態 import（不含 `import type`）一路往下追；
 * 碰到另一個入口就停（它自己是另一個 chunk，會被單獨檢查）。路徑上任何一個模組引用黑名單都算違規。
 * 為什麼不用 eslint：lint 一次只看一個檔，不知道哪些檔是延遲載入的入口、也追不了整條引用鏈。
 */

const SRC = path.join(import.meta.dirname, '..', '..', 'src')
const BLOCKED = new Map([
  ['shared/cn.ts', '`cn`（@/shared/cn）'],
  ['app/_ui/ui/button.tsx', '`@/app/_ui/ui/button`'],
  ['app/_ui/dashboard/look.ts', '`@/app/_ui/dashboard/look`'],
])

type Dynamic = { spec: string; line: number }
type Parsed = { file: string; text: string; dynamic: Dynamic[]; opaque: Dynamic[]; statics: string[] }

class Sources {
  #cache = new Map<string, Parsed>()
  readonly files: string[]

  constructor(private readonly overrides: Record<string, string> = {}) {
    const found: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) found.push(path.relative(SRC, p))
      }
    }
    walk(SRC)
    for (const f of Object.keys(overrides)) if (!found.includes(f)) found.push(f)
    this.files = found.sort()
  }

  exists(file: string) {
    return file in this.overrides || fs.existsSync(path.join(SRC, file))
  }

  text(file: string) {
    return this.overrides[file] ?? fs.readFileSync(path.join(SRC, file), 'utf8')
  }

  parse(file: string): Parsed {
    const hit = this.#cache.get(file)
    if (hit) return hit
    const text = this.text(file)
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    const dynamic: Dynamic[] = []
    const opaque: Dynamic[] = []
    const statics: string[] = []
    const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = n.arguments[0]
        // 參數不是字面字串（例如帶變數的 template）就看不出載的是哪支，記下來讓測試紅，不默默略過。
        if (arg && ts.isStringLiteralLike(arg)) dynamic.push({ spec: arg.text, line: lineOf(n) })
        else opaque.push({ spec: arg ? arg.getText(sf) : '(沒有參數)', line: lineOf(n) })
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
    for (const s of sf.statements) {
      if (ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier)) {
        const clause = s.importClause
        if (clause?.isTypeOnly) continue
        const named = clause?.namedBindings
        const onlyTypes = clause && !clause.name && named && ts.isNamedImports(named) && named.elements.length > 0 && named.elements.every((e) => e.isTypeOnly)
        if (!onlyTypes) statics.push(s.moduleSpecifier.text)
      } else if (ts.isExportDeclaration(s) && !s.isTypeOnly && s.moduleSpecifier && ts.isStringLiteral(s.moduleSpecifier)) {
        statics.push(s.moduleSpecifier.text)
      }
    }
    const parsed = { file, text, dynamic, opaque, statics }
    this.#cache.set(file, parsed)
    return parsed
  }

  /** `@/…` 與相對路徑解析成 `src/` 底下的檔；外部套件回 null。 */
  resolve(from: string, spec: string): string | null {
    const base = spec.startsWith('@/') ? spec.slice(2) : spec.startsWith('.') ? path.join(path.dirname(from), spec) : null
    if (base === null) return null
    for (const ext of ['', '.ts', '.tsx', '/index.ts', '/index.tsx']) {
      const f = path.normalize(base + ext)
      if (/\.tsx?$/.test(f) && this.exists(f)) return f
    }
    return null
  }

  isServerActions(file: string) {
    return /^\s*(['"])use server\1/.test(this.text(file).replace(/^(\s*\/\/[^\n]*\n|\s*\/\*[\s\S]*?\*\/)*/, ''))
  }
}

/** 所有延遲載入的入口（動態 import 的目標）→ 是誰載入它的。外部套件（例如 `sharp`）不算。 */
function lazyEntries(sources: Sources) {
  const entries = new Map<string, string>()
  for (const f of sources.files) {
    for (const { spec } of sources.parse(f).dynamic) {
      const target = sources.resolve(f, spec)
      if (target && !entries.has(target)) entries.set(target, f)
    }
  }
  return entries
}

/** 看不懂的動態 import：參數不是字面字串，或 `@/`／相對路徑卻解析不到檔案。這兩種都會讓入口漏掉檢查。 */
function unreadable(sources: Sources) {
  const out: string[] = []
  for (const f of sources.files) {
    const parsed = sources.parse(f)
    for (const d of parsed.opaque) out.push(`${f}:${d.line} import(${d.spec}) 參數不是字面字串`)
    for (const d of parsed.dynamic) {
      if ((d.spec.startsWith('@/') || d.spec.startsWith('.')) && !sources.resolve(f, d.spec)) out.push(`${f}:${d.line} import('${d.spec}') 解析不到檔案`)
    }
  }
  return out
}

/** 入口 → 違規的引用鏈（入口 > 中間模組 > 黑名單）。 */
function violations(sources: Sources) {
  const entries = lazyEntries(sources)
  const problems: Record<string, string[]> = {}
  for (const entry of entries.keys()) {
    const seen = new Set([entry])
    const queue: Array<[string, string[]]> = [[entry, [entry]]]
    while (queue.length) {
      const [file, chain] = queue.shift()!
      for (const spec of sources.parse(file).statics) {
        const target = sources.resolve(file, spec)
        if (!target) continue
        const why = BLOCKED.get(target) ?? (sources.isServerActions(target) ? `server actions（${target}）` : null)
        if (why) {
          ;(problems[entry] ??= []).push(`${[...chain, spec].join(' > ')}：${why}`)
          continue
        }
        if (seen.has(target) || entries.has(target)) continue
        seen.add(target)
        queue.push([target, [...chain, target]])
      }
    }
  }
  return problems
}

const sources = new Sources()

function mutate(file: string, prepend: string, extra: Record<string, string> = {}) {
  return new Sources({ [file]: prepend + sources.text(file), ...extra })
}

describe('CL-7：延遲 chunk 不准靜態 import 共用模組', () => {
  it('找得到延遲入口（甘特對話框、前台編輯表單、特效、頭像裁切……）', () => {
    const entries = [...lazyEntries(sources).keys()]
    expect(entries.length).toBeGreaterThanOrEqual(25)
    for (const f of [
      'app/dashboard/_timeline/gantt/gantt-dialogs.tsx',
      'app/_ui/staggered-menu.tsx',
      'app/dashboard/admin/affairs/front-edit/news.tsx',
      'app/_ui/avatar/avatar-crop-dialog.tsx',
    ]) {
      expect(entries).toContain(f)
    }
  })

  it('黑名單的三個檔都還在（改名時要跟著改這裡，不然等於沒檢查）', () => {
    for (const file of BLOCKED.keys()) expect(sources.exists(file), `黑名單 ${file} 不存在`).toBe(true)
  })

  it('每個動態 import 都看得懂：參數是字面字串、站內路徑解析得到檔案', () => {
    expect(unreadable(sources)).toEqual([])
  })

  it('目前每個延遲入口的整條靜態引用鏈都沒有碰黑名單', () => {
    expect(violations(sources)).toEqual({})
  })
})

describe('CL-7：違規就紅（變造）', () => {
  const dialogs = 'app/dashboard/_timeline/gantt/gantt-dialogs.tsx'

  it('入口直接 import cn', () => {
    const v = violations(mutate(dialogs, "import { cn } from '@/shared/cn'\n"))
    expect(Object.keys(v)).toEqual([dialogs])
    expect(v[dialogs]![0]).toContain('@/shared/cn')
  })

  it('入口直接 import button、look', () => {
    expect(Object.keys(violations(mutate(dialogs, "import { Button } from '@/app/_ui/ui/button'\n")))).toEqual([dialogs])
    expect(Object.keys(violations(mutate(dialogs, "import { INPUT } from '@/app/_ui/dashboard/look'\n")))).toEqual([dialogs])
  })

  it('經過中間模組間接 import（只看入口那一層抓不到）', () => {
    const helper = 'app/dashboard/_timeline/gantt/zz-helper.ts'
    const v = violations(
      mutate(dialogs, "import { helper } from './zz-helper'\n", { [helper]: "import { cn } from '@/shared/cn'\nexport const helper = cn\n" }),
    )
    expect(v[dialogs]?.[0]).toContain('zz-helper')
  })

  it('靜態 import server action（檔名不叫 actions 也抓；`import type` 放行）', () => {
    const action = 'app/dashboard/_timeline/gantt/zz-ops.ts'
    const extra = { [action]: "'use server'\nexport async function zzAction() {}\n" }
    expect(Object.keys(violations(mutate(dialogs, "import { zzAction } from './zz-ops'\n", extra)))).toEqual([dialogs])
    expect(violations(mutate(dialogs, "import type { zzAction } from './zz-ops'\n", extra))).toEqual({})
    expect(violations(mutate(dialogs, "import { type zzAction } from './zz-ops'\n", extra))).toEqual({})
  })

  it('看不懂的動態 import 會紅並指出檔案與行號：帶變數的 template、解析不到的路徑', () => {
    const lazy = { 'app/_ui/zz-lazy.tsx': "import { buttonVariants } from '@/app/_ui/ui/button'\nexport const x = buttonVariants\n" }
    expect(unreadable(new Sources({ ...lazy, 'app/_ui/zz-loader.ts': 'export const load = (n: string) => import(`@/app/_ui/zz-${n}`)\n' }))).toEqual([
      'app/_ui/zz-loader.ts:1 import(`@/app/_ui/zz-${n}`) 參數不是字面字串',
    ])
    expect(unreadable(new Sources({ ...lazy, 'app/_ui/zz-loader.ts': "\nexport const load = () => import('@/app/_ui/zz-lazy.js')\n" }))).toEqual([
      "app/_ui/zz-loader.ts:2 import('@/app/_ui/zz-lazy.js') 解析不到檔案",
    ])
  })

  it('新的延遲入口自動納入（不用另外登記）', () => {
    const loader = 'app/_ui/zz-loader.ts'
    const lazy = 'app/_ui/zz-lazy.tsx'
    const v = violations(
      new Sources({
        [loader]: "export const load = () => import('@/app/_ui/zz-lazy')\n",
        [lazy]: "import { buttonVariants } from '@/app/_ui/ui/button'\nexport const x = buttonVariants\n",
      }),
    )
    expect(Object.keys(v)).toEqual([lazy])
  })
})
