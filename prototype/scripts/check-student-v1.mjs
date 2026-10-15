/**
 * 學生後台 v1 點擊驗收＋截圖：側欄 3 項、首頁 3 區、交作業篩選與詳情、同意書詳情、組別 3 分頁與示範切換、前台時程頁。
 *
 *   BASE_URL=http://mac-mini.tail89e7a6.ts.net:3100 node scripts/check-student-v1.mjs
 *
 * 截圖存到 ~/work/proto-shots/student-v1/（SHOTS_DIR 可改）。失敗時以非 0 結束。
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://mac-mini.tail89e7a6.ts.net:3100";
const OUT = process.env.SHOTS_DIR ?? join(homedir(), "work/proto-shots/student-v1");
mkdirSync(OUT, { recursive: true });
/* 有裝 Chrome 用 Chrome，沒有就用 Playwright 自帶的 Chromium */
const browser = process.env.CHROME_PATH
  ? await chromium.launch({ executablePath: process.env.CHROME_PATH })
  : await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
const bad = [];
let jsOk = 0;
const ok = (msg) => console.log("✓", msg);
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

async function shot(page, name) {
  await page.waitForTimeout(350);
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
}

async function run(viewport, tag) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: tag === "mobile" ? 2 : 1 });
  const page = await ctx.newPage();
  page.on("response", (r) => {
    if (!r.url().includes("/_next/static/")) return;
    if (r.status() === 200 || r.status() === 304) jsOk++;
    else bad.push(`${r.status()} ${r.url()}`);
  });
  page.on("pageerror", (e) => bad.push(`pageerror ${e.message}`));
  const w = `${viewport.width}px`;

  // 訪客看 /timeline → 403
  await page.goto(`${BASE}/timeline`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "專題時程需要登入" }).waitFor();
  ok(`${w} 訪客開 /timeline → 需要登入`);

  // 入口網址：切成學生並進後台
  await page.goto(`${BASE}/api/proto-role?role=student&returnTo=/dashboard/student`, { waitUntil: "networkidle" });
  expect(new URL(page.url()).pathname === "/dashboard/student", `入口網址沒進到學生後台：${page.url()}`);

  // 側欄 3 項（手機要先打開側欄）
  if (tag === "mobile") {
    await page.getByRole("button", { name: /Toggle Sidebar|切換側欄/ }).first().click();
    await page.waitForTimeout(400);
  }
  const sidebar = page.locator('[data-sidebar="menu-button"]:visible');
  const labels = (await sidebar.allInnerTexts()).map((s) => s.trim()).filter(Boolean);
  const nav = labels.filter((l) => l !== "回到前台");
  expect(JSON.stringify(nav) === JSON.stringify(["首頁", "交作業", "組別"]), `側欄不是 3 項：${JSON.stringify(labels)}`);
  for (const no of ["產學合作", "成績", "時間軸", "同意書", "通知"]) expect(!nav.some((l) => l.includes(no)), `側欄不該有「${no}」`);
  ok(`${w} 側欄只有 首頁｜交作業｜組別`);
  if (tag === "mobile") { await shot(page, `${tag}-00-sidebar`); await page.keyboard.press("Escape"); await page.waitForTimeout(300); }

  // 首頁 3 區
  for (const r of ["now", "todo", "news"]) await page.locator(`[data-region="${r}"]`).waitFor();
  const todoCount = await page.locator('[data-region="todo"] li').count();
  expect(todoCount > 0 && todoCount <= 5, `待辦卡片數量不對：${todoCount}`);
  const newsCount = await page.locator('[data-region="news"] li').count();
  expect(newsCount > 0 && newsCount <= 5, `公告數量不對：${newsCount}`);
  for (const s of ["overdue", "soon", "done"]) expect(await page.locator(`[data-region="todo"] [data-todo="${s}"]`).count() > 0, `首頁待辦缺少 ${s} 狀態`);
  expect(await page.locator("table").count() === 0, "首頁不該有表格");
  ok(`${w} 首頁：現在卡＋待辦 ${todoCount} 張（逾期／快到期／已交都有）＋公告 ${newsCount} 則，沒有表格`);
  await shot(page, `${tag}-01-home`);

  // 鍵盤：Tab 能走到「看完整時程」
  await page.locator('[data-region="now"]').getByRole("link", { name: /看完整時程/ }).focus();
  expect(await page.evaluate(() => document.activeElement?.textContent?.includes("看完整時程")), "看完整時程拿不到焦點");
  await page.keyboard.press("Enter");
  await page.waitForURL("**/timeline");
  await page.locator(`[data-track="${tag === "mobile" ? "vertical" : "horizontal"}"]`).waitFor();
  expect(await page.locator(`[data-track="${tag === "mobile" ? "vertical" : "horizontal"}"] [data-status="current"]`).count() === 1, "時程頁沒有標出目前階段");
  expect(await page.locator("table").count() === 0, "時程頁不該有表格");
  ok(`${w} 「看完整時程」用鍵盤 Enter → /timeline，標出目前階段`);
  await shot(page, `${tag}-02-timeline`);

  // 鈴鐺 → 通知頁
  await page.goto(`${BASE}/dashboard/student`, { waitUntil: "networkidle" });
  await page.getByRole("link", { name: /通知，/ }).click();
  await page.waitForURL("**/dashboard/student/inbox");
  ok(`${w} 鈴鐺 → 通知頁`);

  // 交作業：篩選
  await page.goto(`${BASE}/dashboard/student/affairs`, { waitUntil: "networkidle" });
  const filter = page.locator("[data-filter]");
  for (const [label, expectIds] of [["待交", ["mi-014", "consent"]], ["已交", ["mi-013"]], ["逾期", ["mi-015"]]]) {
    await filter.getByRole("link", { name: new RegExp(`^${label}`) }).click();
    await page.waitForFunction((l) => document.querySelector('[data-filter] [aria-current="page"]')?.textContent?.startsWith(l), label);
    for (const id of expectIds) await page.locator(`[data-card="${id}"]`).waitFor();
    await shot(page, `${tag}-03-affairs-${label}`);
  }
  expect(await page.locator("table").count() === 0, "交作業不該有表格");
  ok(`${w} 交作業：待交／已交／逾期 切換，同意書在待交`);

  // 點進作業詳情：說明、上傳區、繳交歷史
  await filter.getByRole("link", { name: /^待交/ }).click();
  await page.locator('[data-card="mi-012"]').click();
  await page.waitForURL("**/affairs/mi-012");
  await page.getByRole("heading", { name: "作業說明" }).waitFor();
  await page.getByText("拖放或點擊上傳").waitFor();
  ok(`${w} 作業詳情：說明＋上傳區`);
  await shot(page, `${tag}-04-item`);
  await page.goto(`${BASE}/dashboard/student/affairs/mi-011?tab=history`, { waitUntil: "networkidle" });
  await page.locator("[data-history] li").first().waitFor();
  ok(`${w} 繳交歷史分頁（卡片時間線）`);
  await shot(page, `${tag}-05-item-history`);

  // 同意書卡 → 同意書詳情（全文、同意／不同意）
  await page.goto(`${BASE}/dashboard/student/affairs`, { waitUntil: "networkidle" });
  await page.locator('[data-card="consent"]').click();
  await page.waitForURL("**/affairs/consent");
  await page.getByRole("heading", { name: "條文摘要" }).waitFor();
  await page.getByRole("checkbox").first().check();
  await page.getByRole("button", { name: "我已閱讀並同意" }).waitFor();
  await page.getByRole("button", { name: "不同意" }).waitFor();
  ok(`${w} 同意書詳情：全文＋同意／不同意`);
  await shot(page, `${tag}-06-consent`);

  // 組別 3 分頁＋示範切換
  await page.goto(`${BASE}/dashboard/student/groups`, { waitUntil: "networkidle" });
  const tabs = page.locator("[data-group-tabs]");
  expect(JSON.stringify((await tabs.getByRole("link").allInnerTexts()).map((s) => s.trim())) === JSON.stringify(["我的組", "組隊", "紀錄"]), "組別分頁不是 我的組｜組隊｜紀錄");
  await page.locator("[data-members] li").first().waitFor();
  await page.getByLabel("組長").waitFor();
  expect(await page.locator('[data-badges] li[data-done="true"]').count() === 1, "成組期應只有 1 個里程碑上色");
  await shot(page, `${tag}-07-group-mine-forming`);
  await tabs.getByRole("link", { name: "組隊" }).click();
  await page.locator("[data-proposal]").waitFor();
  await page.locator("[data-find]").waitFor();
  await shot(page, `${tag}-08-group-team-forming`);
  await page.getByRole("button", { name: "撤回提案" }).click();
  await page.getByRole("heading", { name: "發起提案" }).waitFor();
  await page.locator("[data-find]").getByRole("button", { name: "邀請" }).first().click();
  await page.getByRole("button", { name: /送出提案（邀請 1 位）/ }).click();
  await page.getByRole("heading", { name: "目前的提案" }).waitFor();
  ok(`${w} 組隊：提案邀請狀態 → 撤回 → 發起提案 → 送出`);
  await tabs.getByRole("link", { name: "紀錄" }).click();
  await page.locator('[data-log="events"]').waitFor();
  await page.locator('[data-log="proposals"] article').first().waitFor();
  expect(await page.locator("table").count() === 0, "紀錄不該有表格");
  await shot(page, `${tag}-09-group-log-forming`);
  await page.locator("[data-phase-toggle]").getByRole("link", { name: "已成組" }).click();
  await page.waitForURL("**phase=formed**");
  await page.locator('[data-log="events"]').getByText("正式成立").waitFor();
  await tabs.getByRole("link", { name: "組隊" }).click();
  await page.locator("[data-team-done]").getByRole("heading", { name: "已完成組隊" }).waitFor();
  await shot(page, `${tag}-10-group-team-formed`);
  await tabs.getByRole("link", { name: "我的組" }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-badges] li[data-done="true"]').length === 2, null, { timeout: 5000 }).catch(() => { throw new Error("已成組應有 2 個里程碑上色"); });
  await page.locator("[data-advisor]").getByText("陳建宏 老師").waitFor();
  ok(`${w} 組別：我的組｜組隊｜紀錄，示範切換已成組 → 組隊顯示「已完成組隊」、徽章與老師卡跟著變`);
  await shot(page, `${tag}-11-group-mine-formed`);
  await page.locator("[data-phase-toggle]").getByRole("link", { name: "成組期" }).click();
  await page.waitForURL((u) => !u.search.includes("phase"));

  await ctx.close();
}

try {
  await run({ width: 1440, height: 900 }, "desktop");
  await run({ width: 390, height: 844 }, "mobile");
} finally {
  await browser.close();
}
if (bad.length) {
  console.error("✗ 有失敗的資源或錯誤：\n" + bad.join("\n"));
  process.exit(1);
}
console.log(`✓ JS／CSS 資源 ${jsOk} 個都 200/304；截圖在 ${OUT}`);
