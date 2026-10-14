// 1-4 段首準備：訪客段，乾淨 seed-demo 就夠（先跑 INSTANCE=2 tools/tutorial/env/reset.sh）。
// 這裡只確認網站在跑、首頁有分鏡要的公開區塊，不寫任何資料。
const BASE = process.env.TUTORIAL_BASE ?? 'http://localhost:3302';

const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
if (!health.ok) throw new Error(`網站沒準備好：${JSON.stringify(health)}`);
const html = await fetch(`${BASE}/`).then((r) => r.text());
for (const s of ['最新公告', '近期活動', '優秀專題', '快速入口']) {
  if (!html.includes(s)) throw new Error(`首頁少了「${s}」區塊`);
}
console.log(`1-4 準備完成（網站版本 ${health.commit.slice(0, 7)}）`);
