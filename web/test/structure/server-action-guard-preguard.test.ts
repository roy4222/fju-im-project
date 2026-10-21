import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { UC } from './server-action-guard-usecases'

/**
 * SEC-2 補強（CL-7C，#823）：守門之前不准「發出」查詢，有沒有 await 都一樣。
 *
 * `server-action-guard.test.ts` 只擋守門前的 await 與 `this.方法()`；`const p = this.#pool.query(…)`、
 * `void this.deps.pool.query(…)`、`getPool().query(…)` 不 await 就溜過去了——查詢已經送出，守門再擋也來不及。
 *
 * ② 用例端：登記表（`server-action-guard-usecases.ts`）每個用例方法，從第一句走到第一個守門呼叫；途中任何呼叫
 *   - 以 `this.欄位.…` 開頭（`this.#pool.query()`、`this.deps.x()`），或直接呼叫不是方法的 `this.#欄位()`；
 *   - 以 DB 物件開頭（`pool`、`getPool()`、`tx`、`db`、`client`）
 *   都算違規。`this.#私有方法()` 照舊往內追兩層。只看方法本身，不進 callback（callback 是守門後才跑）。
 * ① action 端：`'use server'` 檔裡的函式，在取身分（`currentActor()`、`frontEditActor()`、`resolveActor()`、`headers()`）
 *   那一句之前，不准呼叫 `@/composition/**` 來的 port 方法（`getX().method()`，或 `const c = getX()` 之後 `c.method()`）。
 *   只取 port（`getX()`）、呼叫純函式（`parseInboxFilter`、`isRegistrationOpen`）不算。沒有取身分的（公開流程）不在這裡管。
 */

const srcRoot = path.resolve(import.meta.dirname, '../../src')
const DB_ROOTS = new Set(['pool', 'getPool', 'tx', 'db', 'client'])
const IDENTITY = new Set(['currentActor', 'frontEditActor', 'resolveActor', 'headers'])

class Sources {
  #cache = new Map<string, ts.SourceFile>()
  readonly files: string[]
  constructor(private readonly overrides: Record<string, string> = {}) {
    const out: string[] = []
    const visit = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) visit(p)
        else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(path.relative(srcRoot, p))
      }
    }
    visit(srcRoot)
    this.files = out.sort()
  }
  read(file: string) {
    let sf = this.#cache.get(file)
    if (!sf) {
      const text = this.overrides[file] ?? readFileSync(path.join(srcRoot, file), 'utf8')
      sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
      this.#cache.set(file, sf)
    }
    return sf
  }
  findClass(name: string) {
    for (const file of this.files.filter((f) => f.startsWith('infrastructure/'))) {
      const cls = this.read(file).statements.find((s): s is ts.ClassDeclaration => ts.isClassDeclaration(s) && s.name?.text === name)
      if (cls) return { file, cls }
    }
    return null
  }
}

const isFunctionLike = (n: ts.Node) => ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)

/** 走子節點但不進 callback。 */
function calls(node: ts.Node): ts.CallExpression[] {
  const out: ts.CallExpression[] = []
  const visit = (n: ts.Node) => {
    if (n !== node && isFunctionLike(n)) return
    if (ts.isCallExpression(n)) out.push(n)
    ts.forEachChild(n, visit)
  }
  visit(node)
  return out
}

function rootOf(e: ts.Expression): ts.Expression {
  while (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) || ts.isCallExpression(e) || ts.isNonNullExpression(e) || ts.isParenthesizedExpression(e)) {
    e = e.expression
  }
  return e
}

const lineOf = (n: ts.Node) => n.getSourceFile().getLineAndCharacterOfPosition(n.getStart()).line + 1
const short = (n: ts.Node) => n.getText().replace(/\s+/g, ' ').slice(0, 80)

function methodOf(cls: ts.ClassDeclaration, name: string) {
  return cls.members.find((m): m is ts.MethodDeclaration => ts.isMethodDeclaration(m) && m.name.getText() === name && !!m.body)
}

