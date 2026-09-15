import path from 'node:path'

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


/**
 * 跨模組引用規則（母 spec §4.3）。
 *
 * §4.3 的矩陣除了「哪一層可以引用哪一層」，還有兩條只看 layer 判斷不出來的限制：
 *
 * 1. **公開入口**：每個模組只從自己的 `index.ts` 對外；別的模組不可以直接指到內部檔案。
 * 2. **跨模組只能 type-only**：跨模組的**執行期**呼叫一律透過 composition 注入的 port
 *    實例，所以 import 本身只能帶型別。同模組內（例如 application/x 用 domain/x）
 *    是自己的東西，可以帶執行期值。app 層更嚴：對 application 一律 type-only，
 *    要執行就得走 composition。
 *
 * infrastructure 與 composition 不在此限——前者實作 port、後者負責組裝，本來就要拿到實作。
 */
const MODULE_LAYERS = new Set(['domain', 'application'])

/** 把路徑拆成 { layer, module, inner }；不在六層裡就回 null。 */
function classify(filePath) {
  const normalized = filePath.replaceAll('\\', '/')
  const marker = '/src/'
  const at = normalized.lastIndexOf(marker)
  if (at === -1) return null
  const parts = normalized
    .slice(at + marker.length)
    .replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '')
    .split('/')
    .filter(Boolean)
  const layer = parts[0]
  if (!layer) return null
  if (!MODULE_LAYERS.has(layer)) return { layer, module: null, inner: parts.slice(1) }
  return { layer, module: parts[1] ?? null, inner: parts.slice(2) }
}

/** import 的字串解析成路徑；只處理相對路徑與 `@/` 別名。 */
function resolveSpecifier(context, source) {
  if (source.startsWith('.')) {
    const dir = path.posix.dirname((context.filename ?? context.getFilename()).replaceAll('\\', '/'))
    return path.posix.normalize(path.posix.join(dir, source))
  }
  if (source.startsWith('@/')) {
    // `@/` 指向這個 package 的 src/，對應到 classify 認得的 `/src/` 標記。
    return `/src/${source.slice(2)}`
  }
  return null
}

const moduleBoundary = {
  meta: {
    type: 'problem',
    docs: { description: '跨模組只能經公開入口，而且（除了 infrastructure 與 composition）只能 type-only' },
    schema: [],
    messages: {
      notEntryPoint:
        '跨模組只能引用 `{{layer}}/{{module}}` 的公開入口（index.ts），不可以直接指到內部檔案 `{{source}}`（母 spec §4.3）。',
      notTypeOnly:
        '跨模組的{{kind}}只能帶型別：請用 `{{fix}}`。執行期呼叫一律走 composition 注入的 port 實例（母 spec §4.3）。',
      appNeedsTypeOnly:
        'app 對 application 只能帶型別（`{{fix}}`）；要執行用例請經 composition（母 spec §4.3）。',
    },
  },
  create(context) {
    const from = classify((context.filename ?? context.getFilename()).replaceAll('\\', '/'))
    if (!from) return {}
    // shared 與不在六層裡的檔案不管。其餘五層都要守公開入口；
    // 「只能 type-only」則只套在 domain、application、app——infrastructure 實作 port、
    // composition 負責組裝，本來就要拿得到執行期的實作（母 spec §4.3）。
    const enforcesEntryPoint = ['domain', 'application', 'app', 'infrastructure', 'composition'].includes(from.layer)
    if (!enforcesEntryPoint) return {}
    const enforcesTypeOnly = ['domain', 'application', 'app'].includes(from.layer)

    /**
     * import 與 re-export 走同一條檢查。
     * `export … from` 一樣會把別的模組的東西接出去，只檢查 import 等於留一個後門。
     */
    function check(node, source, typeOnly, kind) {
      if (typeof source !== 'string') return
      const resolved = resolveSpecifier(context, source)
      if (!resolved) return
      const to = classify(resolved)
      if (!to || !MODULE_LAYERS.has(to.layer) || !to.module) return

      const sameModule = from.module !== null && from.module === to.module && from.layer !== 'app'

      // 1. 公開入口：不是自己模組的東西，只能指到 index。
      const pointsAtIndex = to.inner.length === 0 || (to.inner.length === 1 && to.inner[0] === 'index')
      if (!sameModule && !pointsAtIndex) {
        context.report({ node, messageId: 'notEntryPoint', data: { layer: to.layer, module: to.module, source } })
      }

      // 2. type-only：跨模組（以及 app 對 application）一律只能帶型別。
      if (sameModule || !enforcesTypeOnly || typeOnly) return
      const fix = kind === 'import' ? 'import type' : 'export type'
      context.report({
        node,
        messageId: from.layer === 'app' ? 'appNeedsTypeOnly' : 'notTypeOnly',
        data: { kind: kind === 'import' ? '引用' : 're-export', fix },
      })
    }

    /** `import type …` / `export type …`，或每個 specifier 都標了 type。 */
    const allSpecifiersAreType = (node, kindKey) =>
      node.specifiers.length > 0 && node.specifiers.every((s) => s[kindKey] === 'type')

    return {
      ImportDeclaration(node) {
        check(node, node.source.value, node.importKind === 'type' || allSpecifiersAreType(node, 'importKind'), 'import')
      },
      // `export { x } from '…'`
      ExportNamedDeclaration(node) {
        if (!node.source) return
        check(node, node.source.value, node.exportKind === 'type' || allSpecifiersAreType(node, 'exportKind'), 'export')
      },
      // `export * from '…'` / `export type * from '…'`
      ExportAllDeclaration(node) {
        if (!node.source) return
        check(node, node.source.value, node.exportKind === 'type', 'export')
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
    'module-boundary': moduleBoundary,
  },
}
