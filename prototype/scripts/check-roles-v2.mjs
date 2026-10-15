/**
 * 原型第 2 輪點擊驗收＋截圖（學生 A1～A7、老師 B1～B5），桌機 1440 與手機 390。
 *
 *   BASE_URL=http://mac-mini.tail89e7a6.ts.net:3100 node scripts/check-roles-v2.mjs
 *
 * 截圖存到 ~/work/proto-shots/roles-v2/（SHOTS_DIR 可改），學生 student-*、老師 teacher-*。失敗時以非 0 結束。
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://mac-mini.tail89e7a6.ts.net:3100";
const OUT = process.env.SHOTS_DIR ?? join(homedir(), "work/proto-shots/roles-v2");
mkdirSync(OUT, { recursive: true });
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

async function newPage(viewport, tag) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: tag === "mobile" ? 2 : 1 });
  const page = await ctx.newPage();
  page.on("response", (r) => {
    if (!r.url().includes("/_next/static/")) return;
    if (r.status() === 200 || r.status() === 304) jsOk++;
    else bad.push(`${r.status()} ${r.url()}`);
  });
  page.on("pageerror", (e) => bad.push(`pageerror ${e.message}`));
  return { ctx, page };
}

/** 入口網址：轉址後要停在同一個主機（A6：不能跳到 0.0.0.0） */
async function enter(page, role) {
  await page.goto(`${BASE}/api/proto-role?role=${role}&returnTo=/dashboard/${role}`, { waitUntil: "networkidle" });
  const u = new URL(page.url());
  expect(u.host === new URL(BASE).host && u.pathname === `/dashboard/${role}`, `入口網址轉到了 ${page.url()}`);
}

async function sidebarLabels(page, tag) {
  if (tag === "mobile") {
    await page.getByRole("button", { name: /Toggle Sidebar|切換側欄/ }).first().click();
    await page.waitForTimeout(400);
  }
  const labels = (await page.locator('[data-sidebar="menu-button"]:visible').allInnerTexts()).map((s) => s.trim().replace(/\s*\d+$/, "")).filter(Boolean);
  return labels.filter((l) => l !== "回到前台");
}

