import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * RV-A（#813，SEC-2 延伸）：`src/app/**` 底下每個 `route.ts` export 的 HTTP 方法，都要在碰用例或資料之前過守門。
 *
 * 每個方法逐一登記成三類之一（沒登記的新 route、登記了卻已不存在的都會紅）：
 * ① `self`：route 自己守門——第一個 await 是 `resolveActor(request.headers)`，接著登記的守門函式並緊接 `if (...) return`。
 * ② `useCase`：交給門面／用例守門——route 第一個 composition 呼叫必須是登記的門面，第一個參數是 `request.headers`；
 *    門面之前只准讀請求本身（`await params`、`await request.text()` 之類）。門面第一句必須是
 *    `const actor = await resolveActor(headers)`，之後二選一：
 *    - 門面自己守門（`guard`）：守門前沒有別的 await 或 composition getter 呼叫；
 *    - 交給用例（`use`＋`cls`＋`guard`）：門面第一個 getter 呼叫就是登記的用例方法、身分參數就是那個 actor；
 *      用例方法守門前不能有 await 或 `this` 的方法呼叫（可往內追兩層），守門緊接 `if (...) return`。
 *    守門函式本身必須在讀資料前呼叫 `statusGate`（可追三層；`checkStatus` 是它的別名）。
 * ③ `allow`：明確白名單＋理由（健康檢查、Better Auth 自己的入口）。
 *
 * ①② 的 POST／PUT／PATCH／DELETE 第一句還必須是 `if (!isSameOriginRequest(request.headers, ...)) return`（契約 03 §6）。
 * 規則比照 `server-action-guard.test.ts`：只接受可直接核對的寫法；新的寫法要連同反例一起擴充，不要放寬既有規則。
 */

const srcRoot = path.resolve(import.meta.dirname, '../../src')
const appDir = 'app'
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

type Entry =
  | { kind: 'self'; guard: string }
  | { kind: 'useCase'; facade: string; guard: string; use?: string; cls?: string; anonymous?: string }
  | { kind: 'allow'; reason: string }

// ── 登記表 ──────────────────────────────────────────────────────────────────
// key＝`<app 底下的路徑>#<方法>`。
const REGISTRY: Record<string, Entry> = {
  'api/admin/accounts/export/route.ts#POST': { kind: 'useCase', facade: 'exportAccounts', guard: 'accountAdminDenied' },
  'api/admin/grading/export/route.ts#POST': {
    kind: 'useCase', facade: 'exportGrades', use: 'getGradeExporter().exportGrades', cls: 'PgGradeExporter', guard: 'authorizeAdmin',
  },
  'api/admin/groups/export/route.ts#POST': {
    kind: 'useCase', facade: 'exportGroupRoster', use: 'getGroupRosterExporter().exportRoster', cls: 'PgGroupRosterExporter', guard: 'authorizeAdmin',
  },
  'api/admin/signoff/[versionId]/export/route.ts#POST': {
    kind: 'useCase', facade: 'exportSignoffVersion', use: 'getSignoffCommand().exportVersion', cls: 'PgSignoffCommand', guard: 'authorizeAdmin',
  },
  'api/files/[id]/route.ts#GET': {
    kind: 'useCase', facade: 'downloadFile', use: 'getFileStorage().authorizeDownload', cls: 'FsFileStorage', guard: 'statusGate',
    anonymous: '訪客照樣走下載政策：只有政策明說訪客可讀的公開附件放行，其他一律 401（票 16）',
  },
  'api/files/[id]/preview/route.ts#GET': {
    kind: 'useCase', facade: 'downloadFile', use: 'getFileStorage().authorizeDownload', cls: 'FsFileStorage', guard: 'statusGate',
    anonymous: '與下載同一個 downloadFile，權限完全相同（A-06）',
  },
  'api/files/upload/route.ts#POST': { kind: 'useCase', facade: 'uploadFile', guard: 'checkStatus' },
  'api/auth/[...all]/route.ts#GET': {
    kind: 'allow', reason: 'Better Auth 入口：路徑白名單與兩層攔截在 infrastructure/auth/wrapper.ts＋route-matrix.ts（其餘 403），由 auth 自己的測試鎖住',
  },
  'api/auth/[...all]/route.ts#POST': {
    kind: 'allow', reason: 'Better Auth 入口：同 GET；來源檢查由 Better Auth 的 trustedOrigins 負責，登入、註冊本來就不需登入',
  },
  'api/health/route.ts#GET': {
    kind: 'allow', reason: '健康檢查給監測用，不需登入；只回 ok／version／commit／imageDigest／schemaVersion／worker，沒有個資（shared/health.ts）',
  },
}

