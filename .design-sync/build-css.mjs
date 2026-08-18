/**
 * 產生 design-sync 要上傳的 CSS。
 *
 * 兩件事：
 *  1. 用 Tailwind v4 CLI 把 src/app/globals.css（含品牌 token）編成靜態 CSS。
 *  2. 把 .design-sync/fonts.css 併到最前面 —— 那層負責補上 next/font 在執行期
 *     注入、但 Claude Design 環境沒有的 --font-* 變數。
 *
 * 之所以合併成單一檔案而不是用 @import 串接：轉換器會把 cssEntry 原樣複製成
 * _ds_bundle.css，相對路徑的 @import 在複製後會斷掉（validate 的
 * [CSS_IMPORT_MISSING]）。遠端 @import（Google Fonts）不受影響，仍保留在檔首。
 *
 * 用法：node .design-sync/build-css.mjs
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const OUT = ".design-sync/generated/ds.css";

mkdirSync(".design-sync/generated", { recursive: true });

execFileSync(
  "npx",
  ["@tailwindcss/cli", "-i", "src/app/globals.css", "-o", OUT, "--minify"],
  { stdio: "inherit" },
);

const fonts = readFileSync(".design-sync/fonts.css", "utf8");
const compiled = readFileSync(OUT, "utf8");

// CSS 規範要求 @import 必須在所有其他規則之前，因此字體層整段放到最前面。
writeFileSync(OUT, `${fonts}\n${compiled}`);

console.log(`✓ ${OUT} — 字體層 ${fonts.length}B + Tailwind ${compiled.length}B`);
