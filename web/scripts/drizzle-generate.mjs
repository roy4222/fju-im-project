#!/usr/bin/env node
/**
 * 產生純 SQL migration（契約 01 §12：drizzle-kit 產生純 SQL）。
 *
 * drizzle-kit 在 Node 裡載入 schema，碰到 `import 'server-only'` 會爆，
 * 所以跟 auth-generate 一樣：暫時拿掉、跑完放回去。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const webRoot = path.join(import.meta.dirname, '..')
const SERVER_ONLY_LINE = "import 'server-only'\n"
const schemaDir = path.join(webRoot, 'src/infrastructure/db/schema')
const files = fs.readdirSync(schemaDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))

const originals = new Map()
for (const name of files) {
  const file = path.join(schemaDir, name)
  const content = fs.readFileSync(file, 'utf8')
  originals.set(file, content)
  fs.writeFileSync(file, content.replace(SERVER_ONLY_LINE, ''))
}

try {
  execFileSync(path.join(webRoot, 'node_modules/.bin/drizzle-kit'), ['generate', ...process.argv.slice(2)], {
    cwd: webRoot,
    stdio: 'inherit',
  })
} finally {
  for (const [file, content] of originals) fs.writeFileSync(file, content)
}
