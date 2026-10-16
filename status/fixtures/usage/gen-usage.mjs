#!/usr/bin/env node
// 產生 fixtures/usage/data/usage.json（DV 設計方案 §7.5 的形狀；AC-DV-24）：120 天 × 3 角色的 daily、
// 約 40 筆 actions（含 account.change_password、3 個 count30d:0、1 個對照表沒有的代碼）。
// 其他檔是 fixtures/base/data 的複本（cp -R），只多這一個檔。固定種子，重跑結果一模一樣；產物要 commit。
//   node fixtures/usage/gen-usage.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'usage.json')
const GENERATED_AT = '2026-10-12T04:10:00+08:00'
const TO = '2026-10-12'
const DAYS = 120

/** mulberry32：小而固定的亂數（同 gen-metrics.mjs）。 */
function random(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const day = (offset) => new Date(Date.parse(`${TO}T00:00:00Z`) - offset * 86400e3).toISOString().slice(0, 10)

/** 每個角色平日的活躍人數；週末打六折，8/1 開學前（暑假）打三折。 */
const BASE = { student: 420, teacher: 36, admin: 8 }
const rand = random(20261012)
const daily = []
for (let i = DAYS - 1; i >= 0; i--) {
  const d = day(i)
  const weekday = new Date(`${d}T00:00:00Z`).getUTCDay()
  const factor = (weekday === 0 || weekday === 6 ? 0.6 : 1) * (d < '2026-08-01' ? 0.3 : 1)
  for (const role of ['student', 'teacher', 'admin']) {
    const activeUsers = Math.max(0, Math.round(BASE[role] * factor * (0.85 + rand() * 0.3)))
    daily.push({ day: d, role, activeUsers, events: activeUsers * (role === 'student' ? 9 : 6) })
  }
}

// [action, role, count7d, count30d, countTerm]
const actions = [
  ['submission.upload', 'student', 3842, 15210, 36400],
  ['submission.submit', 'student', 1904, 7480, 17950],
  ['registration.apply', 'student', 486, 1720, 4100],
  ['registration.revise', 'student', 120, 480, 1150],
  ['group.proposal.create', 'student', 312, 1290, 3080],
  ['group.proposal.confirm', 'student', 280, 1102, 2650],
  ['group.member.add', 'student', 96, 410, 980],
  ['group.member.remove', 'student', 14, 60, 140],
  ['signoff.respond', 'student', 640, 2210, 5300],
  ['showcase.draft_create', 'student', 41, 150, 360],
  ['showcase.draft_update', 'student', 210, 830, 1990],
  ['account.change_password', 'student', 22, 95, 230],
  ['account.change_password', 'teacher', 3, 11, 26],
  ['account.change_password', 'admin', 1, 2, 5],
  ['grading.return', 'teacher', 2516, 9870, 23600],
  ['grading.assign', 'teacher', 310, 1205, 2890],
  ['grading.override', 'teacher', 18, 70, 160],
  ['grading.export', 'teacher', 2, 23, 55],
  ['advisor.claim', 'teacher', 65, 260, 620],
  ['advisor.batch', 'teacher', 1, 7, 15],
  ['submission.reopen', 'teacher', 37, 150, 350],
  ['submission.advisor_visibility.enable', 'teacher', 12, 48, 110],
  ['signoff.remind', 'teacher', 9, 33, 80],
  ['item.create', 'admin', 40, 150, 360],
  ['item.publish', 'admin', 35, 128, 300],
  ['item.save_draft', 'admin', 52, 190, 450],
  ['item.update_published', 'admin', 6, 18, 42],
  ['item.deleted', 'admin', 1, 4, 9],
  ['cohort.save_schedule', 'admin', 2, 12, 30],
  ['cohort.activity.create', 'admin', 3, 9, 21],
  ['roster.import', 'admin', 1, 6, 14],
  ['account.approve', 'admin', 28, 110, 260],
  ['account.reject', 'admin', 2, 5, 12],
  ['account.export', 'admin', 0, 2, 4],
  ['group.establish', 'admin', 0, 1, 70],
  ['signoff.version_create', 'admin', 0, 1, 3],
  ['grading.scheme_publish', 'admin', 0, 0, 1],
  ['home.updated', 'admin', 0, 0, 2],
  ['cohort.create', 'admin', 0, 0, 0],
  // 對照表沒有的代碼：畫面要顯示原代碼
  ['experiment.preview_toggle', 'admin', 150, 540, 1300],
].map(([action, role, count7d, count30d, countTerm]) => ({ action, role, count7d, count30d, countTerm }))

const report = { generatedAt: GENERATED_AT, site: 'prod', window: { from: day(DAYS - 1), to: TO }, daily, actions }
fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n')
console.log(`寫入 ${path.relative(process.cwd(), OUT)}：daily ${daily.length} 列、actions ${actions.length} 筆`)
