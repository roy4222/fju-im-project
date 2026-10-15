/**
 * 註冊／登入 v2 截圖：每個畫面桌機（1440）＋手機（390）。
 *
 *   BASE_URL=http://localhost:3100 node scripts/shoot-register-v2.mjs
 *
 * 輸出到 ~/work/proto-shots/register-v2/（檔名＝畫面名稱-desktop|mobile.png）。
 * 大部分畫面直接用網址帶狀態；Google 帳號選擇器與打錯密碼要實際點。
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = process.env.BASE_URL ?? "http://localhost:3100";
const OUT = process.env.OUT_DIR ?? join(homedir(), "work/proto-shots/register-v2");

const SHOTS = [
  { name: "01-register-step1-create-account", path: "/register" },
  {
    name: "02-register-google-picker",
    path: "/register",
    act: async (page) => {
      await page.getByRole("button", { name: "使用 Google 繼續" }).click();
      await page.getByRole("dialog").waitFor();
    },
  },
  { name: "03-register-step2-verify-email", path: "/register?step=2&email=yiting.lin@gmail.com" },
  {
    name: "04-register-step2-resend-ready",
    path: "/register?step=2&email=yiting.lin@gmail.com",
    act: async (page) => {
      await page.getByRole("button", { name: "跳過倒數" }).click();
    },
  },
  { name: "05-register-step3-profile-email", path: "/register?step=3&via=email&email=yiting.lin@gmail.com" },
  { name: "06-register-step3-profile-google", path: "/register?step=3&via=google" },
  { name: "07-register-activated", path: "/register?step=done&via=google" },
  { name: "08-pending-reviewing", path: "/register/pending" },
  { name: "09-pending-edited", path: "/register/pending?edited=1" },
  {
    name: "10-pending-editing",
    path: "/register/pending",
    act: async (page) => {
      await page.getByRole("button", { name: "修改資料" }).click();
    },
  },
  { name: "11-pending-rejected", path: "/register/pending?state=rejected" },
  { name: "12-pending-approved", path: "/register/pending?state=approved" },
  { name: "13-login", path: "/login" },
  {
    name: "14-login-wrong-password",
    path: "/login",
    act: async (page) => {
      await page.getByLabel("Email").fill("411410488@m365.fju.edu.tw");
      await page.getByLabel("密碼", { exact: true }).fill("wrong");
      await page.getByRole("button", { name: "登入", exact: true }).click();
      await page.getByText("Email 或密碼不正確").waitFor();
    },
  },
  { name: "15-login-forgot-password", path: "/login?mode=forgot&email=411410488@m365.fju.edu.tw" },
  { name: "16-login-reset-sent", path: "/login?mode=sent&email=411410488@m365.fju.edu.tw" },
  { name: "17-privacy", path: "/privacy" },
];

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
];

mkdirSync(OUT, { recursive: true });
// 有裝 Chrome 用 Chrome；沒有就用 CHROME_PATH（例如 Playwright 快取裡的 Chrome for Testing）
const browser = process.env.CHROME_PATH ? await chromium.launch({ executablePath: process.env.CHROME_PATH }) : await chromium.launch({ channel: "chrome" });
const only = process.argv.slice(2);

for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 2, reducedMotion: "reduce" });
  for (const s of SHOTS) {
    if (only.length && !only.some((o) => s.name.includes(o))) continue;
    const page = await ctx.newPage();
    await page.goto(BASE + s.path, { waitUntil: "networkidle" });
    // 原型操作列與 Next 開發指示器會擋住畫面，截圖時藏起來
    await page.addStyleTag({ content: ".fixed.right-4.bottom-4, nextjs-portal { display: none !important; }" });
    if (s.act) await s.act(page);
    await page.waitForTimeout(300);
    const file = join(OUT, `${s.name}-${vp.name}.png`);
    await page.screenshot({ path: file, fullPage: !s.name.includes("picker") });
    console.log("✓", file);
    await page.close();
  }
  await ctx.close();
}
await browser.close();
