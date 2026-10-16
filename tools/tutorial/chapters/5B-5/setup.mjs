#!/usr/bin/env node
// 5B-5 段首準備：乾淨 seed-demo（reset.sh 剛跑完）就夠，不用補資料（示範 JPG 就在這個資料夾；段尾自己按「恢復預設」）；這裡只確認自己的實例在跑。
//   INSTANCE=4 node tools/tutorial/chapters/5B-5/setup.mjs
const base = `http://localhost:${3300 + Number(process.env.INSTANCE ?? 4)}`
const res = await fetch(`${base}/api/health`).catch(() => null)
if (!res?.ok) {
  console.error(`[5B-5] ${base} 沒有回應；先跑 INSTANCE=n tools/tutorial/env/up.sh`)
  process.exit(1)
}
console.log('[5B-5] 不用補資料，可以開錄')
