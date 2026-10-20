import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const appRoot = path.resolve(import.meta.dirname, '../../src/app')
const registry = '_ui/front-edit/forms.ts'
const itemDeps = 'dashboard/admin/affairs/_form/item-form-dialog.tsx'
const industry = 'dashboard/_industry/front-edit/actions.ts'
const site = '_ui/front-edit/forms/actions.ts'
const context = 'dashboard/admin/affairs/front-edit-context-action.ts'
const affairs = 'dashboard/admin/affairs/actions.ts'
const showcase = 'dashboard/admin/showcase/actions.ts'
const category = 'dashboard/admin/affairs/rename-category-action.ts'
const actorModule = '@/app/_ui/front-edit/actor'

type ImportRef = { module: string; name: string }
type Action = { file: string; name: string; body?: ts.Block }
type Delegate = ImportRef & { method: string; reason: string }
const key = ({ file, name }: Action) => `${file}#${name}`

// 僅豁免這個 export 的這個用例呼叫，不豁免整檔或同名的本地函式。
// 已逐項核對 infrastructure/items/pg-items.ts、showcase/pg-showcase.ts；
// authorizeAdmin 來自 infrastructure/cohorts/shared.ts，先 statusGate(actor, 'business') 再查角色。
const itemCommand = (method: string): Delegate => ({
  module: '@/composition/items', name: 'getItemCommand', method,
  reason: `PgItemCommand.${method} 入口先 authorizeAdmin，拒絕結果由 toOutcome／action 原樣轉回。`,
})
const delegates: Record<string, Delegate> = {
  [`${affairs}#createItemAction`]: itemCommand('create'),
  [`${affairs}#saveDraftAction`]: itemCommand('saveDraft'),
  [`${affairs}#publishItemAction`]: itemCommand('publish'),
  [`${affairs}#updatePublishedAction`]: itemCommand('updatePublished'),
  [`${affairs}#changeItemStatusAction`]: itemCommand('changeStatus'),
  [`${affairs}#deleteItemAction`]: itemCommand('delete'),
  [`${affairs}#reviewItemAction`]: itemCommand('review'),
  [`${affairs}#startItemUploadAction`]: itemCommand('startUpload'),
  [`${category}#renameResourceCategoryAction`]: itemCommand('renameResourceCategory'),
  [`${showcase}#setHomePositionAction`]: {
    module: '@/composition/showcase', name: 'getShowcaseCommand', method: 'setHomePosition',
    reason: 'PgShowcaseCommand.setHomePosition 經 #change 先 authorizeAdmin；驗證錯誤分支也檢查 authorizeAdmin。',
  },
  [`${showcase}#showcaseFeStateAction`]: {
    module: '@/composition/showcase', name: 'getShowcaseQuery', method: 'adminBoard',
    reason: 'PgShowcaseQuery.adminBoard 入口先 authorizeAdmin，拒絕時不查資料。',
  },
}
const direct = [
  { file: industry, name: 'opportunityFeContextAction' },
  { file: industry, name: 'saveOpportunityFeAction' },
  { file: industry, name: 'removeOpportunityFeAction' },
  { file: site, name: 'saveSiteTextAction' },
  { file: site, name: 'saveHeroAction' },
  { file: site, name: 'requestHeroUploadAction' },
  { file: context, name: 'frontEditContextAction' },
]

function walk(node: ts.Node, visit: (node: ts.Node) => void) {
  visit(node)
  ts.forEachChild(node, (child) => walk(child, visit))
}
function serverDirective(node: ts.SourceFile | ts.Block) {
  return node.statements.some((s) => ts.isExpressionStatement(s) && ts.isStringLiteral(s.expression) && s.expression.text === 'use server')
}
function exported(node: ts.Node) {
  return ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
}

