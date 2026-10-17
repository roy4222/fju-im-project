#!/usr/bin/env node
// node scripts/audit-gate.mjs [audit.json]；未給檔名時讀 stdin。
import { readFileSync } from 'node:fs'

const SEVERITIES = new Set(['info', 'low', 'moderate', 'high', 'critical'])
const EXEMPT = [
  'GHSA-vfj7-8cjw-p6xm', // braces：單條暫時豁免，升版與移除追蹤 #570。
]
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isNonemptyString = (value) => typeof value === 'string' && value.trim().length > 0

function readAdvisories(input) {
  const report = JSON.parse(input)
  if (!isRecord(report)) throw new Error('audit 報告必須是非 null、非陣列物件')
  if (Object.hasOwn(report, 'error')) throw new Error('audit 報告含 error 欄位')
  if (!isRecord(report.advisories)) throw new Error('advisories 必須是非 null、非陣列物件')

  const advisories = Object.entries(report.advisories)
  for (const [key, advisory] of advisories) {
    if (!isRecord(advisory)) throw new Error(`advisory ${key} 必須是物件`)
    if (!SEVERITIES.has(advisory.severity)) throw new Error(`advisory ${key} 缺少合法 severity`)
    const hasId = Object.hasOwn(advisory, 'github_advisory_id')
    const hasUrl = Object.hasOwn(advisory, 'url')
    if (!hasId && !hasUrl) throw new Error(`advisory ${key} 缺少 github_advisory_id／url`)
    if ((hasId && !isNonemptyString(advisory.github_advisory_id)) ||
        (hasUrl && !isNonemptyString(advisory.url))) {
      throw new Error(`advisory ${key} 的 github_advisory_id／url 必須是非空字串`)
    }
  }
  return advisories.map(([, advisory]) => advisory)
}

try {
  // 先驗完整份結構；畸形或無法辨識的紀錄不能被豁免或視為低風險。
  const advisories = readAdvisories(readFileSync(process.argv[2] ?? 0, 'utf8'))
  let bad = 0
  for (const advisory of advisories) {
    // 至少一個身分欄位已通過驗證；兩者都有時必須同時精確命中同一條豁免。
    const skip = EXEMPT.some((id) =>
      (advisory.github_advisory_id === undefined || advisory.github_advisory_id === id) &&
      (advisory.url === undefined || advisory.url === `https://github.com/advisories/${id}`),
    )
    const hit = ['high', 'critical'].includes(advisory.severity) && !skip
    const identity = advisory.github_advisory_id ?? advisory.url
    console.log(`${hit ? 'FAIL' : skip ? '豁免' : '略過'} ${advisory.severity} ${identity} ${advisory.module_name ?? ''}`)
    if (hit) bad++
  }
  console.log(`${advisories.length} 條 advisory，${bad} 條未豁免的 high／critical`)
  process.exitCode = bad ? 1 : 0
} catch (error) {
  console.error(`audit gate 失敗：${error.message}`)
  process.exitCode = 1
}