// ── 原始碼讀取 ──────────────────────────────────────────────────────────────
type ImportRef = { module: string; name: string }
type Fn = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression
type Handler = { file: string; method: string; fn?: Fn }

function walk(node: ts.Node, visit: (node: ts.Node) => boolean | void) {
  if (visit(node) === false) return
  ts.forEachChild(node, (child) => walk(child, visit))
}
function exported(node: ts.Node) {
  return ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
}
const isRouteFile = (f: string) => /(^|\/)route\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f)

class Sources {
  private cache = new Map<string, ts.SourceFile>()
  constructor(readonly overrides: Record<string, string> = {}) {}
  has(file: string) {
    return file in this.overrides || existsSync(path.join(srcRoot, file))
  }
  read(file: string) {
    if (!this.cache.has(file)) {
      const text = this.overrides[file] ?? readFileSync(path.join(srcRoot, file), 'utf8')
      this.cache.set(file, ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true))
    }
    return this.cache.get(file)!
  }
  resolve(from: string, module: string): string | null {
    const base = module.startsWith('@/') ? module.slice(2) : module.startsWith('.') ? path.join(path.dirname(from), module) : null
    if (!base) return null
    return [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, base].find((f) => /\.tsx?$/.test(f) && this.has(f)) ?? null
  }
  imports(file: string) {
    const refs = new Map<string, ImportRef>()
    for (const s of this.read(file).statements) {
      if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier)) continue
      const clause = s.importClause
      if (!clause || clause.isTypeOnly) continue
      const bindings = clause.namedBindings
      if (bindings && ts.isNamedImports(bindings)) for (const e of bindings.elements) {
        if (!e.isTypeOnly) refs.set(e.name.text, { module: s.moduleSpecifier.text, name: (e.propertyName ?? e.name).text })
      }
    }
    return refs
  }
  /** 這個名字在檔內宣告的函式，或沿 import／re-export（含 `as` 別名）找到的函式宣告；`name` 是宣告處的名字。 */
  findFunction(file: string, name: string, depth = 0): { file: string; name: string; fn: Fn } | null {
    if (depth > 4) return null
    const source = this.read(file)
    for (const s of source.statements) {
      if (ts.isFunctionDeclaration(s) && s.name?.text === name && s.body) return { file, name, fn: s }
      if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer && ts.isArrowFunction(d.initializer)) return { file, name, fn: d.initializer }
      }
    }
    const ref = this.imports(file).get(name)
    if (ref) {
      const target = this.resolve(file, ref.module)
      return target ? this.findFunction(target, ref.name, depth + 1) : null
    }
    for (const s of source.statements) {
      if (!ts.isExportDeclaration(s) || s.isTypeOnly || !s.moduleSpecifier || !ts.isStringLiteral(s.moduleSpecifier)) continue
      const target = this.resolve(file, s.moduleSpecifier.text)
      if (!target) continue
      if (!s.exportClause) {
        const found = this.findFunction(target, name, depth + 1)
        if (found) return found
      } else if (ts.isNamedExports(s.exportClause)) {
        const entry = s.exportClause.elements.find((e) => e.name.text === name)
        if (entry) return this.findFunction(target, (entry.propertyName ?? entry.name).text, depth + 1)
      }
    }
    return null
  }
  private classIndex?: Map<string, { file: string; cls: ts.ClassDeclaration }>
  findClass(name: string) {
    if (!this.classIndex) {
      this.classIndex = new Map()
      for (const rel of readdirSync(path.join(srcRoot, 'infrastructure'), { recursive: true, encoding: 'utf8' })) {
        if (!/\.ts$/.test(rel) || /\.test\.ts$/.test(rel)) continue
        const file = path.join('infrastructure', rel)
        for (const s of this.read(file).statements) if (ts.isClassDeclaration(s) && s.name) this.classIndex.set(s.name.text, { file, cls: s })
      }
    }
    return this.classIndex.get(name) ?? null
  }

  /** route 檔 export 的 HTTP 方法；不認得的寫法（解構、re-export）也列出來但沒有本體，只能走白名單。 */
  handlers(file: string): Handler[] {
    const rel = path.relative(appDir, file)
    const found: Handler[] = []
    for (const s of this.read(file).statements) {
      if (ts.isExportDeclaration(s) && !s.isTypeOnly && s.exportClause && ts.isNamedExports(s.exportClause)) {
        for (const e of s.exportClause.elements) if (METHODS.has(e.name.text)) found.push({ file: rel, method: e.name.text })
      } else if (ts.isFunctionDeclaration(s) && exported(s) && s.name && METHODS.has(s.name.text) && s.body) {
        found.push({ file: rel, method: s.name.text, fn: s })
      } else if (ts.isVariableStatement(s) && exported(s)) {
        for (const d of s.declarationList.declarations) {
          const names = ts.isIdentifier(d.name) ? [d.name.text] : d.name.elements.flatMap((e) => (ts.isBindingElement(e) ? [e.name.getText()] : []))
          const v = d.initializer
          const fn = ts.isIdentifier(d.name) && v && (ts.isArrowFunction(v) || ts.isFunctionExpression(v)) ? v : undefined
          for (const n of names) if (METHODS.has(n)) found.push({ file: rel, method: n, fn })
        }
      }
    }
    return found
  }
}