class Sources {
  private cache = new Map<string, ts.SourceFile>()
  constructor(private overrides: Record<string, string> = {}) {}
  read(file: string) {
    if (!this.cache.has(file)) this.cache.set(file, ts.createSourceFile(file,
      this.overrides[file] ?? readFileSync(path.join(appRoot, file), 'utf8'), ts.ScriptTarget.Latest, true))
    return this.cache.get(file)!
  }
  resolve(from: string, module: string) {
    const base = module.startsWith('@/app/') ? module.slice('@/app/'.length)
      : module.startsWith('.') ? path.join(path.dirname(from), module) : null
    if (!base) return null
    const file = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]
      .find((candidate) => candidate in this.overrides || /\.tsx?$/.test(candidate) && existsSync(path.join(appRoot, candidate)))
    if (!file) throw new Error(`無法追蹤前台依賴：${from} → ${module}`)
    return file
  }
  imports(file: string) {
    const refs = new Map<string, ImportRef>()
    for (const statement of this.read(file).statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
      const clause = statement.importClause
      if (!clause || clause.isTypeOnly) continue
      const module = statement.moduleSpecifier.text
      if (clause.name) refs.set(clause.name.text, { module, name: 'default' })
      const bindings = clause.namedBindings
      if (bindings && ts.isNamespaceImport(bindings)) refs.set(bindings.name.text, { module, name: '*' })
      if (bindings && ts.isNamedImports(bindings)) for (const entry of bindings.elements) {
        if (!entry.isTypeOnly) refs.set(entry.name.text, { module, name: (entry.propertyName ?? entry.name).text })
      }
    }
    return refs
  }
  actions(file: string): Action[] {
    const source = this.read(file)
    const server = serverDirective(source)
    const actions: Action[] = []
    for (const statement of source.statements) {
      if (ts.isExportDeclaration(statement)) {
        if (server && !statement.isTypeOnly) {
          if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
            for (const entry of statement.exportClause.elements) if (!entry.isTypeOnly) actions.push({ file, name: entry.name.text })
          } else actions.push({ file, name: '*' })
        }
        continue
      }
      if (ts.isExportAssignment(statement)) {
        if (server) actions.push({ file, name: 'default' })
        continue
      }
      if (!exported(statement)) continue
      if (ts.isFunctionDeclaration(statement)) {
        if (server || statement.body && serverDirective(statement.body)) actions.push({ file, name: statement.name?.text ?? 'default', body: statement.body })
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          const value = declaration.initializer
          const body = value && (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) && ts.isBlock(value.body) ? value.body : undefined
          if (server || body && serverDirective(body)) actions.push({ file, name: declaration.name.getText(), body })
        }
      } else if (server && !ts.isTypeAliasDeclaration(statement) && !ts.isInterfaceDeclaration(statement)) {
        // 新的 re-export／default 寫法尚未證明有守門時，必須失敗，不能安靜略過。
        actions.push({ file, name: statement.getText() })
      }
    }
    return actions
  }
}

/** 保留目錄規則，再從 FE_FORMS 登錄追蹤執行期依賴（包括 ITEM_FORM_DEPS 與延遲表單）。
 * 遇到 server 模組只納入被引用的 export，不把同檔未供前台使用的後台 actions 一起豁免。
 */
function discover(sources: Sources): Action[] {
  const actions = new Map<string, Action>()
  const add = (action: Action) => actions.set(key(action), action)
  for (const file of readdirSync(appRoot, { recursive: true, encoding: 'utf8' })) {
    if (/\.tsx?$/.test(file) && (file.split(path.sep).includes('front-edit') || file.endsWith('context-action.ts'))) sources.actions(file).forEach(add)
  }
  const visited = new Set<string>()
  function visit(file: string, names: string[]) {
    const exports = sources.actions(file)
    if (serverDirective(sources.read(file))) {
      if (names.includes('*')) exports.forEach(add)
      else for (const name of names) add(exports.find((action) => action.name === name) ?? { file, name })
      return
    }
    exports.forEach(add)
    if (visited.has(file)) return
    visited.add(file)
    for (const ref of sources.imports(file).values()) {
      const target = sources.resolve(file, ref.module)
      if (target) visit(target, [ref.name])
    }
    walk(sources.read(file), (node) => {
      const specifier = ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0]
        : ts.isExportDeclaration(node) && !node.isTypeOnly ? node.moduleSpecifier : undefined
      if (specifier && ts.isStringLiteral(specifier)) {
        const target = sources.resolve(file, specifier.text)
        if (target) visit(target, ['*'])
      }
    })
  }
  visit(registry, ['FE_FORMS'])
  return [...actions.values()].sort((a, b) => key(a).localeCompare(key(b)))
}