/* ================================================================ 學生 */
async function student(viewport, tag) {
  const { ctx, page } = await newPage(viewport, tag);
  const w = `${viewport.width}px 學生`;

  // 訪客看 /timeline → 403
  await page.goto(`${BASE}/timeline`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "專題時程需要登入" }).waitFor();
  ok(`${w} 訪客開 /timeline → 需要登入`);

  // A6 入口網址：轉址留在同一個主機
  await enter(page, "student");
  ok(`${w} A6 /api/proto-role 轉址留在 ${new URL(BASE).host}`);

  // 側欄 3 項（手機要先打開側欄）
  const nav = await sidebarLabels(page, tag);
  expect(JSON.stringify(nav) === JSON.stringify(["首頁", "交作業", "組別"]), `側欄不是 3 項：${JSON.stringify(nav)}`);
  for (const no of ["產學合作", "成績", "時間軸", "同意書", "通知"]) expect(!nav.some((l) => l.includes(no)), `側欄不該有「${no}」`);
  ok(`${w} 側欄只有 首頁｜交作業｜組別`);
  if (tag === "mobile") { await shot(page, `student-${tag}-00-sidebar`); await page.keyboard.press("Escape"); await page.waitForTimeout(300); }

  // 首頁：現在卡（A1 .hero 花紋）、待辦、小月曆（A2）、公告
  for (const r of ["now", "todo", "calendar", "news"]) await page.locator(`[data-region="${r}"]`).waitFor();
  expect(await page.locator('[data-region="now"].hero').count() === 1, "現在卡沒有用 .hero 花紋");
  ok(`${w} A1 現在卡用 .hero 花紋`);
  const dueDays = page.locator('[data-region="calendar"] [data-due]');
  expect(await dueDays.count() >= 2, "月曆 8 月應有截止日打點");
  await dueDays.first().click();
  await page.locator('[data-region="calendar"] [aria-live] li a').first().waitFor();
  await page.getByRole("button", { name: "下個月" }).click();
  expect(await dueDays.count() >= 1, "月曆 9 月應有截止日打點");
  await page.getByRole("button", { name: "上個月" }).click();
  expect(await page.locator('[data-region="calendar"] table').count() === 0, "月曆不是表格");
  ok(`${w} A2 小月曆：截止日打點、點日期列出當天要交的、可換月`);
  const todoCount = await page.locator('[data-region="todo"] li').count();
  expect(todoCount > 0 && todoCount <= 5, `待辦卡片數量不對：${todoCount}`);
  const newsCount = await page.locator('[data-region="news"] li').count();
  expect(newsCount > 0 && newsCount <= 5, `公告數量不對：${newsCount}`);
  for (const s of ["overdue", "soon", "done"]) expect(await page.locator(`[data-region="todo"] [data-todo="${s}"]`).count() > 0, `首頁待辦缺少 ${s} 狀態`);
  expect(await page.locator("table").count() === 0, "首頁不該有表格");
  ok(`${w} 首頁：現在卡＋待辦 ${todoCount} 張（逾期／快到期／已交都有）＋公告 ${newsCount} 則，沒有表格`);
  await shot(page, `student-${tag}-01-home`);

  // 鍵盤：Tab 能走到「看完整時程」
  await page.locator('[data-region="now"]').getByRole("link", { name: /看完整時程/ }).focus();
  expect(await page.evaluate(() => document.activeElement?.textContent?.includes("看完整時程")), "看完整時程拿不到焦點");
  await page.keyboard.press("Enter");
  await page.waitForURL("**/timeline");
  await page.locator(`[data-track="${tag === "mobile" ? "vertical" : "horizontal"}"]`).waitFor();
  expect(await page.locator(`[data-track="${tag === "mobile" ? "vertical" : "horizontal"}"] [data-status="current"]`).count() === 1, "時程頁沒有標出目前階段");
  expect(await page.locator("table").count() === 0, "時程頁不該有表格");
  ok(`${w} 「看完整時程」用鍵盤 Enter → /timeline，標出目前階段`);
  await shot(page, `student-${tag}-02-timeline`);

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
    await shot(page, `student-${tag}-03-affairs-${label}`);
  }
  expect(await page.locator("table").count() === 0, "交作業不該有表格");
  ok(`${w} 交作業：待交／已交／逾期 切換，同意書在待交`);

  // 點進作業詳情：說明、上傳區、繳交歷史
  await filter.getByRole("link", { name: /^待交/ }).click();
  await page.locator('[data-card="mi-012"]').click();
  await page.waitForURL("**/affairs/mi-012");
  await page.getByRole("heading", { name: "作業說明" }).waitFor();
  await page.getByText("拖放或點擊上傳").waitFor();
  ok(`${w} A7 交作業詳情：說明＋上傳區`);
  await shot(page, `student-${tag}-04-item`);
  await page.goto(`${BASE}/dashboard/student/affairs/mi-011?tab=history`, { waitUntil: "networkidle" });
  await page.locator("[data-history] li").first().waitFor();
  ok(`${w} 繳交歷史分頁（卡片時間線）`);
  await shot(page, `student-${tag}-05-item-history`);

  // 同意書卡 → 同意書詳情（全文、同意／不同意）
  await page.goto(`${BASE}/dashboard/student/affairs`, { waitUntil: "networkidle" });
  await page.locator('[data-card="consent"]').click();
  await page.waitForURL("**/affairs/consent");
  await page.getByRole("heading", { name: "條文摘要" }).waitFor();
  await page.getByRole("checkbox").first().check();
  await page.getByRole("button", { name: "我已閱讀並同意" }).waitFor();
  await page.getByRole("button", { name: "不同意" }).waitFor();
  ok(`${w} 同意書詳情：全文＋同意／不同意`);
  await shot(page, `student-${tag}-06-consent`);

  // 組別 3 分頁＋示範切換
  await page.goto(`${BASE}/dashboard/student/groups`, { waitUntil: "networkidle" });
  const tabs = page.locator("[data-group-tabs]");
  expect(JSON.stringify((await tabs.getByRole("link").allInnerTexts()).map((s) => s.trim())) === JSON.stringify(["我的組", "找隊員", "紀錄"]), "組別分頁不是 我的組｜找隊員｜紀錄");
  const toggle = JSON.stringify((await page.locator("[data-phase-toggle] a").allInnerTexts()).map((s) => s.trim()));
  expect(toggle === JSON.stringify(["還沒成組", "已成組"]), `示範切換不是 還沒成組／已成組：${toggle}`);
  for (const word of ["成組期", "組隊", "提案", "系辦處理", "聯絡系辦", "寫信給老師"]) expect(!(await page.locator("main").innerText()).includes(word), `組別頁還有「${word}」`);
  ok(`${w} A3／A5 組別：我的組｜找隊員｜紀錄、示範 還沒成組／已成組，沒有怪詞與系辦說明`);
  await page.locator("[data-members] li").first().waitFor();
  await page.getByLabel("組長").waitFor();
  expect(await page.locator('[data-badges] li[data-done="true"]').count() === 1, "還沒成組應只有 1 個里程碑上色");
  expect(await page.locator('[data-badges] [aria-label="未達成"]').count() === 3, "未達成的里程碑要有灰鎖");
  await shot(page, `student-${tag}-07-group-mine-forming`);
  await tabs.getByRole("link", { name: "找隊員" }).click();
  await page.locator("[data-proposal]").waitFor();
  await page.locator("[data-find]").waitFor();
  await shot(page, `student-${tag}-08-group-team-forming`);
  await page.getByRole("button", { name: "撤回邀請" }).click();
  await page.getByRole("heading", { name: "邀請組員" }).waitFor();
  await page.locator("[data-find]").getByRole("button", { name: "邀請" }).first().click();
  await page.getByRole("button", { name: /送出邀請（1 位）/ }).click();
  await page.getByRole("heading", { name: "目前的邀請" }).waitFor();
  ok(`${w} 找隊員：邀請狀態 → 撤回 → 邀請組員 → 送出`);
  await tabs.getByRole("link", { name: "紀錄" }).click();
  await page.locator('[data-log="events"]').waitFor();
  await page.locator('[data-log="proposals"] article').first().waitFor();
  expect(await page.locator("table").count() === 0, "紀錄不該有表格");
  await shot(page, `student-${tag}-09-group-log-forming`);
  await page.locator("[data-phase-toggle]").getByRole("link", { name: "已成組" }).click();
  await page.waitForURL("**phase=formed**");
  await page.locator('[data-log="events"]').getByText("第 07 組成組").waitFor();
  await tabs.getByRole("link", { name: "找隊員" }).click();
  await page.locator("[data-team-done]").getByRole("heading", { name: "已成組" }).waitFor();
  await shot(page, `student-${tag}-10-group-team-formed`);
  await tabs.getByRole("link", { name: "我的組" }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-badges] li[data-done="true"]').length === 2, null, { timeout: 5000 }).catch(() => { throw new Error("已成組應有 2 個里程碑上色"); });
  await page.locator("[data-advisor]").getByText("陳建宏 老師").waitFor();
  const mail = page.locator("[data-advisor-email]");
  expect((await mail.getAttribute("href")) === "mailto:chen.ch@mail.fju.edu.tw" && (await mail.innerText()).includes("chen.ch@mail.fju.edu.tw"), "老師卡要直接顯示可點的 Email");
  expect(await page.getByText("寫信給老師").count() === 0, "老師卡不該有「寫信給老師」按鈕");
  ok(`${w} A4 已成組：老師卡直接顯示 Email（mailto）、徽章跟著變`);
  await shot(page, `student-${tag}-11-group-mine-formed`);
  await page.locator("[data-phase-toggle]").getByRole("link", { name: "還沒成組" }).click();
  await page.waitForURL((u) => !u.search.includes("phase"));

  await ctx.close();
}

