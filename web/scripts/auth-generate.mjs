#!/usr/bin/env node
/**
 * 跑 Better Auth 的 schema 產生器（S00-02）。
 *
 * CLI 沒辦法在設定檔帶著 `import 'server-only'` 的情況下載入設定，所以這支先把
 * 那幾行暫時拿掉、跑完再放回去，並在產生的 schema 檔頭補上 server-only。
 * 產生器輸出必須可重跑且穩定——`auth-schema.snapshot.test.ts` 會核對 repo 裡的檔案
 * 就是產生器的輸出。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const webRoot = path.join(import.meta.dirname, '..')
/** Better Auth 的 schema 產生器。stable 線（1.4.x）鎖的 better-call 與 better-auth 1.7.5 不相容。 */
const CLI_VERSION = '@better-auth/cli@1.5.0-beta.13'
const SERVER_ONLY_LINE = "import 'server-only'\n"
const OUTPUT = path.join(webRoot, 'src/infrastructure/db/schema/auth.generated.ts')

const schemaDir = path.join(webRoot, 'src/infrastructure/db/schema')
const filesWithServerOnly = [
  path.join(webRoot, 'src/composition/auth.ts'),
  path.join(webRoot, 'src/infrastructure/db/client.ts'),
  ...fs
    .readdirSync(schemaDir)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => path.join(schemaDir, name)),
]

const originals = new Map()
for (const file of filesWithServerOnly) {
  if (!fs.existsSync(file)) continue
  const content = fs.readFileSync(file, 'utf8')
  originals.set(file, content)
  fs.writeFileSync(file, content.replace(SERVER_ONLY_LINE, ''))
}

try {
  // CLI 用 `pnpm dlx` 隔離執行，不進 devDependencies：它會拉進 prisma 與一票有漏洞的舊套件，
  // 而它只是「產 schema 一次」的工具。版本釘死，輸出與裝成 devDependency 時逐字相同。
  execFileSync(
    'pnpm',
    ['dlx', CLI_VERSION, 'generate', '--config', 'src/composition/auth.ts', '--output', 'src/infrastructure/db/schema/auth.generated.ts', '--yes'],
    {
      cwd: webRoot,
      stdio: 'inherit',
      env: {
        ...process.env,
        // 產生器只讀設定，不連線；給值只是為了讓設定檔載入得起來。
        DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://schema-generation-only@127.0.0.1:5432/none',
        BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? 'schema-generation-only',
      },
    },
  )
} finally {
  for (const [file, content] of originals) {
    if (file === OUTPUT) continue
    fs.writeFileSync(file, content)
  }
}

const generated = fs.readFileSync(OUTPUT, 'utf8')
const header = `import 'server-only'\n// 由 \`pnpm auth:generate\` 產生（Better Auth schema 產生器）；不要手改。\n// 這是「套件說它要什麼」的原樣輸出，只作核對基準；實際使用的是同目錄 auth.ts\n// （欄名一致，型別依契約 01 §1 改成 uuid／timestamptz／RESTRICT）。\n// 業務擴充欄在 src/composition/auth.ts 的 additionalFields，改那裡再重跑。\n\n`
if (!generated.startsWith("import 'server-only'")) {
  fs.writeFileSync(OUTPUT, header + generated.replace(/^\s*\n/, ''))
}
console.log(`已產生 ${path.relative(webRoot, OUTPUT)}`)
