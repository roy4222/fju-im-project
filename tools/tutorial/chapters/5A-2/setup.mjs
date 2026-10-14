#!/usr/bin/env node
// 5A-2 段首準備（在 reset.sh 之後跑）：乾淨 seed-demo 已有 4 筆待審、2 筆停用、本屆名單；
// 這裡只產生上傳用的兩個檔案到 ~/work/tutorial-out/chapters/5A-2/fixtures/（不進 repo）：
//   roster.csv   名單 CSV（UTF-8，欄名 student_no、name、cohort、email、department_class，3 筆虛構學生）
//   disable.txt  批次停用 TXT（兩個學號：示範資料裡的 G07 組員黃詩涵、吳柏諺；組長會被擋下，所以不用組長）
//   INSTANCE=3 node tools/tutorial/chapters/5A-2/setup.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const INSTANCE = process.env.INSTANCE ?? '3'
const BASE = `http://localhost:${3300 + Number(INSTANCE)}`
const res = await fetch(`${BASE}/api/health`).catch(() => null)
if (!res?.ok) throw new Error(`實例 ${INSTANCE} 的網站沒有回應（${BASE}）；先跑 INSTANCE=${INSTANCE} tools/tutorial/env/up.sh`)

const dir = path.join(os.homedir(), 'work/tutorial-out/chapters/5A-2/fixtures')
fs.mkdirSync(dir, { recursive: true })
const rows = [
  ['student_no', 'name', 'cohort', 'email', 'department_class'],
  ['411419001', '示範甲', 'DEMO-114', '411419001@demo.invalid', '資管三甲'],
  ['411419002', '示範乙', 'DEMO-114', '411419002@demo.invalid', '資管三甲'],
  ['411419003', '示範丙', 'DEMO-114', '411419003@demo.invalid', '資管三甲'],
]
fs.writeFileSync(path.join(dir, 'roster.csv'), rows.map((r) => r.join(',')).join('\n') + '\n')
fs.writeFileSync(path.join(dir, 'disable.txt'), '411410145\n411410167\n')
console.log(`[5A-2 setup] 名單 CSV 與停用 TXT 已放在 ${dir}`)
