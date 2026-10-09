#!/usr/bin/env node
/**
 * CI 第七道：依賴稽核（契約 03 §8、契約 05 §2）。
 *
 * `pnpm audit` 看的是整個 workspace 的 lockfile，裡面有一半是 `prototype/`——
 * 那是評選用的可點原型，不會部署，它的洞不該擋正式碼的 PR。所以這支只看
 * **會進到 web/ 的**相依路徑，high 與 critical 就讓 CI 紅。
 *
 * 用法：pnpm audit --json | node scripts/audit-check.mjs [--level high]
 * （pnpm audit 找到漏洞時會回非 0，所以呼叫端要用 `|| true` 把輸出傳進來。
 *   正因為如此，**這支必須自己確認報告是「成功產生」的**——否則 registry 掛掉、
 *   離線、或輸出被截斷時，advisories 會是空的，稽核就會假裝通過。）
 */
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const ORDER = ['info', 'low', 'moderate', 'high', 'critical']

/** 這條相依路徑會不會進到 web/？ */
const reachesWeb = (p) => p === 'web' || p.startsWith('web>')

/**
 * 已知忽略：上游沒有修正版、而且只經開發期工具進到 web/ 的漏洞。
 * 只有在**每一條** web/ 路徑都落在 `devOnlyVia` 底下時才忽略；出現執行期路徑就照常擋。
 * 過了 `expires`（台北日期）一律失敗，逼人重新評估——修正版出了就升級並刪掉這筆。
 */
export const KNOWN_IGNORES = [
  {
    id: 'GHSA-vfj7-8cjw-p6xm',
    module: 'braces',
    reason: '上游無修正版（braces 最新 3.0.3），只經 micromatch 影響開發期 lint',
    devOnlyVia: ['web>@next/eslint-plugin-next>', 'web>eslint-plugin-boundaries>'],
    expires: '2026-12-31',
  },
]

const taipeiToday = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' })
const advisoryId = (advisory) => advisory.github_advisory_id ?? advisory.url?.split('/').pop()

/**
 * 把門檻以上的 advisories 分成「擋」「只影響 prototype」「已知忽略」三堆。
 * `today` 只給測試直接呼叫時傳假日期；CLI 一律用真實時間，不吃任何環境變數。
 */
export function classifyAdvisories(advisories, threshold, today = taipeiToday()) {
  const blocking = []
  const prototypeOnly = []
  const ignored = []

  for (const advisory of advisories) {
    if (ORDER.indexOf(advisory.severity) < threshold) continue
    const paths = (advisory.findings ?? []).flatMap((finding) => finding.paths ?? [])
    if (paths.length === 0) {
      // 沒有相依路徑就無法判斷影響哪個 package，保守當成會擋。
      blocking.push({ severity: advisory.severity, module: advisory.module_name, url: advisory.url, webPaths: ['(報告沒有給相依路徑)'] })
      continue
    }
    const webPaths = paths.filter(reachesWeb)
    const entry = { severity: advisory.severity, module: advisory.module_name, url: advisory.url, webPaths }
    if (webPaths.length === 0) {
      prototypeOnly.push(entry)
      continue
    }
    const known = KNOWN_IGNORES.find((rule) => rule.id === advisoryId(advisory) && rule.module === advisory.module_name)
    const allDevOnly = known && webPaths.every((p) => known.devOnlyVia.some((prefix) => p.startsWith(prefix)))
    if (known && allDevOnly && today <= known.expires) {
      ignored.push({ ...entry, rule: known })
    } else if (known && allDevOnly) {
      blocking.push({ ...entry, note: `已知忽略 ${known.id} 已於 ${known.expires} 到期，請重新評估（升級或延長並寫明理由）` })
    } else {
      blocking.push(entry)
    }
  }
  return { blocking, prototypeOnly, ignored }
}