function discover(sources: Sources): Handler[] {
  const files = new Set(
    readdirSync(path.join(srcRoot, appDir), { recursive: true, encoding: 'utf8' }).filter(isRouteFile).map((f) => path.join(appDir, f)),
  )
  for (const f of Object.keys(sources.overrides)) if (f.startsWith(`${appDir}/`) && isRouteFile(f)) files.add(f)
  return [...files].sort().flatMap((f) => sources.handlers(f))
}

const key = (h: { file: string; method: string }) => `${h.file}#${h.method}`

// ── 檢查 ────────────────────────────────────────────────────────────────────
function singleBinding(statement: ts.Statement | undefined) {
  if (!statement || !ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) return null
  const d = statement.declarationList.declarations[0]!
  return ts.isIdentifier(d.name) ? { name: d.name.text, value: d.initializer } : null
}
const lastStatement = (s: ts.Statement) => (ts.isBlock(s) ? s.statements.at(-1) : s)
const returnsEarly = (s: ts.Statement | undefined) => !!s && ts.isIfStatement(s) && !!lastStatement(s.thenStatement) && ts.isReturnStatement(lastStatement(s.thenStatement)!)
const callName = (n: ts.Node | undefined) => (n && ts.isCallExpression(n) && ts.isIdentifier(n.expression) ? n.expression.text : null)
const hasAwait = (n: ts.Node) => {
  let found = false
  walk(n, (c) => {
    if (ts.isAwaitExpression(c)) found = true
  })
  return found
}

/** 這個函式在讀資料前呼叫 `statusGate`（或另一個這樣的守門；最多三層）。 */
function isGuardFunction(sources: Sources, file: string, name: string, depth = 0): boolean {
  if (name === 'statusGate') return true
  if (depth > 3) return false
  const found = sources.findFunction(file, name)
  if (!found) return false
  if (found.name === 'statusGate') return true
  if (!found.fn.body || !ts.isBlock(found.fn.body)) return false
  for (const s of found.fn.body.statements) {
    let hit = false
    walk(s, (n) => {
      const called = callName(n)
      if (called && isGuardFunction(sources, found.file, called, depth + 1)) hit = true
    })
    if (hit) return true
    if (hasAwait(s)) return false
  }
  return false
}

/** `statements[i]` 是守門：`const x = guard(...)` 緊接 `if (...x...) return`，或 `if (guard(...)) return`（可加 `!`）。 */
function guardAt(statements: readonly ts.Statement[], i: number, guard: string): 'ok' | 'loose' | null {
  const s = statements[i]!
  const bound = singleBinding(s)
  if (bound && callName(bound.value) === guard) {
    const next = statements[i + 1]
    return returnsEarly(next) && (next as ts.IfStatement).expression.getText().includes(bound.name) ? 'ok' : 'loose'
  }
  if (ts.isIfStatement(s)) {
    const cond = ts.isPrefixUnaryExpression(s.expression) ? s.expression.operand : s.expression
    if (callName(cond) === guard) return returnsEarly(s) ? 'ok' : 'loose'
  }
  return null
}

