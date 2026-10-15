/**
 * 原型第 4 輪點擊驗收＋截圖（第 2 輪的學生 A1～A7、老師 B1～B5、第 3 輪 C2、C3、C5、C6 照舊），桌機 1440 與手機 390（觸控），
 * 淺色、深色各跑一整套（後台深淺色存在 localStorage fju-dash-theme）。第 4 輪改動：
 *   C1 外框顏色回到第 2 輪（淡藍框＋白側欄、深藍「現在」橫幅）；深色＝夜藍外框、深藍橫幅；頁面有大標題
 *   C4 卡片漣漪拿掉；「現在」橫幅的金屬像素拖尾：桌機滑鼠移動會畫、不擋按鈕點擊；手機、減少動態不掛
 *   C7 深色對比：在實際畫面量字色與底色（底色從截圖取像素），內文 4.5:1、大字 3:1；淺色只列出數值
 *
 *   BASE_URL=http://mac-mini.tail89e7a6.ts.net:3100 node scripts/check-roles-v4.mjs
 *   THEMES=dark 只跑深色；ONLY=desktop|mobile 只跑一種寬度
 *
 * 截圖存到 ~/work/proto-shots/roles-v4/（SHOTS_DIR 可改），檔名 student-*-light／-dark、teacher-*-light／-dark。失敗時以非 0 結束。
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://mac-mini.tail89e7a6.ts.net:3100";
const OUT = process.env.SHOTS_DIR ?? join(homedir(), "work/proto-shots/roles-v4");
mkdirSync(OUT, { recursive: true });
const browser = process.env.CHROME_PATH
  ? await chromium.launch({ executablePath: process.env.CHROME_PATH })
  : await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
const bad = [];
let jsOk = 0;
const ok = (msg) => console.log("✓", msg);
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

let THEME = "light";
async function shot(page, name) {
  await page.waitForTimeout(350);
  await page.screenshot({ path: join(OUT, `${name}-${THEME}.png`), fullPage: true });
}

async function newPage(viewport, tag) {
  const mobile = tag === "mobile";
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: mobile ? 2 : 1, hasTouch: mobile, isMobile: mobile });
  await ctx.addInitScript((t) => { try { localStorage.setItem("fju-dash-theme", t); } catch {} }, THEME);
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


/** C1：外框、「現在」橫幅的顏色回到第 2 輪；深色是夜藍外框；頁面有大標題 */
async function checkShell(page, w) {
  /* 顏色一律畫到 canvas 換成 rgb 再比（computed style 可能是 oklch／lab） */
  const look = await page.evaluate(() => {
    const x = document.createElement("canvas").getContext("2d");
    x.fillStyle = getComputedStyle(document.querySelector(".dash-frame")).backgroundColor;
    x.fillRect(0, 0, 1, 1);
    return { frame: [...x.getImageData(0, 0, 1, 1).data.slice(0, 3)], title: !!document.querySelector("h1.page-title"), dark: !!document.querySelector(".dark .dash-frame") };
  });
  const [fr, fg, fb] = look.frame;
  const hero = await pixelAt(page, '[data-region="now"]', 8, 60);
  const [hr, , hb] = hero;
  expect(look.dark === (THEME === "dark"), `主題不是 ${THEME}`);
  if (THEME === "light") expect(fr > 220 && fg > 225 && fb > 240 && fb >= fr, `外框不是第 2 輪的淡藍：rgb(${look.frame})`);
  else expect(fb > fr + 15 && fb < 70 && fr < 40, `深色外框不是夜藍：rgb(${look.frame})`);
  expect(hb > hr + 40 && hr < 40 && hb < 140, `現在橫幅不是深藍：rgb(${hero})`);
  expect(look.title, "頁面沒有大標題 h1.page-title");
  ok(`${w} C1 ${THEME === "light" ? "淡藍外框" : "夜藍外框"} rgb(${look.frame})、深藍現在橫幅 rgb(${hero})、大標題`);
}

/** 截圖取某元素內 (dx, dy) 那一點的實際像素（漸層、半透明都算進去）。解碼用另一頁 about:blank，避開站上 CSP。 */
async function pixelAt(page, sel, dx, dy) {
  const el = page.locator(sel).filter({ visible: true }).first();
  await el.evaluate((n) => n.scrollIntoView({ block: "center" }));
  const box = await el.boundingBox();
  const buf = await page.screenshot({ clip: { x: box.x + dx, y: box.y + dy, width: 1, height: 1 } });
  const dec = await page.context().newPage();
  const px = await dec.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = c.height = 1;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0, 1, 1);
    return [...g.getImageData(0, 0, 1, 1).data.slice(0, 3)];
  }, buf.toString("base64"));
  await dec.close();
  return px;
}

