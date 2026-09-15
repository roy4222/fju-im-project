/**
 * 本專案自己的 lint 規則。
 *
 * 邊界矩陣用 eslint-plugin-boundaries 就夠了，但有三件事只看路徑判斷不出來，
 * 得看檔案內容：檔案是不是 Client Component（`'use client'`）、`actions.ts` 有沒有
 * 照契約 02 §7 寫、以及 server-only 檔頭有沒有加。這三條在這裡實作。
 */

const SERVER_ONLY_SPECIFIERS = [/^@\/composition(\/|$)/, /^@\/infrastructure(\/|$)/, /^server-only$/]

function topLevelDirectives(program) {
  const directives = []
  for (const node of program.body) {
    if (
      node.type === 'ExpressionStatement' &&
      node.expression.type === 'Literal' &&
      typeof node.expression.value === 'string'
    ) {
      directives.push(node.expression.value)
      continue
    }
    break
  }
  return directives
}

/** `'use client'` 的檔案不能把 composition／infrastructure／server-only 拉進瀏覽器。 */
const clientServerBoundary = {
  meta: {
    type: 'problem',
    docs: { description: "Client Component 不可引用 composition、infrastructure 或 server-only 模組" },
    schema: [],
    messages: {
      forbidden:
        "Client Component（'use client'）不可引用 {{source}}；改成呼叫同目錄 actions.ts 的 Server Function（契約 02 §7）。",
    },
  },
  create(context) {
    let isClient = false
    return {
      Program(node) {
        isClient = topLevelDirectives(node).includes('use client')
      },
      ImportDeclaration(node) {
        if (!isClient) return
        const source = node.source.value
        if (typeof source !== 'string') return
        const relativeIntoServerLayer = /(^|\/)(composition|infrastructure)(\/|$)/.test(source) && source.startsWith('.')
        if (SERVER_ONLY_SPECIFIERS.some((re) => re.test(source)) || relativeIntoServerLayer) {
          context.report({ node, messageId: 'forbidden', data: { source } })
        }
      },
    }
  },
}

/** `app` 底下的 `actions.ts`：檔頭 `'use server'`、只匯出 async 函式（契約 02 §7）。 */
const actionsFileContract = {
  meta: {
    type: 'problem',
    docs: { description: "actions.ts 必須檔頭 'use server' 且只匯出 async 函式" },
    schema: [],
    messages: {
      missingUseServer: "actions.ts 檔頭必須是 'use server' 指令（契約 02 §7）。",
      notAsync: 'actions.ts 只能匯出 async 函式，`{{name}}` 不是（契約 02 §7）。',
      noServerOnly: "actions.ts 不加 `import 'server-only'`（契約 02 §7）。",
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename()
    if (!/(^|[\\/])actions\.tsx?$/.test(filename)) return {}

    function reportNonAsync(node, name) {
      context.report({ node, messageId: 'notAsync', data: { name } })
    }

    function checkDeclaration(declaration) {
      if (!declaration) return
      if (declaration.type === 'FunctionDeclaration') {
        if (!declaration.async) reportNonAsync(declaration, declaration.id?.name ?? '(匿名)')
        return
      }
      if (declaration.type === 'VariableDeclaration') {
        for (const declarator of declaration.declarations) {
          const init = declarator.init
          const isAsyncFn =
            init &&
            (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') &&
            init.async === true
          if (!isAsyncFn) reportNonAsync(declarator, declarator.id?.name ?? '(匿名)')
        }
        return
      }
      reportNonAsync(declaration, '(匿名)')
    }

    return {
      Program(node) {
        if (!topLevelDirectives(node).includes('use server')) {
          context.report({ node, messageId: 'missingUseServer' })
        }
      },
      ImportDeclaration(node) {
        if (node.source.value === 'server-only') {
          context.report({ node, messageId: 'noServerOnly' })
        }
      },
      ExportNamedDeclaration(node) {
        if (node.declaration) checkDeclaration(node.declaration)
        else if (node.specifiers.length > 0 && !node.source) {
          // `export { x }`：看不出 x 是不是 async 函式，一律要求直接 `export async function`
          for (const specifier of node.specifiers) {
            reportNonAsync(specifier, specifier.exported.name ?? '(匿名)')
          }
        }
      },
      ExportDefaultDeclaration(node) {
        const d = node.declaration
        const isAsyncFn =
          (d.type === 'FunctionDeclaration' || d.type === 'ArrowFunctionExpression' || d.type === 'FunctionExpression') &&
          d.async === true
        if (!isAsyncFn) reportNonAsync(node, 'default')
      },
    }
  },
}

/** `composition/*`、`infrastructure/**` 檔頭要有 `import 'server-only'`（母 spec §4.3）。 */
const serverOnlyHeader = {
  meta: {
    type: 'problem',
    docs: { description: "composition 與 infrastructure 的檔案必須 import 'server-only'" },
    schema: [],
    messages: { missing: "這一層的檔案檔頭必須有 `import 'server-only'`（母 spec §4.3）。" },
  },
  create(context) {
    return {
      Program(node) {
        const hasServerOnly = node.body.some(
          (statement) => statement.type === 'ImportDeclaration' && statement.source.value === 'server-only',
        )
        if (!hasServerOnly) context.report({ node, messageId: 'missing' })
      },
    }
  },
}


/**
 * 每一層可以用哪些外部套件（母 spec §4.3）。
 * 只看 bare specifier（不是 `.` 開頭、也不是 `@/` 別名）。
 */
const externalPackages = {
  meta: {
    type: 'problem',
    docs: { description: '限制某一層可以引用的外部套件' },
    schema: [
      {
        type: 'object',
        properties: {
          mode: { enum: ['allowlist', 'denylist'] },
          packages: { type: 'array', items: { type: 'string' } },
          message: { type: 'string' },
        },
        required: ['mode', 'packages'],
        additionalProperties: false,
      },
    ],
    messages: { forbidden: '{{message}}（被擋的是 `{{source}}`）' },
  },
  create(context) {
    const options = context.options[0]
    if (!options) return {}
    const { mode, packages } = options
    const message = options.message ?? '這一層不可以引用這個外部套件。'

    const matches = (source) =>
      packages.some((p) => (p.endsWith('/*') ? source === p.slice(0, -2) || source.startsWith(p.slice(0, -1)) : source === p))

    function check(node, source) {
      if (typeof source !== 'string') return
      if (source.startsWith('.') || source.startsWith('@/') || source.startsWith('#')) return
      const forbidden = mode === 'allowlist' ? !matches(source) : matches(source)
      if (forbidden) context.report({ node, messageId: 'forbidden', data: { source, message } })
    }

    return {
      ImportDeclaration(node) {
        check(node, node.source.value)
      },
      ExportNamedDeclaration(node) {
        if (node.source) check(node, node.source.value)
      },
      ExportAllDeclaration(node) {
        if (node.source) check(node, node.source.value)
      },
    }
  },
}

export default {
  meta: { name: 'eslint-plugin-fju', version: '0.1.0' },
  rules: {
    'client-server-boundary': clientServerBoundary,
    'actions-file-contract': actionsFileContract,
    'server-only-header': serverOnlyHeader,
    'external-packages': externalPackages,
  },
}