function callsThis(n: ts.Node): ts.CallExpression | null {
  let found: ts.CallExpression | null = null
  walk(n, (c) => {
    if (found) return false
    if (ts.isCallExpression(c) && ts.isPropertyAccessExpression(c.expression) && c.expression.expression.kind === ts.SyntaxKind.ThisKeyword) found = c
  })
  return found
}

/** 用例方法：守門前沒有 await／this 方法呼叫；第一個守門是登記的函式並緊接 if 早退（可追兩層 this 方法）。 */
function useCaseGuarded(sources: Sources, file: string, cls: ts.ClassDeclaration, method: string, guard: string, nested: boolean, hops = 2): string | null {
  const member = cls.members.find((m): m is ts.MethodDeclaration => ts.isMethodDeclaration(m) && m.name.getText() === method && !!m.body)
  if (!member?.body) return `${cls.name?.text}.${method} 找不到`
  const where = `${cls.name?.text}.${method}`
  const statements = member.body.statements
  for (let i = 0; i < statements.length; i++) {
    const s = statements[i]!
    let shape = guardAt(statements, i, guard)
    // 訪客另走政策的用例：守門可以包在一層 `if (...) { ... }` 裡（登記時要寫 anonymous 理由）。
    if (!shape && nested && ts.isIfStatement(s) && ts.isBlock(s.thenStatement) && !hasAwait(s.expression)) {
      const inner = s.thenStatement.statements
      for (let j = 0; j < inner.length && !shape; j++) {
        shape = guardAt(inner, j, guard)
        if (!shape && (hasAwait(inner[j]!) || callsThis(inner[j]!))) break
      }
    }
    if (shape === 'loose') return `${where} 呼叫 ${guard} 後沒有立刻 if 早退`
    if (shape === 'ok') return isGuardFunction(sources, file, guard) ? null : `${guard} 沒有在讀資料前呼叫 statusGate`
    const hop = callsThis(s)
    if (hop) {
      const name = (hop.expression as ts.PropertyAccessExpression).name.getText()
      if (hops > 0) return useCaseGuarded(sources, file, cls, name, guard, nested, hops - 1)
      return `${where} 在守門前呼叫 this.${name}`
    }
    if (hasAwait(s)) return `${where} 在守門前有 await：${s.getText().slice(0, 80)}`
  }
  return `${where} 沒有呼叫 ${guard}`
}

/** `getX().method(...)` 的寫法，回傳 `getX().method`；其他 composition getter 呼叫回傳 `getX()`。 */
function getterCall(n: ts.Node): string | null {
  if (!ts.isCallExpression(n)) return null
  const callee = n.expression
  if (ts.isPropertyAccessExpression(callee) && ts.isCallExpression(callee.expression)) {
    const getter = callName(callee.expression)
    if (getter && /^get[A-Z]/.test(getter)) return `${getter}().${callee.name.text}`
  }
  const name = callName(n)
  return name && /^get[A-Z]/.test(name) ? `${name}()` : null
}

/**
 * 從認人開始的函式本體（route 自己守門、或門面）：第一句 `const actor = await resolveActor(<headers>)`，
 * 之後在任何其他 await／composition getter 呼叫之前，先過登記的守門，或第一個 getter 呼叫就是登記的用例。
 */
