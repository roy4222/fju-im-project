#!/usr/bin/env node
/**
 * overlay 小檔的工具（D-23 放寬，規則見 `merge.mjs` 與三個 `.d/README.md`）。
 *
 *   pnpm -C web overlay check                               三個資料夾都合併一次；有錯 exit 1，沒錯印小檔數與動到的鍵數
 *   pnpm -C web overlay print <fingerprints|budget|sql-expect> [--base <檔>]   印合併結果（JSON）
 *   pnpm -C web overlay fold  <budget|sql-expect|fingerprints> [--base <檔>]   把小檔併進基底、刪掉小檔
 *
 * `fold` 只在沒有開著的 PR 動到小檔時，由主腦或收尾票跑。指紋的 fold 不改 TS 檔，印出字面值供貼回。
 * `--base` 讓 print／fold 對別的基底檔跑（測試用；小檔資料夾照同一規則找它旁邊的 `.d/`）。
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fingerprintsLiteral, foldBaseFile, kindOf, mergeFromBaseFile, mergeFromDir, overlayDirFor } from './merge.mjs'

const WEB_ROOT = path.join(import.meta.dirname, '..', '..')
const BASE_FILES = {
  fingerprints: path.join(WEB_ROOT, 'e2e', 'fingerprints.ts'),
  budget: path.join(WEB_ROOT, 'scripts', 'perf', 'budget.json'),
  'sql-expect': path.join(WEB_ROOT, 'scripts', 'perf', 'sql-expect.json'),
}

function usage() {
  console.error('用法：overlay check | overlay print <fingerprints|budget|sql-expect> [--base <檔>] | overlay fold <budget|sql-expect|fingerprints> [--base <檔>]')
  process.exit(2)
}

async function merge(kind, baseFile) {
  if (kind === 'fingerprints') {
    // Node 22.18+ 直接載 TS（只去型別）。
    const mod = await import(pathToFileURL(baseFile).href)
    return mergeFromDir(mod.BASE_FINGERPRINTS, overlayDirFor(baseFile), 'fingerprints')
  }
  return mergeFromBaseFile(baseFile, kind)
}

async function main() {
  const [cmd, kindArg, ...rest] = process.argv.slice(2)
  const baseIdx = rest.indexOf('--base')
  const baseOverride = baseIdx >= 0 ? rest[baseIdx + 1] : null
  if (cmd === 'check') {
    let failed = false
    for (const kind of Object.keys(BASE_FILES)) {
      const dir = overlayDirFor(BASE_FILES[kind])
      try {
        const r = await merge(kind, BASE_FILES[kind])
        console.log(`${path.relative(WEB_ROOT, dir).padEnd(28)} 小檔 ${String(r.files.length).padStart(2)} 個，動到 ${String(r.changed.length + r.deleted.length).padStart(2)} 個鍵${r.deleted.length ? `（刪 ${r.deleted.length}）` : ''}`)
      } catch (e) {
        failed = true
        console.error(`✗ ${e.message}`)
      }
    }
    if (failed) process.exit(1)
    return
  }
  if ((cmd !== 'print' && cmd !== 'fold') || !kindArg) usage()
  let kind
  try {
    kind = kindOf(kindArg)
  } catch (e) {
    console.error(e.message)
    process.exit(2)
  }
  const baseFile = baseOverride ? path.resolve(baseOverride) : BASE_FILES[kind]
  try {
    if (cmd === 'print') {
      const r = await merge(kind, baseFile)
      console.log(JSON.stringify(r.merged, null, 2))
      return
    }
    if (kind === 'fingerprints') {
      const r = await merge(kind, baseFile)
      console.error(`指紋的 fold 不改 ${path.relative(WEB_ROOT, baseFile)}：把下面的字面值貼回 BASE_FINGERPRINTS，再刪掉 ${path.relative(WEB_ROOT, overlayDirFor(baseFile))} 裡的小檔（${r.files.join('、') || '目前沒有'}）。`)
      process.stdout.write(fingerprintsLiteral(r.merged))
      return
    }
    const r = foldBaseFile(baseFile, kind)
    console.log(`已把 ${r.removed.length} 個小檔併進 ${path.relative(process.cwd(), baseFile)} 並刪掉：${r.removed.join('、') || '（沒有小檔）'}`)
  } catch (e) {
    console.error(`✗ ${e.message}`)
    process.exit(1)
  }
}

await main()