function binding(statement: ts.Statement | undefined) {
  if (!statement || !ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) return undefined
  const declaration = statement.declarationList.declarations[0]
  return declaration && ts.isIdentifier(declaration.name) ? { name: declaration.name.text, value: declaration.initializer } : undefined
}
function awaited(node: ts.Node | undefined) {
  return node && ts.isAwaitExpression(node) ? node.expression : undefined
}
function importedCall(node: ts.Node | undefined, refs: Map<string, ImportRef>, module: string, name: string): node is ts.CallExpression {
  if (!node || !ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return false
  const ref = refs.get(node.expression.text)
  return ref?.module === module && ref.name === name
}
function failure(statement: ts.Statement | undefined): boolean {
  if (statement && ts.isBlock(statement)) return statement.statements.length === 1 && failure(statement.statements[0])
  if (!statement || !ts.isReturnStatement(statement) || !statement.expression) return false
  const value = statement.expression
  return value.kind === ts.SyntaxKind.NullKeyword || ts.isObjectLiteralExpression(value) && value.properties.some((p) =>
    ts.isPropertyAssignment(p) && p.name.getText() === 'ok' && p.initializer.kind === ts.SyntaxKind.FalseKeyword)
}
function negates(node: ts.Expression, name: string, property?: string) {
  if (!ts.isPrefixUnaryExpression(node) || node.operator !== ts.SyntaxKind.ExclamationToken) return false
  const value = node.operand
  return property ? ts.isPropertyAccessExpression(value) && ts.isIdentifier(value.expression) && value.expression.text === name && value.name.text === property
    : ts.isIdentifier(value) && value.text === name
}
function rejects(statement: ts.Statement | undefined, name: string, property?: string) {
  return !!statement && ts.isIfStatement(statement) && negates(statement.expression, name, property) && failure(statement.thenStatement)
}
function mapsDenied(sources: Sources, file: string, statement: ts.Statement | undefined, result: string) {
  if (rejects(statement, result, 'ok')) return true
  if (!statement || !ts.isReturnStatement(statement) || !statement.expression || !ts.isCallExpression(statement.expression)) return false
  const call = statement.expression
  if (!ts.isIdentifier(call.expression) || call.expression.text !== 'toOutcome' || call.arguments[0]?.getText() !== result) return false
  const mapper = sources.read(file).statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === 'toOutcome')
  const first = mapper?.body?.statements[0]
  const parameter = mapper?.parameters[0]
  return !!first && !!parameter && ts.isIfStatement(first) && negates(first.expression, parameter.name.getText(), 'ok')
    && ts.isBlock(first.thenStatement) && failure(first.thenStatement.statements.at(-1))
}

/** 只接受可直接核對的守門形狀：action 開頭取得 actor、立即拒絕；或明列的用例與拒絕傳遞。
 * 不把註解、未 await／未使用的呼叫、巢狀函式或另一個 export 的守門算進來。
 * 這是結構合約，不嘗試證明任意控制流程；新增寫法須連同反例明確擴充。
 */
function guarded(sources: Sources, action: Action) {
  if (!action.body) return false
  const statements = action.body.statements
  const refs = sources.imports(action.file)
  const actor = binding(statements[0])
  if (actor && importedCall(awaited(actor.value), refs, actorModule, 'frontEditActor') && rejects(statements[1], actor.name)) return true
  const denied = binding(statements[1])
  if (actor && importedCall(awaited(actor.value), refs, '@/app/_ui/guard', 'currentActor') && denied
    && importedCall(denied.value, refs, '@/composition/accounts', 'checkStatus')
    && denied.value.arguments[0]?.getText() === actor.name && denied.value.arguments[1]
    && ts.isStringLiteral(denied.value.arguments[1]) && denied.value.arguments[1].text === 'business') {
    const branch = statements[2]
    if (branch && ts.isIfStatement(branch) && ts.isIdentifier(branch.expression) && branch.expression.text === denied.name && failure(branch.thenStatement)) return true
  }
  const delegate = delegates[key(action)]
  if (!delegate) return false
  for (let i = 0; i < statements.length; i++) {
    const result = binding(statements[i])
    const call = awaited(result?.value)
    if (!call || !ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== delegate.method) continue
    if (!importedCall(call.expression.expression, refs, delegate.module, delegate.name)
      || !importedCall(awaited(call.arguments[0]), refs, '@/app/_ui/guard', 'currentActor')) continue
    let bypass = false
    for (const before of statements.slice(0, i)) walk(before, (node) => {
      if (ts.isAwaitExpression(node) || ts.isReturnStatement(node) && !failure(node)) bypass = true
    })
    if (!bypass && mapsDenied(sources, action.file, statements[i + 1], result!.name)) return true
  }
  return false
}

const sources = new Sources()
const actions = discover(sources)
const violations = (input: Sources) => discover(input).filter((action) => !guarded(input, action)).map(key)
const activeOnly = `{
  const actor = await currentActor()
  if (actor.kind !== 'authenticated' || actor.status !== 'active' || !actor.roles.includes('admin')) return { ok: false, message: '拒絕' }
  return { ok: true, data: 'active-only 仍會洩漏資料' }
}`
function replaceBody(action: Action, body: string) {
  const source = sources.read(action.file)
  return source.text.slice(0, action.body!.getStart(source)) + body + source.text.slice(action.body!.end)
}

