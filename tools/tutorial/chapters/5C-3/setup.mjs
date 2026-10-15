#!/usr/bin/env node
// 5C-3 段首準備：乾淨 seed-demo（reset.sh 剛跑完）就夠，不用補資料（seed 的 G01 同意書已完成、九組都有成果展示草稿；示範海報 JPG 在這個資料夾）；這裡只確認自己的實例在跑。
//   INSTANCE=4 node tools/tutorial/chapters/5C-3/setup.mjs
const base = `http://localhost:${3300 + Number(process.env.INSTANCE ?? 4)}`
const res = await fetch(`${base}/api/health`).catch(() => null)
if (!res?.ok) {
  console.error(`[5C-3] ${base} 沒有回應；先跑 INSTANCE=n tools/tutorial/env/up.sh`)
  process.exit(1)
}
console.log('[5C-3] 不用補資料，可以開錄')
