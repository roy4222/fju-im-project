#!/usr/bin/env node
/**
 * CI 第七道：依賴稽核（契約 03 §8、契約 05 §2）。
 *
 * `pnpm audit` 看的是整個 workspace 的 lockfile，裡面有一半是 `prototype/`——
 * 那是評選用的可點原型，不會部署，它的洞不該擋正式碼的 PR。所以這支只看
 * **會進到 web/ 的**相依路徑，high 與 critical 就讓 CI 紅。
 *
 * 用法：pnpm audit --json | node scripts/audit-check.mjs [--level high]
 * （pnpm audit 有洞時會回非 0，所以呼叫端要用 `|| true` 把輸出傳進來。）
 */
const levelArgIndex = process.argv.indexOf('--level')
const minLevel = levelArgIndex === -1 ? 'high' : (process.argv[levelArgIndex + 1] ?? 'high')
const ORDER = ['info', 'low', 'moderate', 'high', 'critical']
const threshold = ORDER.indexOf(minLevel)

const input = await new Promise((resolve, reject) => {
  let data = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => (data += chunk))
  process.stdin.on('end', () => resolve(data))
  process.stdin.on('error', reject)
})

if (input.trim() === '') {
  console.error('沒有收到 pnpm audit 的輸出。用法：pnpm audit --json | node scripts/audit-check.mjs')
  process.exit(1)
}

const report = JSON.parse(input)
const advisories = Object.values(report.advisories ?? {})

/** 這條相依路徑會不會進到 web/？ */
const reachesWeb = (path) => path.startsWith('web>') || path === 'web'

const blocking = []
const prototypeOnly = []

for (const advisory of advisories) {
  if (ORDER.indexOf(advisory.severity) < threshold) continue
  const paths = (advisory.findings ?? []).flatMap((finding) => finding.paths ?? [])
  const webPaths = paths.filter(reachesWeb)
  const entry = { severity: advisory.severity, module: advisory.module_name, url: advisory.url, webPaths, paths }
  if (webPaths.length > 0) blocking.push(entry)
  else prototypeOnly.push(entry)
}

const counts = report.metadata?.vulnerabilities ?? {}
console.log(
  `pnpm audit 全 workspace：${Object.entries(counts)
    .map(([k, v]) => `${k} ${v}`)
    .join('、')}`,
)
console.log(`門檻：${minLevel} 以上`)
console.log(`只影響 prototype/（不部署，不擋）：${prototypeOnly.length} 件`)
for (const item of prototypeOnly) {
  console.log(`  - [${item.severity}] ${item.module}`)
}

if (blocking.length === 0) {
  console.log('\n沒有影響 web/ 的 high／critical 漏洞。')
  process.exit(0)
}

console.error(`\n影響 web/ 的 ${minLevel} 以上漏洞 ${blocking.length} 件：`)
for (const item of blocking) {
  console.error(`  - [${item.severity}] ${item.module}  ${item.url ?? ''}`)
  for (const p of item.webPaths.slice(0, 3)) console.error(`      ${p}`)
}
process.exit(1)