const lum = (rgb) => { const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
const contrastLog = [];

/** C7：sel 的字色對上它背後的實際底色（在元素左邊／上方 bg 偏移處取像素）。深色才擋，淺色只記錄。 */
async function contrast(page, w, label, sel, { min = 4.5, at = [-3, 0.5], bgFrom } = {}) {
  const el = page.locator(sel).filter({ visible: true }).first();
  await el.evaluate((n) => n.scrollIntoView({ block: "center" }));
  const box = await el.boundingBox();
  const [dx, fy] = at;
  const bg = bgFrom ? await pixelAt(page, ...bgFrom) : await pixelAt(page, sel, dx, box.height * fy);
  const fgA = await el.evaluate((n) => {
    const x = document.createElement("canvas").getContext("2d");
    x.fillStyle = getComputedStyle(n).color;
    x.fillRect(0, 0, 1, 1);
    return [...x.getImageData(0, 0, 1, 1).data];
  });
  const a = fgA[3] / 255;
  const fg = fgA.slice(0, 3).map((v, i) => Math.round(v * a + bg[i] * (1 - a)));
  const r = ratio(fg, bg);
  contrastLog.push(`${THEME}\t${w}\t${label}\t${r.toFixed(2)}:1\tfg rgb(${fg}) bg rgb(${bg})`);
  if (THEME === "dark") expect(r >= min, `${label} 對比 ${r.toFixed(2)}:1 < ${min}（fg rgb(${fg})、bg rgb(${bg})）`);
  return r;
}

/** C4：「現在」橫幅的金屬像素拖尾——桌機滑鼠移過會畫、不擋點擊；手機（觸控）與減少動態都不掛 */
async function checkTrail(page, tag, w) {
  const hero = page.locator('[data-region="now"]');
  if (tag === "mobile") {
    /* Playwright 用滑鼠事件點過之後，Chromium 的 hover 媒體查詢會變；用一頁乾淨的觸控分頁檢查 */
    const fresh = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, storageState: await page.context().storageState() });
    const fp = await fresh.newPage();
    await fp.goto(page.url(), { waitUntil: "networkidle" });
    await fp.locator('[data-region="now"]').waitFor();
    expect(await fp.locator("[data-hero-trail]").count() === 0, "手機不該掛像素拖尾");
    await fresh.close();
    ok(`${w} C4 手機（觸控）不掛像素拖尾`);
    return;
  }
  expect(await hero.locator("[data-hero-trail] canvas").count() === 1, "現在橫幅沒有像素拖尾");
  expect(await page.locator(".fx-card, .fx-layer").count() === 0, "卡片漣漪應該拿掉了");
  const box = await hero.boundingBox();
  const before = await hero.screenshot();
  for (let i = 0; i <= 24; i++) await page.mouse.move(box.x + 60 + i * (box.width * 0.5 / 24), box.y + box.height * (0.45 + 0.25 * Math.sin(i / 3)));
  const after = await hero.screenshot();
  expect(!before.equals(after), "滑鼠移過橫幅，畫面沒有出現拖尾");
  // 不擋點擊：橫幅上的連結（看完整時程／繼續評分）在自己的中心點是最上層
  const top = await hero.locator("a").evaluateAll((as) => as.every((a) => { const r = a.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return a.contains(hit); }));
  expect(top, "拖尾擋住了橫幅上的連結");
  expect(await hero.locator("[data-hero-trail]").evaluate((n) => getComputedStyle(n).pointerEvents) === "none", "拖尾層要 pointer-events: none");
  await page.mouse.move(box.x + box.width / 2, box.y - 80);
  const rm = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", storageState: await page.context().storageState() });
  const rp = await rm.newPage();
  await rp.goto(page.url(), { waitUntil: "networkidle" });
  expect(await rp.locator("[data-hero-trail]").count() === 0, "減少動態時不該掛像素拖尾");
  await rm.close();
  ok(`${w} C4 現在橫幅：滑鼠移過畫出像素拖尾、連結可點（pointer-events: none）；減少動態不掛；卡片漣漪已拿掉`);
}