/** ② 用例方法：守門前的呼叫有沒有以 this 欄位或 DB 物件開頭。回問題或 null。 */
function preGuard(file: string, cls: ts.ClassDeclaration, method: string, guard: string, hops = 2): string | null {
  const member = methodOf(cls, method)
  if (!member?.body) return null // 找不到方法由 server-action-guard.test.ts 報
  const where = (n: ts.Node) => `${cls.name?.text}.${method}（${file}:${lineOf(n)}）`
  const isGuardCall = (n: ts.Node | undefined) => !!n && ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === guard
  for (const s of member.body.statements) {
    let hop: string | null = null
    for (const c of calls(s)) {
      if (isGuardCall(c)) return null
      const callee = c.expression
      if (ts.isPropertyAccessExpression(callee) && callee.expression.kind === ts.SyntaxKind.ThisKeyword) {
        const name = callee.name.getText()
        if (methodOf(cls, name)) {
          hop ??= name
          continue
        }
        return `${where(c)} 守門前呼叫 this 欄位：${short(c)}`
      }
      const root = rootOf(callee)
      if (root.kind === ts.SyntaxKind.ThisKeyword) return `${where(c)} 守門前經 this 欄位發出呼叫：${short(c)}`
      if (ts.isIdentifier(root) && DB_ROOTS.has(root.text)) return `${where(c)} 守門前碰 DB 物件 ${root.text}：${short(c)}`
    }
    if (hop) return hops > 0 ? preGuard(file, cls, hop, guard, hops - 1) : null
  }
  return null
}

function useCaseViolations(sources: Sources) {
  const problems: string[] = []
  for (const [use, { cls, guard }] of Object.entries(UC)) {
    const found = sources.findClass(cls)
    if (!found) continue // 找不到類別由 server-action-guard.test.ts 報
    const problem = preGuard(found.file, found.cls, use.split('.').pop()!, guard)
    if (problem && !problems.includes(problem)) problems.push(problem)
  }
  return problems
}

/** ① action 端：取身分之前呼叫 composition。 */
function actionViolations(sources: Sources) {
  const problems: string[] = []
  for (const file of sources.files.filter((f) => f.startsWith('app/'))) {
    const sf = sources.read(file)
    const first = sf.statements[0]
    if (!first || !ts.isExpressionStatement(first) || !ts.isStringLiteral(first.expression) || first.expression.text !== 'use server') continue
    const composition = new Set<string>()
    for (const s of sf.statements) {
      if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier) || !s.moduleSpecifier.text.startsWith('@/composition')) continue
      const named = s.importClause?.namedBindings
      if (s.importClause?.name) composition.add(s.importClause.name.text)
      if (named && ts.isNamedImports(named)) for (const e of named.elements) composition.add(e.name.text)
      if (named && ts.isNamespaceImport(named)) composition.add(named.name.text)
    }
    const bodies: [string, ts.Block][] = []
    for (const s of sf.statements) {
      if (ts.isFunctionDeclaration(s) && s.body && s.name) bodies.push([s.name.text, s.body])
      if (ts.isVariableStatement(s)) {
        for (const d of s.declarationList.declarations) {
          if (d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)) && ts.isBlock(d.initializer.body)) {
            bodies.push([d.name.getText(), d.initializer.body])
          }
        }
      }
    }
    for (const [name, body] of bodies) {
      // 綁定 composition 回傳值的區域變數（`const command = getX()`）也算 port。
      const ports = new Set(composition)
      const bind = (n: ts.Node) => {
        if (n !== body && isFunctionLike(n)) return
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
          const root = rootOf(n.initializer)
          if (ts.isIdentifier(root) && composition.has(root.text)) ports.add(n.name.text)
        }
        ts.forEachChild(n, bind)
      }
      bind(body)
      const identityAt = body.statements.findIndex((s) => calls(s).some((c) => ts.isIdentifier(c.expression) && IDENTITY.has(c.expression.text)))
      if (identityAt < 0) continue
      for (const s of body.statements.slice(0, identityAt)) {
        const bad = calls(s).find((c) => {
          if (!ts.isPropertyAccessExpression(c.expression) && !ts.isElementAccessExpression(c.expression)) return false
          const root = rootOf(c.expression)
          return ts.isIdentifier(root) && ports.has(root.text)
        })
        if (bad) problems.push(`${file}:${lineOf(bad)} ${name} 取身分前呼叫 composition：${short(bad)}`)
      }
    }
  }
  return problems
}