/* ================================================================ 老師 */
async function teacher(viewport, tag) {
  const { ctx, page } = await newPage(viewport, tag);
  const w = `${viewport.width}px 老師`;
  const T = `${BASE}/dashboard/teacher`;

  await enter(page, "teacher");
  const nav = await sidebarLabels(page, tag);
  expect(JSON.stringify(nav) === JSON.stringify(["首頁", "評分", "作業區", "分組總覽"]), `老師側欄不是 4 項：${JSON.stringify(nav)}`);
  ok(`${w} 側欄只有 首頁｜評分｜作業區｜分組總覽（通知只在鈴鐺）`);
  if (tag === "mobile") { await shot(page, `teacher-${tag}-00-sidebar`); await page.keyboard.press("Escape"); await page.waitForTimeout(300); }

  // B1 首頁
  for (const r of ["now", "todo", "news"]) await page.locator(`[data-region="${r}"]`).waitFor();
  expect(await page.locator('[data-region="now"].hero').count() === 1, "老師現在卡沒有 .hero 花紋");
  expect(await page.getByText("繼續評分", { exact: true }).count() === 1, "「繼續評分」應只出現一次");
  expect(await page.locator("[data-todo-card]").count() === 3, "待辦卡應有 3 張");
  expect(await page.locator("table, .recharts-wrapper").count() === 0, "首頁不該有表格或圓環");
  ok(`${w} B1 首頁：現在卡（待評 N 組＋繼續評分一次）、3 張待辦卡、公告，沒有圓環與表格`);
  await shot(page, `teacher-${tag}-01-home`);
  await page.getByRole("button", { name: /通知，/ }).click();
  await page.getByRole("menuitem", { name: "查看全部通知" }).click();
  await page.waitForURL("**/dashboard/teacher/inbox");
  ok(`${w} 鈴鐺（下拉）→ 通知頁`);

  // B2 評分總覽
  await page.goto(`${T}/grading`, { waitUntil: "networkidle" });
  await page.locator("[data-progress]").getByText(/已評\s*3\s*／5\s*組/).waitFor();
  expect(await page.locator("[data-group-card]").count() === 5, "評分總覽應有 5 張組卡");
  for (const [label, n] of [["待評", 1], ["草稿", 1], ["已送出", 3], ["全部", 5]]) {
    await page.locator("[data-filter]").getByRole("button", { name: new RegExp(`^${label}`) }).click();
    await page.waitForFunction((k) => document.querySelectorAll("[data-group-card]").length === k, n);
  }
  expect(await page.locator("table").count() === 0, "評分總覽不該有表格");
  ok(`${w} B2 評分總覽：已評 3／5 組、篩選 全部／待評／草稿／已送出、每組一張卡`);
  await shot(page, `teacher-${tag}-02-grading`);

  // B3 單組評分（第 07 組是草稿）
  await page.locator('[data-group-card="g-07"]').getByRole("link", { name: "繼續評分" }).click();
  await page.waitForURL("**/grading/g-07");
  await page.locator("[data-position]").getByText("第 3／5 組").waitFor();
  for (const k of ["score", "letter", "pass"]) expect(await page.locator(`[data-criterion="${k}"]`).count() >= 1, `缺少 ${k} 類型的評分項目`);
  expect(await page.locator('[data-criterion="pass"] [role="radio"]').count() === 2, "通過制應只有 通過／不通過 兩顆");
  await page.locator("[data-missing]").getByText("還有 2 項沒填").waitFor();
  await shot(page, `teacher-${tag}-03-grading-group`);
  await page.getByRole("radiogroup", { name: "成果表達" }).getByRole("radio", { name: "A", exact: true }).click();
  await page.getByRole("radiogroup", { name: "資料安全檢核" }).getByRole("radio", { name: "通過", exact: true }).click();
  expect(await page.locator("[data-missing]").count() === 0, "填完後不該還有「沒填」");
  await page.getByRole("button", { name: "正式送出" }).click();
  await page.locator("[data-sent-banner]").waitFor();
  await page.locator("[data-log]").getByText(/送出 [\d.]+ 分/).waitFor();
  await page.getByRole("radiogroup", { name: "問題定義" }).getByRole("radio", { name: "100" }).click();
  await page.locator("[data-sent-banner]").getByText("有修改還沒重新送出").waitFor();
  await page.getByRole("button", { name: "重新送出" }).click();
  await page.locator("[data-log]").getByText(/修改後重新送出 [\d.]+ 分/).waitFor();
  expect(await page.locator("[data-log] li").count() <= 3, "紀錄最多 3 行");
  ok(`${w} B3 單組評分：分數／等第／通過三種按鈕、即時總分與「還有 N 項沒填」、送出 → 改分 → 重新送出，紀錄 ${await page.locator("[data-log] li").count()} 行`);
  await shot(page, `teacher-${tag}-04-grading-sent`);
  await page.getByRole("button", { name: "下一組" }).click();
  await page.waitForURL("**/grading/g-05");
  await page.locator("[data-position]").getByText("第 4／5 組").waitFor();
  await page.goto(`${T}/grading`, { waitUntil: "networkidle" });
  await page.locator("[data-progress]").getByText(/已評\s*4\s*／5\s*組/).waitFor();
  ok(`${w} B3 下一組 → 第 4／5 組；總覽變成已評 4／5 組`);

  // B4 作業區
  await page.goto(`${T}/affairs`, { waitUntil: "networkidle" });
  await page.locator("[data-legend]").waitFor();
  const cards = page.locator("[data-cards] [data-group-card]");
  expect(await cards.count() === 5, `作業區應有 5 組卡片，實際 ${await cards.count()}`);
  for (const d of ["done", "missing", "overdue"]) expect(await page.locator(`[data-dot="${d}"]`).count() > 0, `作業區缺少 ${d} 的小方塊`);
  expect(await page.locator("table").count() === 0, "作業區不該有表格");
  await shot(page, `teacher-${tag}-05-work`);
  await page.locator('[data-group-card="g-08"]').click();
  await page.waitForURL("**/affairs/group/g-08");
  await page.locator('[data-items] [data-item="overdue"]').waitFor();
  await page.locator('[data-items] [data-item="done"] a').first().waitFor();
  ok(`${w} B4 各組繳交：每組卡片＋已交／缺交／逾期小方塊，點進去看版本與附件`);
  await shot(page, `teacher-${tag}-06-work-group`);
  await page.goto(`${T}/affairs?tab=consent`, { waitUntil: "networkidle" });
  expect((await page.locator("[data-consent-card]").first().getAttribute("data-consent-card")) === "teacher", "待我同意的同意書要排最前");
  await shot(page, `teacher-${tag}-07-consent`);
  await page.locator('[data-consent-card="teacher"]').first().click();
  await page.waitForURL("**/affairs/signoff/**");
  await page.getByRole("checkbox").first().check();
  await page.getByRole("button", { name: "我已閱讀並同意" }).waitFor();
  await page.getByRole("button", { name: "不同意" }).waitFor();
  await shot(page, `teacher-${tag}-08-consent-ready`);
  await page.goto(`${T}/affairs/signoff/g-07`, { waitUntil: "networkidle" });
  const waiting = await page.locator("[data-waiting]").innerText();
  expect(!waiting.includes("陳建宏") && waiting.includes("林彥廷"), `收集中「還沒回覆」只列學生：${waiting}`);
  ok(`${w} B4 同意書：待我同意排最前、點進去同意／不同意；收集中的「還沒回覆」沒有老師`);
  await page.goto(`${T}/signoff`, { waitUntil: "networkidle" });
  expect(page.url().endsWith("/dashboard/teacher/affairs?tab=consent"), `舊 /signoff 沒轉到作業區：${page.url()}`);

  // B5 分組總覽
  await page.goto(`${T}/groups`, { waitUntil: "networkidle" });
  const mine = page.locator("[data-my-groups] [data-group-card]");
  const before = await mine.count();
  await shot(page, `teacher-${tag}-09-groups`);
  await page.locator("[data-open-groups]").getByRole("button", { name: "擔任指導老師" }).first().click();
  await page.getByRole("button", { name: "確定" }).click();
  await page.waitForFunction((n) => document.querySelectorAll("[data-my-groups] [data-group-card]").length === n, before + 1);
  expect(await page.getByText("認領").count() === 0, "不要用「認領」");
  ok(`${w} B5 我的組別：卡片＋「擔任指導老師」（${before} → ${before + 1} 組）`);
  await page.locator("[data-tabs]").getByRole("link", { name: "合作案" }).click();
  await page.waitForURL("**tab=industry");
  for (const st of ["public", "draft", "unlisted"]) await page.locator(`[data-case="${st}"]`).waitFor();
  const draft = page.locator('[data-case="draft"]');
  await draft.getByRole("button", { name: "連結產學組" }).click();
  await page.locator("[data-link-options]").getByRole("button", { name: /第 10 組/ }).click();
  await draft.locator("[data-linked]").getByText(/G10/).waitFor();
  ok(`${w} B5 合作案：發布中／草稿／已下架，負責老師把第 10 組連到自己的合作案`);
  await shot(page, `teacher-${tag}-10-cases`);
  await page.goto(`${T}/industry`, { waitUntil: "networkidle" });
  expect(page.url().endsWith("/dashboard/teacher/groups?tab=industry"), `舊 /industry 沒轉到分組總覽：${page.url()}`);

  await ctx.close();
}

try {
  for (const [vp, tag] of [[{ width: 1440, height: 900 }, "desktop"], [{ width: 390, height: 844 }, "mobile"]]) {
    await student(vp, tag);
    await teacher(vp, tag);
  }
} finally {
  await browser.close();
}
if (bad.length) {
  console.error("✗ 有失敗的資源或錯誤：\n" + bad.join("\n"));
  process.exit(1);
}
console.log(`✓ JS／CSS 資源 ${jsOk} 個都 200/304；截圖在 ${OUT}`);