function guardedBody(sources: Sources, file: string, statements: readonly ts.Statement[], headers: string, entry: { guard: string; use?: string; cls?: string; anonymous?: string }): string | null {
  const [first, ...rest] = statements
  const actor = singleBinding(first)
  const call = actor?.value && ts.isAwaitExpression(actor.value) ? actor.value.expression : undefined
  const resolver = callName(call) ? sources.findFunction(file, callName(call)!) : null
  if (!actor || !call || !ts.isCallExpression(call) || resolver?.file !== 'composition/accounts.ts' || resolver.name !== 'resolveActor'
    || call.arguments.length !== 1 || call.arguments[0]!.getText() !== headers) {
    return `第一句不是 const actor = await resolveActor(${headers})`
  }
  for (let i = 0; i < rest.length; i++) {
    const s = rest[i]!
    if (!entry.use) {
      const shape = guardAt(rest, i, entry.guard)
      if (shape === 'loose') return `呼叫 ${entry.guard} 後沒有立刻 if 早退`
      if (shape === 'ok') return isGuardFunction(sources, file, entry.guard) ? null : `${entry.guard} 沒有在讀資料前呼叫 statusGate`
    }
    let port: { use: string; node: ts.CallExpression } | null = null
    walk(s, (n) => {
      if (port) return false
      const use = getterCall(n)
      if (use) port = { use, node: n as ts.CallExpression }
    })
    const found = port as { use: string; node: ts.CallExpression } | null
    if (found && entry.use && found.use === entry.use) {
      if (found.node.arguments[0]?.getText() !== actor.name) return `${entry.use} 的身分參數不是 ${actor.name}`
      const getter = sources.findFunction(file, entry.use.split('()')[0]!)
      if (!getter || !sources.read(getter.file).text.includes(`new ${entry.cls}(`)) return `${entry.use.split('()')[0]} 沒有建立 ${entry.cls}`
      const impl = sources.findClass(entry.cls!)
      if (!impl) return `找不到類別 ${entry.cls}`
      return useCaseGuarded(sources, impl.file, impl.cls, entry.use.split('.').pop()!, entry.guard, !!entry.anonymous)
    }
    if (found) return `在守門前呼叫沒登記的 ${found.use}`
    if (hasAwait(s)) return `在守門前有 await：${s.getText().slice(0, 80)}`
  }
  return entry.use ? `沒有呼叫 ${entry.use}` : `沒有呼叫 ${entry.guard}`
}

/** route 方法：（非安全方法）先同源檢查，再交給門面或自己守門。 */
function handlerGuarded(sources: Sources, handler: Handler, entry: Exclude<Entry, { kind: 'allow' }>): string | null {
  const fn = handler.fn
  if (!fn?.body || !ts.isBlock(fn.body)) return '不是有本體的函式（解構或 re-export 只能登記白名單）'
  const file = path.join(appDir, handler.file)
  const refs = sources.imports(file)
  const req = fn.parameters[0]?.name.getText()
  if (!req) return '沒有 request 參數'
  let statements: readonly ts.Statement[] = fn.body.statements
  if (!SAFE_METHODS.has(handler.method)) {
    const first = statements[0]
    const cond = first && ts.isIfStatement(first) && ts.isPrefixUnaryExpression(first.expression)
      && first.expression.operator === ts.SyntaxKind.ExclamationToken ? first.expression.operand : undefined
    const ref = refs.get(callName(cond) ?? '')
    if (!cond || !ts.isCallExpression(cond) || ref?.module !== '@/shared/same-origin' || ref.name !== 'isSameOriginRequest'
      || cond.arguments[0]?.getText() !== `${req}.headers` || !returnsEarly(first)) {
      return `第一句不是 if (!isSameOriginRequest(${req}.headers, ...)) return`
    }
    statements = statements.slice(1)
  }
  if (entry.kind === 'self') return guardedBody(sources, file, statements, `${req}.headers`, entry)

  // ② 門面之前只准讀請求本身；第一個 composition 呼叫必須是登記的門面。
  let problem: string | null = null
  let facadeCall: ts.CallExpression | null = null
  for (const s of statements) {
    walk(s, (n) => {
      if (problem || facadeCall) return false
      if (ts.isAwaitExpression(n) && !ts.isCallExpression(n.expression) && n.expression.getText() !== 'params') {
        problem = `在門面前 await 了 ${n.expression.getText().slice(0, 60)}`
      } else if (ts.isAwaitExpression(n) && ts.isCallExpression(n.expression) && callName(n.expression) === null
        && !n.expression.expression.getText().startsWith(`${req}.`)) {
        problem = `在門面前 await 了 ${n.expression.getText().slice(0, 60)}`
      } else if (ts.isCallExpression(n) && callName(n)) {
        const ref = refs.get(callName(n)!)
        if (ref?.module.startsWith('@/composition/')) {
          if (ref.name === entry.facade) facadeCall = n
          else problem = `在門面前先呼叫 composition 的 ${ref.name}`
        } else if (n.parent && ts.isAwaitExpression(n.parent)) problem = `在門面前 await 了 ${n.getText().slice(0, 60)}`
      }
    })
    if (problem || facadeCall) break
  }
  if (problem) return problem
  const call = facadeCall as ts.CallExpression | null
  if (!call) return `沒有呼叫門面 ${entry.facade}`
  if (call.arguments[0]?.getText() !== `${req}.headers`) return `${entry.facade} 的第一個參數不是 ${req}.headers`
  const facade = sources.findFunction(file, callName(call)!)
  if (!facade?.fn.body || !ts.isBlock(facade.fn.body)) return `找不到門面 ${entry.facade}`
  const headers = facade.fn.parameters[0]?.name.getText() ?? ''
  const inner = guardedBody(sources, facade.file, facade.fn.body.statements, headers, entry)
  return inner && `${entry.facade}：${inner}`
}

