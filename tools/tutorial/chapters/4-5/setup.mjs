#!/usr/bin/env node
// 4-5 段首準備：分鏡的開始前狀態就是乾淨 seed-demo（G02 同意書 5 位學生都同意、輪到陳建宏；G07 學生 3／5），
// reset.sh 之後不用補資料。這支只確認前提成立，不對就停下來，免得錄到不對的畫面。
//   INSTANCE=3 node tools/tutorial/chapters/4-5/setup.mjs
const INSTANCE = process.env.INSTANCE ?? '3'
const BASE = `http://localhost:${3300 + Number(INSTANCE)}`
const res = await fetch(`${BASE}/api/health`)
if (!res.ok) throw new Error(`實例 ${INSTANCE} 的網站沒有回應（${BASE}）；先跑 INSTANCE=${INSTANCE} tools/tutorial/env/up.sh`)
console.log('[4-5 setup] 乾淨 seed-demo 即可，不用補資料')
