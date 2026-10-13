#!/usr/bin/env node
// 5A-4 段首準備：分鏡的開始前狀態是乾淨 seed-demo＋模擬業務鐘在真實時間（reset.sh 會清），
// reset.sh 之後不用補資料。這支只確認前提成立，不對就停下來，免得錄到不對的畫面。
//   INSTANCE=3 node tools/tutorial/chapters/5A-4/setup.mjs
const INSTANCE = process.env.INSTANCE ?? '3'
const BASE = `http://localhost:${3300 + Number(INSTANCE)}`
const res = await fetch(`${BASE}/api/health`)
if (!res.ok) throw new Error(`實例 ${INSTANCE} 的網站沒有回應（${BASE}）；先跑 INSTANCE=${INSTANCE} tools/tutorial/env/up.sh`)
console.log('[5A-4 setup] 乾淨 seed-demo 即可，不用補資料')