function violations(sources: Sources, registry: Record<string, Entry> = REGISTRY): Record<string, string> {
  const problems: Record<string, string> = {}
  const checked = new Set<string>()
  for (const handler of discover(sources)) {
    const k = key(handler)
    checked.add(k)
    const entry = registry[k]
    let problem: string | null
    if (!entry) problem = '沒有登記守門（新 route 請登記在本測試頂端）'
    else if (entry.kind === 'allow') problem = entry.reason.trim().length < 10 ? '白名單沒寫理由' : null
    else problem = handlerGuarded(sources, handler, entry)
    if (problem) problems[k] = problem
  }
  for (const k of Object.keys(registry)) if (!checked.has(k)) problems[k] = '登記了但已經沒有這個 route 方法'
  return problems
}

// ── 測試 ────────────────────────────────────────────────────────────────────
const sources = new Sources()
const handlers = discover(sources)
let baseline: Record<string, string> | undefined
const current = () => (baseline ??= violations(sources))

function mutate(file: string, from: string | RegExp, to: string): Sources {
  const text = sources.read(file).text
  const next = text.replace(from, to)
  if (next === text) throw new Error(`變造失敗：${file} 找不到 ${from}`)
  return new Sources({ [file]: next })
}
const route = (file: string) => path.join(appDir, file)

describe('RV-A：每個 route handler 都經守門', () => {
  it('盤點：src/app 的 route.ts 共 9 個檔、10 個方法，全部登記', () => {
    expect(new Set(handlers.map((h) => h.file)).size).toBe(9)
    expect(handlers.map(key).sort()).toEqual(Object.keys(REGISTRY).sort())
  })

  it('沒有任何 route 缺守門、守門在讀寫之後或登記過期', () => {
    expect(current()).toEqual({})
  })

  it.each(handlers.map((h) => [key(h), REGISTRY[key(h)]?.kind ?? '未登記'] as const))('%s（%s）', (k) => {
    expect(current()[k]).toBeUndefined()
  })
})

