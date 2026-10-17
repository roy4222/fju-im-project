#!/usr/bin/env node
/**
 * 產生 100 張預設頭像（SH-8；AC-SH-42）：來源 PNG → `public/avatars/001～100.webp`（256×256、每張 ≤ 30 KB）。
 *
 * 用法：
 *   node scripts/avatars-build.mjs [來源資料夾]          產生並覆寫 public/avatars
 *   node scripts/avatars-build.mjs [來源資料夾] --check  只比對：重產結果與 repo 裡的檔逐位元組相同才 exit 0
 *
 * 來源資料夾預設 `~/work/proto-shots/avatars-final`（也可用環境變數 `AVATAR_SRC`），
 * 裡面要剛好有 `avatar-001-*.png`～`avatar-100-*.png` 各一張（檔名後段是描述，不看）。
 * sharp 預設不帶 EXIF／ICC 等中繼資料進輸出；同一版 sharp、同一份來源重跑得到相同位元組。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'

const SIZE = 256
const COUNT = 100
const MAX_BYTES = 30 * 1024
const QUALITY = 80

const webRoot = path.join(import.meta.dirname, '..')
const outDir = path.join(webRoot, 'public/avatars')
const args = process.argv.slice(2)
const check = args.includes('--check')
const srcDir = path.resolve(
  args.find((a) => !a.startsWith('--')) ?? process.env.AVATAR_SRC ?? path.join(os.homedir(), 'work/proto-shots/avatars-final'),
)

function fail(message) {
  console.error(`avatars-build：${message}`)
  process.exit(1)
}

if (!fs.existsSync(srcDir)) fail(`找不到來源資料夾 ${srcDir}`)

// 編號 → 來源檔；每個編號剛好一張。
const sources = new Map()
for (const name of fs.readdirSync(srcDir)) {
  const m = /^avatar-(\d{3})(?:-.*)?\.png$/i.exec(name)
  if (!m) continue
  const n = Number(m[1])
  if (n < 1 || n > COUNT) fail(`編號超出 1～${COUNT}：${name}`)
  if (sources.has(n)) fail(`編號 ${m[1]} 有兩張：${sources.get(n)}、${name}`)
  sources.set(n, name)
}
const missing = Array.from({ length: COUNT }, (_, i) => i + 1).filter((n) => !sources.has(n))
if (missing.length > 0) fail(`缺 ${missing.length} 張：${missing.map((n) => String(n).padStart(3, '0')).join(', ')}`)

if (!check) fs.mkdirSync(outDir, { recursive: true })

let total = 0
const mismatched = []
for (let n = 1; n <= COUNT; n++) {
  const id = String(n).padStart(3, '0')
  const buf = await sharp(path.join(srcDir, sources.get(n)))
    .resize(SIZE, SIZE, { fit: 'cover', position: 'centre' })
    .webp({ quality: QUALITY, effort: 6 })
    .toBuffer()
  if (buf.length > MAX_BYTES) fail(`${id}.webp 有 ${buf.length} bytes，超過 ${MAX_BYTES}`)
  total += buf.length
  const target = path.join(outDir, `${id}.webp`)
  if (check) {
    if (!fs.existsSync(target) || !fs.readFileSync(target).equals(buf)) mismatched.push(`${id}.webp`)
  } else {
    fs.writeFileSync(target, buf)
  }
}

if (check) {
  if (mismatched.length > 0) fail(`與 repo 裡的檔不同：${mismatched.join(', ')}`)
  console.log(`avatars-build --check：${COUNT} 張與 public/avatars 相同（共 ${(total / 1024).toFixed(1)} KB）`)
} else {
  console.log(`avatars-build：寫出 ${COUNT} 張到 public/avatars（共 ${(total / 1024).toFixed(1)} KB）`)
}
