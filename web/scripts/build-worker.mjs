#!/usr/bin/env node
/**
 * 把背景工作進程打包成單一檔案 `dist/worker.mjs`（票 12；Compose 的 worker 服務跑它）。
 *
 * - 自己的程式碼（`@/…` 別名、TypeScript）全部打包進去；
 * - 第三方套件（pg、drizzle-orm、uuidv7…）不打包，執行期從 node_modules 解析——
 *   映像裡放在 `migrate/web/dist/`，跟 migrate 腳本共用那一份 production node_modules；
 * - `server-only` 換成空模組：它在 Next 之外 import 會直接丟錯（它的用意是擋 client bundle，
 *   worker 本來就是伺服器端）。
 *
 * `pnpm -C web build` 會在 `next build` 之後跑這支。
 */
import path from 'node:path'
import { build } from 'esbuild'

const webRoot = path.join(import.meta.dirname, '..')

const emptyServerOnly = {
  name: 'empty-server-only',
  setup(builder) {
    builder.onResolve({ filter: /^server-only$/ }, () => ({ path: 'server-only', namespace: 'empty-server-only' }))
    builder.onLoad({ filter: /.*/, namespace: 'empty-server-only' }, () => ({ contents: 'export {}', loader: 'js' }))
  },
}

const result = await build({
  absWorkingDir: webRoot,
  entryPoints: ['src/composition/worker-main.ts'],
  outfile: 'dist/worker.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'external',
  tsconfig: 'tsconfig.json',
  plugins: [emptyServerOnly],
  metafile: true,
  logLevel: 'warning',
})

// 防呆：worker 不該把 Next 或 Better Auth 拉進來（那是 app 的東西，而且在 Next 之外跑不起來）。
const imported = Object.values(result.metafile.outputs).flatMap((output) => output.imports.map((i) => i.path))
const forbidden = imported.filter((p) => /^(next|react|react-dom|better-auth)(\/|$)/.test(p))
if (forbidden.length) {
  console.error(`worker 不該依賴這些套件：${[...new Set(forbidden)].join('、')}`)
  process.exit(1)
}
console.log(`已產生 dist/worker.mjs（外部依賴：${[...new Set(imported)].sort().join('、')}）`)
