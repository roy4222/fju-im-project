/**
 * 原型第 4 輪：錄一段「現在」橫幅的金屬像素拖尾（約 9 秒）——學生首頁淺色 4.5 秒＋老師首頁深色 4.5 秒，
 * 滑鼠在橫幅上畫幾道弧線。兩段分開錄（各自剪掉載入），再用 ffmpeg 接成一支。
 *
 *   BASE_URL=http://mac-mini.tail89e7a6.ts.net:3100 node scripts/record-pixel-trail.mjs
 *
 * 輸出 ~/work/proto-shots/roles-v4/pixel-trail.mp4（需要 ffmpeg）。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://mac-mini.tail89e7a6.ts.net:3100";
const OUT = process.env.SHOTS_DIR ?? join(homedir(), "work/proto-shots/roles-v4");
const TMP = join(tmpdir(), `pixel-trail-${Date.now()}`);
const SEG = 4.5;
mkdirSync(OUT, { recursive: true });
const size = { width: 1280, height: 720 };
const browser = process.env.CHROME_PATH ? await chromium.launch({ executablePath: process.env.CHROME_PATH }) : await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());

/** 錄一段：登入（不錄）→ 開要錄的分頁 → 等橫幅就位 → 滑鼠畫弧 SEG 秒；回傳 [webm, 開始秒數] */
async function take(role, theme, dir) {
  mkdirSync(dir, { recursive: true });
  const setup = await browser.newContext({ viewport: size });
  await (await setup.newPage()).goto(`${BASE}/api/proto-role?role=${role}&returnTo=/dashboard/${role}`, { waitUntil: "networkidle" });
  const state = await setup.storageState();
  await setup.close();

  const ctx = await browser.newContext({ viewport: size, storageState: state, recordVideo: { dir, size } });
  await ctx.addInitScript((t) => { try { localStorage.setItem("fju-dash-theme", t); } catch {} }, theme);
  const page = await ctx.newPage();
  const t0 = Date.now();
  await page.goto(`${BASE}/dashboard/${role}`, { waitUntil: "networkidle" });
  const hero = page.locator('[data-region="now"]');
  await hero.locator("[data-hero-trail] canvas").waitFor();
  await page.mouse.move(5, 5);
  await page.waitForTimeout(500);
  const start = (Date.now() - t0) / 1000;
  const b = await hero.boundingBox();
  const s0 = Date.now();
  for (let k = 0; Date.now() - s0 < SEG * 1000 - 400; k++) {
    for (let i = 0; i <= 50; i++) {
      const t = i / 50;
      const x = b.x + 30 + (k % 2 ? 1 - t : t) * (b.width - 60);
      const y = b.y + b.height * (0.5 + 0.34 * Math.sin(t * Math.PI * (2 + (k % 3)) + k));
      await page.mouse.move(x, y);
      await page.waitForTimeout(14);
    }
  }
  await page.mouse.move(b.x + b.width / 2, b.y - 60, { steps: 6 });
  await page.waitForTimeout(400);
  await ctx.close();
  return [join(dir, readdirSync(dir).find((f) => f.endsWith(".webm"))), start];
}

const [a, as] = await take("student", "light", join(TMP, "a"));
const [b, bs] = await take("teacher", "dark", join(TMP, "b"));
await browser.close();
const out = join(OUT, "pixel-trail.mp4");
execFileSync("ffmpeg", [
  "-y", "-loglevel", "error",
  "-ss", as.toFixed(2), "-t", String(SEG), "-i", a,
  "-ss", bs.toFixed(2), "-t", String(SEG), "-i", b,
  "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-movflags", "+faststart", out,
]);
rmSync(TMP, { recursive: true, force: true });
console.log(`✓ ${out}`);