/** C2：右上帳號選單 → 換頭像 → 選第 n 張預設 → 頂列頭像換掉 */
async function changeAvatar(page, name, n) {
  await page.getByRole("button", { name: "帳號選單" }).click();
  await page.getByRole("menuitem", { name: "換頭像" }).click();
  const dlg = page.locator("[data-avatar-dialog]");
  await dlg.waitFor();
  expect(await dlg.getByRole("radio").count() === 12, "預設頭像應有 12 張");
  await dlg.getByRole("button", { name: "上傳照片" }).waitFor();
  await dlg.getByRole("radio", { name: `預設頭像 ${n}` }).click();
  await dlg.getByRole("button", { name: "儲存" }).click();
  await dlg.waitFor({ state: "hidden" });
  const want = `avatar-${String(n).padStart(2, "0")}`;
  await page.waitForFunction(([nm, wnt]) => document.querySelector(`[aria-label="帳號選單"] img[alt="${nm}"]`)?.getAttribute("src")?.includes(wnt), [name, want]);
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

  // 首頁：現在卡（A1 .hero 花紋）、待辦、公告；C3 小月曆已拿掉
  for (const r of ["now", "todo", "news"]) await page.locator(`[data-region="${r}"]`).waitFor();
  expect(await page.locator('[data-region="now"].hero').count() === 1, "現在卡沒有用 .hero 花紋");
  ok(`${w} A1 現在卡用 .hero 花紋`);
  expect(await page.locator('[data-region="calendar"]').count() === 0, "首頁不該再有小月曆");
  ok(`${w} C3 首頁拿掉小月曆`);
  await checkShell(page, w);
  expect(await page.locator('[aria-label="帳號選單"] img[alt="林彥廷"]').count() === 1, "頂列沒有頭像");
  const todoCount = await page.locator('[data-region="todo"] li').count();
  expect(todoCount > 0 && todoCount <= 5, `待辦卡片數量不對：${todoCount}`);
  const newsCount = await page.locator('[data-region="news"] li').count();
  expect(newsCount > 0 && newsCount <= 5, `公告數量不對：${newsCount}`);
  for (const s of ["overdue", "soon", "done"]) expect(await page.locator(`[data-region="todo"] [data-todo="${s}"]`).count() > 0, `首頁待辦缺少 ${s} 狀態`);
  expect(await page.locator("table").count() === 0, "首頁不該有表格");
  ok(`${w} 首頁：現在卡＋待辦 ${todoCount} 張（逾期／快到期／已交都有）＋公告 ${newsCount} 則，沒有表格`);
  await shot(page, `student-${tag}-01-home`);
  await checkTrail(page, tag, w);
  await contrast(page, w, "大標題／面板", "h1.page-title", { min: 3 });
  await contrast(page, w, "現在橫幅小字", '[data-region="now"] p', { at: [-6, 0.5] });
  await contrast(page, w, "現在橫幅階段名（大字）", '[data-region="now"] h2 span', { min: 3, at: [-2, 0.15] });
  await contrast(page, w, "區塊標題右側連結", '[data-region="todo"] a[href$="/affairs"]', { at: [-3, 0.5] });
  for (const st of ["overdue", "soon", "done", "open"]) {
    await contrast(page, w, `待辦卡標題（${st}）`, `[data-todo="${st}"] .line-clamp-2`, { at: [-3, 0.5] });
    await contrast(page, w, `狀態膠囊字（${st}）`, `[data-todo="${st}"] span.rounded-full.h-7`, { at: [5, 0.5] });
  }
  for (const st of ["overdue", "soon"]) await contrast(page, w, `截止相對日（${st}）`, `[data-todo="${st}"] .tabular span span`, { bgFrom: [`[data-todo="${st}"]`, 8, 8] });
  await contrast(page, w, "次要字（截止日）", '[data-todo="open"] .tabular', { at: [-3, 0.5] });
  if (tag === "desktop") await contrast(page, w, "側欄選中項", ".dash-nav-active span", { at: [-4, 0.5] });

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
  const dueDays = page.locator('[data-region="calendar"] [data-due]');
  expect(await dueDays.count() >= 4, "月曆 8 月應標出截止日與活動");
  const aug = await page.locator('[data-region="calendar"] [aria-live] li').allInnerTexts();
  expect(aug.some((t) => t.includes("截止")) && aug.some((t) => t.includes("活動")), `8 月清單要同時有截止與活動：${aug.join("｜")}`);
  await dueDays.first().click();
  await page.locator('[data-region="calendar"] [aria-live] li a').first().waitFor();
  expect(await page.locator('[data-region="calendar"] [aria-live] li').count() < aug.length, "點日期後應只列那天");
  await page.getByRole("button", { name: "下個月" }).click();
  expect(await dueDays.count() >= 1, "月曆 9 月應有標記");
  await page.getByRole("button", { name: "上個月" }).click();
  expect(await page.getByText(/Google/).count() === 0, "不要放 Google 日曆佔位");
  ok(`${w} C3 時程頁＝階段軸＋完整月曆：截止日＋活動、點日期只看那天、可換月，沒有 Google 佔位`);

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
  await filter.getByRole("link", { name: /^待交/ }).click();
  await page.locator('[data-card="mi-014"]').waitFor();

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
  expect(await page.locator("[data-members] img").count() === 5, "組員卡每人要有頭像");
  await page.locator("[data-group-head]").getByText(/讓閒置的教室/).waitFor();
  ok(`${w} C2 組名卡有一句簡介、組員都有插畫頭像`);
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
  expect(await page.locator('[data-advisor] img[alt="陳建宏"]').count() === 1, "老師卡要有頭像");
  ok(`${w} A4 已成組：老師卡直接顯示 Email（mailto）、徽章跟著變`);
  await shot(page, `student-${tag}-11-group-mine-formed`);
  await page.locator("[data-phase-toggle]").getByRole("link", { name: "還沒成組" }).click();
  await page.waitForURL((u) => !u.search.includes("phase"));

  // C2 換頭像：選第 6 張 → 頂列、組員卡都換
  await changeAvatar(page, "林彥廷", 6);
  await shot(page, `student-${tag}-12-avatar-changed`);
  expect((await page.locator('[data-members] img[alt="林彥廷"]').getAttribute("src")).includes("avatar-06"), "組員卡的頭像沒跟著換");
  ok(`${w} C2 換頭像：12 張預設＋上傳照片，選了之後頂列與組員卡一起換`);

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
  await checkShell(page, w);
  expect(await page.locator('[data-region="now"].hero').count() === 1, "老師現在卡沒有 .hero 花紋");
  expect(await page.getByText("繼續評分", { exact: true }).count() === 1, "「繼續評分」應只出現一次");
  expect(await page.locator("[data-todo-card]").count() === 3, "待辦卡應有 3 張");
  expect(await page.locator("table, .recharts-wrapper").count() === 0, "首頁不該有表格或圓環");
  ok(`${w} B1 首頁：現在卡（待評 N 組＋繼續評分一次）、3 張待辦卡、公告，沒有圓環與表格`);
  await shot(page, `teacher-${tag}-01-home`);
  await checkTrail(page, tag, w);
  await contrast(page, w, "老師現在橫幅小字", '[data-region="now"] p', { at: [-6, 0.5] });
  await contrast(page, w, "老師待辦卡標題", '[data-todo-card="待評分"] .text-\\[15px\\]', { at: [-3, 0.5] });
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
  await contrast(page, w, "評分組卡主要按鈕（橘底）", '[data-group-card] a.bg-brand', { at: [4, 0.5] });

  // B3 單組評分（第 07 組是草稿）
  await page.locator('[data-group-card="g-07"]').getByRole("link", { name: "繼續評分" }).click();
  await page.waitForURL("**/grading/g-07");
  await page.locator("[data-position]").getByText("第 3／5 組").waitFor();
  for (const k of ["score", "letter", "pass"]) expect(await page.locator(`[data-criterion="${k}"]`).count() >= 1, `缺少 ${k} 類型的評分項目`);
  expect(await page.locator('[data-criterion="score"] input[type="number"]').count() === 3, "分數制要是數字輸入框");
  expect(await page.locator('[data-criterion="score"] [role="radio"], [data-criterion="letter"] [role="radio"]').count() === 0, "分數、等第不該再是一排按鈕");
  expect(await page.locator('[data-criterion="letter"] select').count() === 1, "等第制要是下拉選單");
  expect(await page.locator('[data-criterion="pass"] [role="radio"]').count() === 2, "通過制應只有 通過／不通過 兩個選項");
  expect(await page.locator('[data-criterion="score"]').first().getByText("／100").count() === 1, "分數框旁要顯示／滿分");
  await page.locator("[data-missing]").getByText("還有 2 項沒填").waitFor();
  await shot(page, `teacher-${tag}-03-grading-group`);
  const q1 = page.getByLabel("問題定義 分數");
  await q1.fill("120");
  await page.locator('[data-criterion="score"]').first().getByRole("alert").getByText("請填 0～100 的分數").waitFor();
  await page.locator("[data-missing]").getByText("還有 3 項沒填").waitFor();
  await shot(page, `teacher-${tag}-03b-grading-out-of-range`);
  await q1.fill("95");
  expect(await page.locator("[data-rubric]").getByRole("alert").count() === 0, "改回範圍內提示要消失");
  ok(`${w} C5 分數超出範圍即時提示（120 → 提示、總分不算），改回 95 提示消失`);
  await page.getByLabel("成果表達 等第").selectOption("A");
  await page.getByRole("radiogroup", { name: "資料安全檢核" }).getByRole("radio", { name: "通過", exact: true }).click();
  expect(await page.locator("[data-missing]").count() === 0, "填完後不該還有「沒填」");
  expect(await page.getByText(/新增項目|編輯項目|調整權重/).count() === 0, "老師不能改評分項目");
  await page.getByRole("button", { name: "正式送出" }).click();
  await page.locator("[data-sent-banner]").waitFor();
  await page.locator("[data-log]").getByText(/送出 [\d.]+ 分/).waitFor();
  await q1.fill("100");
  await page.locator("[data-sent-banner]").getByText("有修改還沒重新送出").waitFor();
  await page.getByRole("button", { name: "重新送出" }).click();
  await page.locator("[data-log]").getByText(/修改後重新送出 [\d.]+ 分/).waitFor();
  expect(await page.locator("[data-log] li").count() <= 3, "紀錄最多 3 行");
  ok(`${w} B3／C5 單組評分：分數輸入框（／100）、等第下拉、通過切換、即時總分與「還有 N 項沒填」、送出 → 改分 → 重新送出，紀錄 ${await page.locator("[data-log] li").count()} 行`);
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
  expect(await page.locator("[data-cards] [data-group-card] img").count() >= 20, "作業區組卡的組員要有頭像");
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

  // 老師也有完整時程頁（同一頁，月曆是老師自己的期限＋系上活動）
  await page.goto(`${T}`, { waitUntil: "networkidle" });
  await page.locator('[data-region="now"]').getByRole("link", { name: /看完整時程/ }).click();
  await page.waitForURL("**/timeline");
  await page.locator('[data-region="calendar"] [data-due]').first().waitFor();
  await shot(page, `teacher-${tag}-11-timeline`);
  ok(`${w} C3 老師「看完整時程」→ 同一頁階段軸＋月曆`);

  // C2 老師換頭像
  await page.goto(`${T}`, { waitUntil: "networkidle" });
  await changeAvatar(page, "陳建宏", 11);
  ok(`${w} C2 老師換頭像`);

  await ctx.close();
}

