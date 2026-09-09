/**
 * 產生 design-sync 需要的兩個進入點：
 *   .design-sync/generated/entry.ts        — 給 esbuild 打 bundle 用的 barrel
 *   .design-sync/generated/types/index.d.ts — 同一份內容的型別版本（路徑改成相對）
 *
 * 為什麼需要：這個 repo 是 Next.js 應用不是元件庫，沒有 dist、沒有型別輸出。
 * 轉換器要有 `--entry` 才能定位 package 根目錄，元件探索也要有 .d.ts 樹
 * （否則會是 `[ZERO_MATCH] 0 components`）。
 *
 * 新增或移除 src/components/ui/*.tsx 之後必須重跑，否則新元件不會進 bundle。
 *
 * 用法：
 *   node .design-sync/build-entry.mjs
 *   npx tsc -p .design-sync/tsconfig.dts.json    # 產生 types/，再由本腳本補 index.d.ts
 *   node .design-sync/build-entry.mjs --dts-only # tsc 之後補寫 types/index.d.ts
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const UI_DIR = "src/components/ui";
const OUT_DIR = ".design-sync/generated";
const dtsOnly = process.argv.includes("--dts-only");

function collectExports() {
  const lines = [];
  let total = 0;

  for (const file of readdirSync(UI_DIR).filter((f) => f.endsWith(".tsx")).sort()) {
    const src = readFileSync(join(UI_DIR, file), "utf8");
    const names = new Set();

    // export { A, B as C } 區塊
    for (const block of src.matchAll(/export\s*\{([^}]*)\}/g)) {
      for (const raw of block[1].split(",")) {
        const name = raw.trim().split(/\s+as\s+/).pop()?.trim();
        if (name && /^[A-Z][A-Za-z0-9_]*$/.test(name)) names.add(name);
      }
    }
    // export function Xxx / export const Xxx
    for (const m of src.matchAll(/export\s+(?:function|const)\s+([A-Z][A-Za-z0-9_]*)/g)) {
      names.add(m[1]);
    }

    if (names.size) {
      const mod = file.replace(/\.tsx$/, "");
      lines.push({ names: [...names].sort(), mod });
      total += names.size;
    }
  }
  return { lines, total };
}

const header = [
  "// 這個檔案是機器產生的，不要手改。",
  "// 來源：src/components/ui/*.tsx；產生方式：node .design-sync/build-entry.mjs",
];

const { lines, total } = collectExports();
mkdirSync(OUT_DIR, { recursive: true });

if (!dtsOnly) {
  const entry = [
    ...header,
    ...lines.map((l) => `export { ${l.names.join(", ")} } from '@/components/ui/${l.mod}';`),
  ].join("\n");
  writeFileSync(join(OUT_DIR, "entry.ts"), entry + "\n");
  console.log(`✓ ${OUT_DIR}/entry.ts — ${lines.length} 個模組、${total} 個匯出`);
}

// types/ 由 tsc 產生；本腳本只補上 barrel 的宣告檔（路徑由 @/ 改為相對）
const typesDir = join(OUT_DIR, "types");
if (existsSync(typesDir)) {
  const dts = [
    ...header,
    ...lines.map((l) => `export { ${l.names.join(", ")} } from './components/ui/${l.mod}';`),
  ].join("\n");
  writeFileSync(join(typesDir, "index.d.ts"), dts + "\n");
  console.log(`✓ ${typesDir}/index.d.ts`);
} else if (dtsOnly) {
  console.error(`✗ ${typesDir} 不存在 —— 先跑 npx tsc -p .design-sync/tsconfig.dts.json`);
  process.exit(1);
}
