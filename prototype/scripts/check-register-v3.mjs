/**
 * 註冊 v3 點擊驗收：用 Tailscale 網址實際點完整流程，確認有 hydrate、JS 檔都 200。
 *
 *   BASE_URL=http://mac-mini.tail89e7a6.ts.net:3100 node scripts/check-register-v3.mjs
 *
 * 失敗時以非 0 結束。
 */
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://mac-mini.tail89e7a6.ts.net:3100";
const browser = process.env.CHROME_PATH ? await chromium.launch({ executablePath: process.env.CHROME_PATH }) : await chromium.launch({ channel: "chrome" });
const bad = [];
let jsOk = 0;
const results = [];
const ok = (msg) => { results.push(msg); console.log("✓", msg); };

async function run(viewport) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on("response", (r) => {
    if (!r.url().includes("/_next/static/")) return;
    if (r.status() === 200 || r.status() === 304) jsOk++;
    else bad.push(`${r.status()} ${r.url()}`);
  });
  page.on("pageerror", (e) => bad.push(`pageerror ${e.message}`));
  const tag = `${viewport.width}px`;

  // ① 空白送出：欄位下方要出現錯誤、網址不能變（沒有 hydrate 時會變成 GET 帶 query）
  await page.goto(`${BASE}/register`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "下一步" }).click();
  await page.getByText("請輸入 Email", { exact: true }).waitFor({ timeout: 5000 });
  await page.getByText("請輸入密碼", { exact: true }).waitFor();
  if (new URL(page.url()).search) throw new Error(`送出後網址變了：${page.url()}`);
  ok(`${tag} ① 空白送出 → 顯示「請輸入 Email」「請輸入密碼」`);

  // ① 格式錯誤＋密碼太短
  await page.getByLabel("Email").fill("abc");
  await page.getByLabel("密碼", { exact: true }).fill("short12345");
  await page.getByRole("button", { name: "下一步" }).click();
  await page.getByText("Email 格式不正確，例如 name@mail.fju.edu.tw").waitFor();
  await page.getByText("密碼至少 12 個字元（目前 10 個）").waitFor();
  ok(`${tag} ① 格式錯誤 → 顯示 Email 格式錯誤、密碼至少 12 個字元`);

  // ① 正確 → ②
  await page.getByLabel("Email").fill("yiting.lin@gmail.com");
  await page.getByLabel("密碼", { exact: true }).fill("correct-horse1");
  await page.getByRole("button", { name: "下一步" }).click();
  await page.getByRole("heading", { name: "驗證 Email" }).waitFor();
  ok(`${tag} ① → ② 驗證 Email`);

  // ② 輸入 6 位數 → ③
  await page.getByLabel("驗證碼第 1 位").fill("123456");
  await page.getByRole("button", { name: "驗證", exact: true }).click();
  await page.getByRole("heading", { name: "填學生資料" }).waitFor();
  ok(`${tag} ② → ③ 填學生資料`);

  // ③ 送出 → 待審頁
  await page.getByLabel("姓名").fill("林怡廷");
  await page.getByLabel("學號").fill("411410123");
  await page.getByLabel("系級").fill("資管四甲");
  await page.getByLabel("手機").fill("0912-345-678");
  await page.getByRole("button", { name: "送出" }).click();
  await page.waitForURL(/\/register\/pending/);
  await page.getByRole("heading", { name: "等待系辦審核" }).waitFor();
  await page.getByText("02-2905-2666").first().waitFor();
  ok(`${tag} ③ → 待審頁（電話 02-2905-2666）`);

  // Google → 名單上的帳號 → 已開通
  await page.goto(`${BASE}/register`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "使用 Google 繼續" }).click();
  await page.getByRole("dialog").getByRole("button").nth(1).click();
  await page.getByRole("heading", { name: "填學生資料" }).waitFor();
  ok(`${tag} Google 選帳號 → ③（跳過 ②）`);

  // 登入：打錯密碼
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.getByLabel("Email").fill("411410488@m365.fju.edu.tw");
  await page.getByLabel("密碼", { exact: true }).fill("wrong");
  await page.getByRole("button", { name: "登入", exact: true }).click();
  await page.getByText("Email 或密碼不正確").waitFor();
  ok(`${tag} 登入頁可互動（打錯密碼顯示錯誤）`);

  await ctx.close();
}

try {
  await run({ width: 1440, height: 900 });
  await run({ width: 390, height: 844 });
} finally {
  await browser.close();
}
console.log(`/_next/static 回應 200/304：${jsOk} 個；異常：${bad.length} 個`);
if (bad.length) {
  console.error(bad.join("\n"));
  process.exit(1);
}