/* ================================================================ 系辦 */
async function admin() {
  const { ctx, page } = await newPage({ width: 1440, height: 900 }, "desktop");
  await enter(page, "admin");
  await page.locator("main").waitFor();
  expect(!(await page.locator("main").innerText()).includes("主機儲存"), "系辦首頁不該有主機儲存");
  expect(await page.locator(".dash-v3").count() === 0, "系辦這輪不換外框");
  ok("1440px 系辦 C6 首頁沒有主機儲存；外框維持原樣");
  await ctx.close();
}

try {
  for (const theme of (process.env.THEMES ?? "light,dark").split(",")) {
  THEME = theme;
  for (const [vp, tag] of [[{ width: 1440, height: 900 }, "desktop"], [{ width: 390, height: 844 }, "mobile"]].filter(([, t]) => !process.env.ONLY || process.env.ONLY === t)) {
    await student(vp, tag);
    await teacher(vp, tag);
  }
  }
  await admin();
} finally {
  await browser.close();
}
if (bad.length) {
  console.error("✗ 有失敗的資源或錯誤：\n" + bad.join("\n"));
  process.exit(1);
}
console.log("\n對比（實際畫面量測）：\n" + contrastLog.join("\n"));
console.log(`✓ JS／CSS 資源 ${jsOk} 個都 200/304；截圖在 ${OUT}`);
