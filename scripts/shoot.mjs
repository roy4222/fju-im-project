/**
 * 原型截圖工具。用本機已安裝的 Chrome，不下載 Playwright 自帶 browser。
 *
 *   node scripts/shoot.mjs                      # 截全部預設頁面（淺色 + 深色 + 手機）
 *   node scripts/shoot.mjs /dashboard           # 只截指定路徑
 *   node scripts/shoot.mjs /dashboard --dark    # 只截深色
 *
 * 輸出到 screenshots/ （已在 .gitignore）。
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const OUT = join(process.cwd(), "screenshots");

const args = process.argv.slice(2);
const paths = args.filter((a) => a.startsWith("/"));
const onlyDark = args.includes("--dark");
const onlyLight = args.includes("--light");
const noMobile = args.includes("--no-mobile");

const DEFAULT_PATHS = ["/"];
const targets = paths.length ? paths : DEFAULT_PATHS;

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
];

const THEMES = onlyDark ? ["dark"] : onlyLight ? ["light"] : ["light", "dark"];

function slug(p) {
  return p === "/" ? "home" : p.replace(/^\//, "").replace(/\//g, "-");
}

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: "chrome" });

for (const theme of THEMES) {
  for (const vp of VIEWPORTS) {
    if (noMobile && vp.name === "mobile") continue;
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 1,
      locale: "zh-TW",
      timezoneId: "Asia/Taipei",
    });
    // next-themes 從 localStorage 讀 theme，必須在頁面腳本執行前寫入
    await ctx.addInitScript(`localStorage.setItem("theme", "${theme}")`);

    const page = await ctx.newPage();
    for (const p of targets) {
      const url = BASE + p;
      const res = await page.goto(url, { waitUntil: "networkidle" });
      const status = res?.status() ?? 0;
      // 隱藏 Next.js 開發工具指示器，避免出現在截圖角落
      await page
        .addStyleTag({
          content: "nextjs-portal,[data-nextjs-toast]{display:none !important}",
        })
        .catch(() => {});
      const file = join(OUT, `${slug(p)}-${theme}-${vp.name}.png`);
      await page.screenshot({ path: file, fullPage: true });
      console.log(`${status} ${url} [${theme}/${vp.name}] -> ${file}`);
    }
    await ctx.close();
  }
}

await browser.close();
