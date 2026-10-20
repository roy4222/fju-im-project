import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const appRoot = path.resolve(import.meta.dirname, '../../src/app')

/** 解析語法，避免註解、字串或只有 import 就讓缺守門的 action 過關。 */
function inspect(source: string) {
  const ast = ts.createSourceFile('action.ts', source, ts.ScriptTarget.Latest, true)
  let server = false
  let guarded = false
  function visit(node: ts.Node) {
    if (ts.isExpressionStatement(node) && ts.isStringLiteral(node.expression) && node.expression.text === 'use server') server = true
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ['frontEditActor', 'checkStatus'].includes(node.expression.text)) guarded = true
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return { server, guarded }
}

describe('SEC-1-3：前台編輯 Server Actions 必須明確檢查帳號狀態', () => {
  it('掃描所有 front-edit/**/*.ts 與 *context-action.ts，不豁免既有入口', () => {
    const files = readdirSync(appRoot, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.ts') && (file.split(path.sep).includes('front-edit') || file.endsWith('context-action.ts')))
    const actions = files
      .map((file) => ({ file, ...inspect(readFileSync(path.join(appRoot, file), 'utf8')) }))
      .filter(({ server }) => server)

    expect(actions.map(({ file }) => file)).toEqual(expect.arrayContaining([
      '_ui/front-edit/forms/actions.ts',
      'dashboard/_industry/front-edit/actions.ts',
      'dashboard/admin/affairs/front-edit-context-action.ts',
    ]))
    expect(actions.filter(({ guarded }) => !guarded).map(({ file }) => file),
      '這些 Server Actions 缺少 frontEditActor() 或 checkStatus()',
    ).toEqual([])
  })

  it('舊的 active-only 守門會被抓到；註解、字串與未使用的 import 不算檢查', () => {
    expect(inspect(`
      'use server'
      import { frontEditActor } from '@/app/_ui/front-edit/actor'
      // checkStatus(actor, 'business')
      const hint = 'frontEditActor()'
      export async function contextAction() {
        const actor = await currentActor()
        if (actor.kind !== 'authenticated' || actor.status !== 'active' || !actorHasRole(actor, 'admin')) return null
        return actor
      }
    `)).toEqual({ server: true, guarded: false })
  })

  it.each(['await frontEditActor()', "checkStatus(actor, 'business')"])('接受明確的 %s 呼叫', (guard) => {
    expect(inspect(`'use server'; export async function contextAction() { return ${guard} }`))
      .toEqual({ server: true, guarded: true })
  })
})