describe('SEC-1-3：逐個前台 Server Action 檢查 business 守門', () => {
  it('FE_FORMS／ITEM_FORM_DEPS 的實際依賴必須包含站內表單、合作案及三個共用後台入口', () => {
    expect(sources.read(registry).text).toContain('FE_FORMS')
    expect(sources.read(itemDeps).text).toContain('ITEM_FORM_DEPS')
    expect(actions.map(key)).toEqual(expect.arrayContaining([...direct.map(key), ...Object.keys(delegates)]))
    for (const delegate of Object.values(delegates)) expect(delegate.reason).not.toBe('')
  })

  it.each(actions)('$file#$name 自己守門或明確委派且傳回拒絕', (action) => {
    expect(guarded(sources, action), `${key(action)} 缺少有效的 business 守門`).toBe(true)
  })

  it.each(direct)('僅還原 $file#$name 為 active-only，其餘 export 保留 helper 仍須抓到', (target) => {
    const action = actions.find((a) => key(a) === key(target))!
    const mutated = new Sources({ [action.file]: replaceBody(action, activeOnly) })
    expect(violations(mutated)).toEqual([key(action)])
  })

  it.each(Object.keys(delegates))('僅移除 %s 的授權委派仍須抓到', (target) => {
    const action = actions.find((a) => key(a) === target)!
    const mutated = new Sources({ [action.file]: replaceBody(action, activeOnly) })
    expect(violations(mutated)).toEqual([target])
  })

  it.each([
    `const board = await getShowcaseQuery().adminBoard(await currentActor(), {}); return { ok: true }`,
    `const board = await otherQuery().adminBoard(await currentActor(), {}); if (!board.ok) return { ok: false }; return { ok: true }`,
    `if (true) return { ok: true }; const board = await getShowcaseQuery().adminBoard(await currentActor(), {}); if (!board.ok) return { ok: false }; return { ok: true }`,
  ])('委派清單不能掩蓋未傳回拒絕、錯誤來源或提前成功：%s', (body) => {
    const action = actions.find((a) => key(a) === `${showcase}#showcaseFeStateAction`)!
    const mutated = new Sources({ [action.file]: replaceBody(action, `{ ${body} }`) })
    expect(violations(mutated)).toEqual([key(action)])
  })

  it('登錄新 server action 時自動納入，沒有明列委派不能通過', () => {
    const file = 'dashboard/admin/future/actions.ts'
    const mutated = new Sources({
      [registry]: `${sources.read(registry).text}\nimport { futureAction } from '@/app/dashboard/admin/future/actions'`,
      [file]: `'use server'; export async function futureAction() ${activeOnly}`,
    })
    expect(violations(mutated)).toEqual([`${file}#futureAction`])
  })

  it.each([
    `/* frontEditActor() */ return { ok: true }`,
    `const hint = 'frontEditActor()'; return { ok: true, hint }`,
    `async function unused() { const actor = await frontEditActor(); if (!actor) return null }; return { ok: true }`,
    `await frontEditActor(); return { ok: true }`,
    `const actor = frontEditActor(); if (!actor) return null; return { ok: true }`,
    `const actor = await frontEditActor(); return { ok: true }`,
    `const actor = await currentActor(); const denied = checkStatus(actor, 'self.session'); if (denied) return null; return { ok: true }`,
  ])('不接受沒有有效早退的假守門：%s', (body) => {
    const file = '_ui/front-edit/fixture.ts'
    const fixture = new Sources({ [file]: `'use server';
      import { frontEditActor } from '${actorModule}';
      import { currentActor } from '@/app/_ui/guard';
      import { checkStatus } from '@/composition/accounts';
      export async function action() { ${body} }` })
    expect(guarded(fixture, fixture.actions(file)[0]!)).toBe(false)
  })

  it('接受逐 action 的 business checkStatus 早退、import 別名與 async arrow export', () => {
    const file = '_ui/front-edit/fixture.ts'
    const fixture = new Sources({ [file]: `'use server';
      import { currentActor as who } from '@/app/_ui/guard';
      import { checkStatus as status } from '@/composition/accounts';
      export const action = async () => {
        const actor = await who(); const denied = status(actor, 'business');
        if (denied) return { ok: false }; return { ok: true };
      }` })
    expect(guarded(fixture, fixture.actions(file)[0]!)).toBe(true)
  })

  it.each([
    `export { action } from './other'`,
    `export default async () => ({ ok: true })`,
    `export const action = async () => ({ ok: true })`,
  ])('不能默默略過尚未支援的 server export：%s', (declaration) => {
    const file = '_ui/front-edit/fixture.ts'
    const fixture = new Sources({ [file]: `'use server'; ${declaration}` })
    expect(fixture.actions(file)).toHaveLength(1)
    expect(guarded(fixture, fixture.actions(file)[0]!)).toBe(false)
  })
})
