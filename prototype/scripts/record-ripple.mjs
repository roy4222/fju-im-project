/**
 * 原型第 3 輪：錄一段卡片漣漪（約 8 秒）——學生首頁待辦卡、老師評分組卡，滑鼠慢慢掃過。
 *
 *   BASE_URL=http://mac-mini.tail89e7a6.ts.net:3100 node scripts/record-ripple.mjs
 *
 * 輸出 ~/work/proto-shots/roles-v3/ripple.mp4（有 ffmpeg 才轉；沒有就留 .webm）。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://mac-mini.tail89e7a6.ts.net:3100";
const OUT = process.env.SHOTS_DIR ?? join(homedir(), "work/proto-shots/roles-v3");
const TMP = join(tmpdir(), `ripple-${Date.now()}`);
mkdirSync(OUT, { recursive: true });
mkdirSync(TMP, { recursive: true });
const size = { width: 1280, height: 720 };
const browser = process.env.CHROME_PATH ? await chromium.launch({ executablePath: process.env.CHROME_PATH }) : await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());

/** 先登入（不錄），再開一個要錄的分頁 */
const setup = await browser.newContext({ viewport: size });
const sp = await setup.newPage();
await sp.goto(`${BASE}/api/proto-role?role=student&returnTo=/dashboard/student`, { waitUntil: "networkidle" });
const state = await setup.storageState();
await setup.close();

const ctx = await browser.newContext({ viewport: size, storageState: state, recordVideo: { dir: TMP, size } });
const page = await ctx.newPage();

async function sweep(sel, ms) {
  const cards = page.locator(sel);
  const n = await cards.count();
  const t0 = Date.now();
  for (let i = 0; Date.now() - t0 < ms; i = (i + 1) % n) {
    const b = await cards.nth(i).boundingBox();
    await page.mouse.move(b.x + 10, b.y + b.height * 0.3, { steps: 4 });
    await page.mouse.move(b.x + b.width - 10, b.y + b.height * 0.75, { steps: 28 });
    await page.mouse.move(b.x + b.width * 0.4, b.y + b.height * 0.5, { steps: 18 });
  }
  await page.mouse.move(10, 10, { steps: 8 });
}

await page.goto(`${BASE}/dashboard/student`, { waitUntil: "networkidle" });
await page.locator('[data-region="todo"]').scrollIntoViewIfNeeded();
await page.evaluate(() => window.scrollBy(0, -120));
await page.waitForTimeout(400);
await sweep('[data-region="todo"] [data-todo]', 4500);

await page.goto(`${BASE}/api/proto-role?role=teacher&returnTo=/dashboard/teacher/grading`, { waitUntil: "networkidle" });
await page.locator("[data-cards]").scrollIntoViewIfNeeded();
await page.waitForTimeout(300);
await sweep("[data-cards] [data-group-card]", 3500);

await ctx.close();
await browser.close();
const webm = join(TMP, readdirSync(TMP).find((f) => f.endsWith(".webm")));
try {
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", webm, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-movflags", "+faststart", join(OUT, "ripple.mp4")]);
  console.log(`✓ ${join(OUT, "ripple.mp4")}`);
} catch {
  renameSync(webm, join(OUT, "ripple.webm"));
  console.log(`✓ 沒有 ffmpeg，留 ${join(OUT, "ripple.webm")}`);
}
rmSync(TMP, { recursive: true, force: true });
