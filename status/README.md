# 開發者後台（status/）

獨立的 Next.js 專案（不在根目錄 pnpm workspace，有自己的 lockfile），所以 pnpm 指令一律加 `--ignore-workspace`。`.github/workflows/status.yml` 的 `status-check` 依序跑 typecheck、lint、audit（`pnpm --ignore-workspace audit --audit-level=high`，high 以上漏洞就紅）、test、build、bundle-size（`node scripts/bundle-size.mjs`，量 gzip 後的 First Load JS：共用 230 KB、單路由專屬 30 KB、總量 260 KB，超標或沒先 build 就 exit 1），本機要重現就在 `status/` 目錄先 `pnpm --ignore-workspace run build` 再跑 `node scripts/bundle-size.mjs`。

## 已知豁免

`audit` 步驟目前只豁免一條：[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)（high），套件 `braces` <= 3.0.3（現為 3.0.3），路徑 `@next/eslint-plugin-next → fast-glob → micromatch → braces`，只在 lint 開發依賴，不進映像。豁免原因：advisory 沒有修補版（`first_patched_version: null`，npm 最新就是 3.0.3），沒有版本可升。移除條件：braces 出修補版就升級並拿掉 `status.yml` audit 步驟的 `--ignore`，同時刪這一段。追蹤 issue：#570。
