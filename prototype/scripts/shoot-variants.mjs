/**
 * 後台版本評選截圖：4 版本 × 3 角色首頁（桌機淺色），加管理員深色與學生手機。
 *   node scripts/shoot-variants.mjs [路徑…]   預設只截 /dashboard/<role>
 * 輸出 screenshots/variants/
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.BASE_URL ?? "http://localhost:3100";
const OUT = join(process.cwd(), "screenshots", "variants");
mkdirSync(OUT, { recursive: true });
const VARIANTS = (process.env.VARIANTS ?? "grid,timeline,console,navy").split(",");
const ROLES = (process.env.ROLES ?? "student,teacher,admin").split(",");
const extra = process.argv.slice(2).filter((a) => a.startsWith("/"));
const ONLY = process.env.ONLY; // e.g. "admin-dark,student-mobile"

const browser = await chromium.launch({ channel: "chrome" });
const hide = "nextjs-portal,[data-nextjs-toast],[data-prototype-switcher]{display:none !important}";

async function shoot(ctx, url, file) {
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "networkidle" });
  await page.addStyleTag({ content: hide }).catch(() => {});
  await page.waitForTimeout(300);
  await page.screenshot({ path: file, fullPage: true });
  await page.close();
  console.log(file);
}

for (const v of VARIANTS) {
  for (const role of ROLES) {
    const mk = async (vp, dark) => {
      const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1, locale: "zh-TW", timezoneId: "Asia/Taipei" });
      await ctx.addCookies([
        { name: "fju-dash-variant", value: v, url: BASE },
        { name: "fju-role", value: role, url: BASE },
      ]);
      if (dark) await ctx.addInitScript(`localStorage.setItem("fju-dash-theme","dark")`);
      return ctx;
    };
    if (!ONLY) {
      const ctx = await mk({ width: 1440, height: 900 }, false);
      await shoot(ctx, `${BASE}/dashboard/${role}`, join(OUT, `${v}-${role}.png`));
      for (const p of extra) await shoot(ctx, `${BASE}/dashboard/${role}${p}`, join(OUT, `${v}-${role}-${p.replace(/^\//, "").replace(/\//g, "-")}.png`));
      await ctx.close();
    }
    if (role === "admin" && (!ONLY || ONLY.includes("admin-dark"))) {
      const ctx = await mk({ width: 1440, height: 900 }, true);
      await shoot(ctx, `${BASE}/dashboard/admin`, join(OUT, `${v}-admin-dark.png`));
      await ctx.close();
    }
    if (role === "student" && (!ONLY || ONLY.includes("student-mobile"))) {
      const ctx = await mk({ width: 390, height: 844 }, false);
      await shoot(ctx, `${BASE}/dashboard/student`, join(OUT, `${v}-student-mobile.png`));
      await ctx.close();
    }
  }
}
await browser.close();
