# 開發者後台（status/）

獨立的 Next.js 專案（不在根目錄 pnpm workspace，有自己的 lockfile），所以 pnpm 指令一律加 `--ignore-workspace`。`.github/workflows/status.yml` 的 `status-check` 依序跑 typecheck、lint、audit（`pnpm --ignore-workspace audit --audit-level=high`，high 以上漏洞就紅）、test、build、bundle-size（`node scripts/bundle-size.mjs`，量 gzip 後的 First Load JS：共用 230 KB、單路由專屬 30 KB、總量 260 KB，超標或沒先 build 就 exit 1），本機要重現就在 `status/` 目錄先 `pnpm --ignore-workspace run build` 再跑 `node scripts/bundle-size.mjs`。