/** CLI 本體；被 import（測試）時不執行。 */
async function main() {
  const levelArgIndex = process.argv.indexOf('--level')
  const minLevel = levelArgIndex === -1 ? 'high' : (process.argv[levelArgIndex + 1] ?? 'high')
  const threshold = ORDER.indexOf(minLevel)
  if (threshold === -1) {
    console.error(`--level 只能是 ${ORDER.join('、')}，收到 ${JSON.stringify(minLevel)}`)
    process.exit(2)
  }

  const input = await new Promise((resolve, reject) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => (data += chunk))
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', reject)
  })

  /** 稽核本身沒跑成功——一律非 0，不能當成「沒有漏洞」。 */
  function auditDidNotRun(reason) {
    console.error(`依賴稽核沒有成功執行：${reason}`)
    console.error('這不等於「沒有漏洞」。請確認 `pnpm audit --json` 真的跑完再重試。')
    process.exit(1)
  }

  if (input.trim() === '') {
    auditDidNotRun('沒有收到 `pnpm audit --json` 的輸出（stdin 是空的）')
  }

  let report
  try {
    report = JSON.parse(input)
  } catch (error) {
    auditDidNotRun(`輸出不是合法 JSON——${error instanceof Error ? error.message : String(error)}`)
  }

  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    auditDidNotRun('輸出不是 JSON 物件')
  }

  // pnpm 在 registry 失敗時會回 `{"error":{...}}`，這時 advisories 根本不存在。
  if (report.error !== undefined) {
    const { code, message } = report.error ?? {}
    auditDidNotRun(`pnpm 回報錯誤 ${code ?? '(無代碼)'}：${message ?? '(無訊息)'}`)
  }

  // 成功的報告一定同時有這兩塊；缺任何一塊都代表輸出不完整。
  if (report.advisories === null || typeof report.advisories !== 'object' || Array.isArray(report.advisories)) {
    auditDidNotRun('報告缺少 `advisories` 物件')
  }
  const counts = report.metadata?.vulnerabilities
  if (counts === null || typeof counts !== 'object' || Array.isArray(counts)) {
    auditDidNotRun('報告缺少 `metadata.vulnerabilities`')
  }
  for (const level of ORDER) {
    if (typeof counts[level] !== 'number') {
      auditDidNotRun(`\`metadata.vulnerabilities.${level}\` 不是數字，報告不完整`)
    }
  }

  const advisories = Object.values(report.advisories)

  // 報告說有幾件、advisories 裡就該有幾件；對不上代表輸出被截斷。
  const reportedTotal = ORDER.reduce((sum, level) => sum + counts[level], 0)
  if (advisories.length !== reportedTotal) {
    auditDidNotRun(
      `metadata 說有 ${reportedTotal} 件漏洞，advisories 裡卻有 ${advisories.length} 件——報告不完整`,
    )
  }

  const { blocking, prototypeOnly, ignored } = classifyAdvisories(advisories, threshold)

  console.log(
    `pnpm audit 全 workspace：${ORDER.map((level) => `${level} ${counts[level]}`).join('、')}（共 ${reportedTotal} 件）`,
  )
  console.log(`門檻：${minLevel} 以上`)
  console.log(`只影響 prototype/（不部署，不擋）：${prototypeOnly.length} 件`)
  for (const item of prototypeOnly) {
    console.log(`  - [${item.severity}] ${item.module}`)
  }
  for (const item of ignored) {
    console.log(`已知忽略：[${item.severity}] ${item.module} ${item.rule.id}——${item.rule.reason}（到期 ${item.rule.expires}）`)
  }

  if (blocking.length === 0) {
    console.log('\n沒有影響 web/ 的 high／critical 漏洞。')
    process.exit(0)
  }

  console.error(`\n影響 web/ 的 ${minLevel} 以上漏洞 ${blocking.length} 件：`)
  for (const item of blocking) {
    console.error(`  - [${item.severity}] ${item.module}  ${item.url ?? ''}`)
    if (item.note) console.error(`      ${item.note}`)
    for (const p of item.webPaths.slice(0, 3)) console.error(`      ${p}`)
  }
  process.exit(1)
}

// 用 realpath 比對：路徑經過 symlink（例如 macOS 的 /tmp）時也要認得出是直接執行，否則會默默 exit 0。
const invokedDirectly = process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
if (invokedDirectly) await main()
