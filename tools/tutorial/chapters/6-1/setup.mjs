#!/usr/bin/env node
// 6-1 段首準備（錄法 C：不碰 VM，讀 status/fixtures/base/ 的假資料）：確認本機的 status/ 開發伺服器在跑，五個網址暖機到 200。
// 開發伺服器要自己先起（repo 根目錄；不要設 STATUS_DATA_DIR、STATUS_ACCEPTANCE_DIR，才會讀 fixtures）：
//   pnpm -C status install --ignore-workspace --frozen-lockfile
//   (cd status && NEXT_PRIVATE_DISABLE_DEV_OVERLAY_UX=1 STATUS_DEV_BYPASS_ACCESS=1 exec ./node_modules/.bin/next dev --port 3350 --hostname 127.0.0.1) & echo $!
//   錄完只 kill 上面印出的 PID。
//   node tools/tutorial/chapters/6-1/setup.mjs
const base = process.env.STATUS_URL ?? 'http://127.0.0.1:3350'
for (const p of ['/', '/progress', '/go-live', '/map', '/map?f=news&r=visitor']) {
  const res = await fetch(base + p).catch(() => null)
  if (res?.status !== 200) {
    console.error(`[6-1] ${base}${p} 回 ${res?.status ?? '沒有回應'}；先照上面的說明起 status/ 開發伺服器`)
    process.exit(1)
  }
  const html = await res.text()
  if (/@[a-z0-9-]+\.[a-z]/i.test(html.replace(/<[^>]*>/g, ' ').replace(/@(media|import|font-face|keyframes|supports|layer|property|container)\b/g, ''))) {
    console.error(`[6-1] ${p} 的畫面文字裡有像 Email 的字串，停止`)
    process.exit(1)
  }
  console.log(`[6-1] ${p} 200`)
}