describe('RV-A：拿掉守門就紅（抽樣變造）', () => {
  it('帳號匯出 POST 拿掉同源檢查', () => {
    const file = route('api/admin/accounts/export/route.ts')
    const text = sources.read(file).text
    const from = text.indexOf('  if (!isSameOriginRequest(')
    const to = text.indexOf('  }\n', from) + 4
    const mutated = new Sources({ [file]: text.slice(0, from) + text.slice(to) })
    expect(violations(mutated)).toEqual({ 'api/admin/accounts/export/route.ts#POST': expect.stringContaining('isSameOriginRequest') })
  })

  it('上傳門面 uploadFile 拿掉 checkStatus 早退（只剩「是不是訪客」）', () => {
    const mutated = mutate('composition/files.ts', / {2}const blocked = checkStatus\(actor, 'business'\)\n {2}if \(blocked\) return [^\n]*\n/, '')
    expect(violations(mutated)).toEqual({ 'api/files/upload/route.ts#POST': 'uploadFile：在守門前呼叫沒登記的 getFileStorage().upload' })
  })

  it('成績匯出用例 PgGradeExporter.exportGrades 拿掉 authorizeAdmin（門面只剩角色檢查也要抓到）', () => {
    const file = 'infrastructure/grading/pg-grade-export.ts'
    const mutated = mutate(file, "const denied = authorizeAdmin(actor, '匯出成績')", "const denied = actor.kind === 'anonymous' ? err('UNAUTHENTICATED', '') : null")
    expect(violations(mutated)).toEqual({ 'api/admin/grading/export/route.ts#POST': expect.stringContaining('PgGradeExporter.exportGrades 在守門前有 await') })
  })

  it('下載用例 authorizeDownload 拿掉 statusGate：下載與預覽兩條都紅', () => {
    const mutated = mutate('infrastructure/ops/file-storage.ts', "const blocked = statusGate(actor, 'business')", 'const blocked = null as string | null')
    expect(Object.keys(violations(mutated)).sort()).toEqual(['api/files/[id]/preview/route.ts#GET', 'api/files/[id]/route.ts#GET'])
  })

  it('簽核匯出門面在用例前先讀別的 composition', () => {
    const file = 'composition/signoff-export.ts'
    const mutated = mutate(file, '  return getSignoffCommand().exportVersion(', '  await getSignoffQuery().list(actor)\n  return getSignoffCommand().exportVersion(')
    expect(violations(mutated)).toEqual({ 'api/admin/signoff/[versionId]/export/route.ts#POST': expect.stringContaining('沒登記的 getSignoffQuery().list') })
  })

  it('門面的身分不是來自這次請求（route 自己組 headers）', () => {
    const mutated = mutate(route('api/admin/groups/export/route.ts'), 'exportGroupRoster(request.headers,', 'exportGroupRoster(new Headers(),')
    expect(violations(mutated)).toEqual({ 'api/admin/groups/export/route.ts#POST': expect.stringContaining('第一個參數不是 request.headers') })
  })

  it('白名單拿掉一筆就紅；白名單理由空白也紅', () => {
    const rest = Object.fromEntries(Object.entries(REGISTRY).filter(([k]) => k !== 'api/health/route.ts#GET'))
    expect(violations(sources, rest)).toEqual({ 'api/health/route.ts#GET': expect.stringContaining('沒有登記') })
    expect(violations(sources, { ...REGISTRY, 'api/health/route.ts#GET': { kind: 'allow', reason: '' } })).toEqual({
      'api/health/route.ts#GET': '白名單沒寫理由',
    })
  })

  it('新增的 route 沒登記就紅；解構 export 不能略過', () => {
    const mutated = new Sources({
      [route('api/admin/future/route.ts')]: 'export async function DELETE() { return new Response(null) }\nexport const { PATCH } = handlers\n',
    })
    expect(Object.keys(violations(mutated)).sort()).toEqual(['api/admin/future/route.ts#DELETE', 'api/admin/future/route.ts#PATCH'])
  })

  it('① route 自己守門的寫法：登記後通過，守門晚於讀資料就紅', () => {
    const file = route('api/admin/future/route.ts')
    const ok = [
      "import { checkStatus, getAccountDirectoryCommand, resolveActor } from '@/composition/accounts'",
      "import { isSameOriginRequest } from '@/shared/same-origin'",
      'export async function POST(request: Request): Promise<Response> {',
      "  if (!isSameOriginRequest(request.headers)) return new Response(null, { status: 403 })",
      '  const actor = await resolveActor(request.headers)',
      "  const blocked = checkStatus(actor, 'business')",
      '  if (blocked) return new Response(null, { status: 403 })',
      '  await getAccountDirectoryCommand().exportCsv(actor, { kind: "ids", userIds: [] })',
      '  return new Response(null)',
      '}',
    ].join('\n')
    const registry = { ...REGISTRY, 'api/admin/future/route.ts#POST': { kind: 'self', guard: 'checkStatus' } as Entry }
    expect(violations(new Sources({ [file]: ok }), registry)).toEqual({})
    const late = ok.replace("  const blocked = checkStatus(actor, 'business')\n  if (blocked) return new Response(null, { status: 403 })\n", '')
      .replace('  return new Response(null)\n', "  const blocked = checkStatus(actor, 'business')\n  if (blocked) return new Response(null, { status: 403 })\n  return new Response(null)\n")
    expect(violations(new Sources({ [file]: late }), registry)).toEqual({
      'api/admin/future/route.ts#POST': expect.stringContaining('在守門前呼叫沒登記的 getAccountDirectoryCommand().exportCsv'),
    })
  })
})