const sources = new Sources()

function insertBefore(file: string, anchor: string, line: string, after = 0) {
  const text = readFileSync(path.join(srcRoot, file), 'utf8')
  const at = text.indexOf(anchor, after)
  if (at < 0) throw new Error(`變造失敗：${file} 找不到 ${anchor}`)
  return new Sources({ [file]: text.slice(0, at) + line + text.slice(at) })
}

describe('SEC-2 補強：守門前不准發出查詢（含沒 await）', () => {
  it('登記表的用例方法，守門前沒有以 this 欄位或 DB 物件開頭的呼叫', () => {
    expect(useCaseViolations(sources)).toEqual([])
  })

  it("'use server' 檔的函式，取身分之前沒有呼叫 composition", () => {
    expect(actionViolations(sources)).toEqual([])
  })
})

describe('SEC-2 補強：變造就紅', () => {
  const file = 'infrastructure/cohorts/pg-cohorts.ts'
  const activate = readFileSync(path.join(srcRoot, file), 'utf8').indexOf('  async activate(')
  const anchor = 'const denied = authorizeAdmin('

  it.each([
    ['this.pool.query()，沒 await', "const leak = this.pool.query('select 1')", '守門前經 this 欄位發出呼叫'],
    ['this.deps.pool.query()，void 前綴', "void this.deps.pool.query('select 1')", '守門前經 this 欄位發出呼叫'],
    ['直接呼叫 this 欄位（不是方法）', 'const db = this.#pool()', '守門前呼叫 this 欄位'],
    ['getPool() 的查詢，沒 await', "const leak = getPool().query('select 1')", '守門前碰 DB 物件 getPool'],
  ])('② PgCohortCommand.activate 守門前插入：%s', (_name, line, message) => {
    const problems = useCaseViolations(insertBefore(file, anchor, `${line}\n    `, activate))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('PgCohortCommand.activate（infrastructure/cohorts/pg-cohorts.ts:')
    expect(problems[0]).toContain(message)
  })

  it('② 守門後才發的查詢、callback 裡的查詢不算', () => {
    const after = 'if (denied) return denied\n'
    const text = readFileSync(path.join(srcRoot, file), 'utf8')
    const at = text.indexOf(after, activate) + after.length
    const mutated = new Sources({ [file]: `${text.slice(0, at)}    void getPool().query('select 1')\n${text.slice(at)}` })
    expect(useCaseViolations(mutated)).toEqual([])
    expect(useCaseViolations(insertBefore(file, anchor, "const later = () => getPool().query('select 1')\n    ", activate))).toEqual([])
  })

  it('① action 取身分前先發 Query（沒 await）', () => {
    const action = 'app/dashboard/admin/timeline/actions.ts'
    const text = readFileSync(path.join(srcRoot, action), 'utf8')
    const fn = text.indexOf('export async function saveStageDatesAction(')
    const at = text.indexOf('const actor = await currentActor()', fn)
    const mutated = new Sources({ [action]: `${text.slice(0, at)}void getTimelineQuery().schedule(cohortId)\n  ${text.slice(at)}` })
    const problems = actionViolations(mutated)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/^app\/dashboard\/admin\/timeline\/actions\.ts:\d+ saveStageDatesAction 取身分前呼叫 composition：getTimelineQuery\(\)/)
  })

  it('① 先取 port 再呼叫方法（`const command = getX()` 後 `command.m()`）也抓；只取 port 不算', () => {
    const action = 'app/dashboard/admin/signoff/actions.ts'
    const text = readFileSync(path.join(srcRoot, action), 'utf8')
    const fn = text.indexOf('export async function restartAction(')
    const at = text.indexOf('const actor = await currentActor()', fn)
    const mutated = new Sources({ [action]: `${text.slice(0, at)}const early = command.reset({ kind: 'anonymous' } as never, {} as never, '')\n  ${text.slice(at)}` })
    expect(actionViolations(mutated)).toEqual([expect.stringContaining('restartAction 取身分前呼叫 composition：command.reset(')])
    expect(actionViolations(sources)).toEqual([])
  })
})
