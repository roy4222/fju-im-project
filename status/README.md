# 開發者後台（status/）

獨立的 Next.js 專案（不在根目錄 pnpm workspace，有自己的 lockfile），所以 pnpm 指令一律加 `--ignore-workspace`。`.github/workflows/status.yml` 的 `status-check` 依序跑 typecheck、lint、audit-gate test、audit（high 以上漏洞就紅，已知豁免見下）、test、build、bundle-size（`node scripts/bundle-size.mjs`，量 gzip 後的 First Load JS：共用 230 KB、單路由專屬 30 KB、總量 260 KB，超標或沒先 build 就 exit 1），本機要重現就在 `status/` 目錄先 `pnpm --ignore-workspace run build` 再跑 `node scripts/bundle-size.mjs`。

## 已知豁免

`audit` 步驟先取 `pnpm --ignore-workspace audit --audit-level high --json` 的完整輸出，再交給 `scripts/audit-gate.mjs`。pnpm 有漏洞時本來就會非零結束，因此只容許收集 JSON 的指令非零；最終結果由 gate 決定。不用 `pnpm audit --ignore`，因為 pnpm 11 寫入豁免後直接 exit 0，會漏掉其他漏洞。

gate 採 fail closed，先驗證整份報告，再判斷嚴重度：

- 空輸出、非合法 JSON、讀檔失敗、頂層不是物件，或頂層含 `error` 欄位（即使值是 `null`／`false`）都 exit 1。
- `advisories` 必須是非 null、非陣列物件，每筆 advisory 也必須是物件。
- 每筆 `severity` 必須是 `info`、`low`、`moderate`、`high`、`critical` 其中之一；缺少或未知值都 exit 1。
- 每筆至少有 `github_advisory_id` 或 `url`；有提供的欄位都必須是非空字串，否則 exit 1。豁免只精確比對 GHSA ID 或完整 `https://github.com/advisories/<ID>`，兩者都有時必須同時命中同一條；URL 只含相似字串不算豁免。
- 任一未豁免的 high／critical 都 exit 1；沒有漏洞、只有豁免那條或更低嚴重度才 exit 0。豁免不會略過格式驗證，也不會略過其他紀錄。

豁免清單只在 `scripts/audit-gate.mjs` 的 `EXEMPT` 維護，目前只有 [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)（high），套件 `braces` <= 3.0.3（鎖檔為 3.0.3），路徑 `@next/eslint-plugin-next → fast-glob → micromatch → braces`，只在 lint 開發依賴，不進映像。原豁免理由是當時尚無修補版；2026-10-17 本輪真鎖檔 audit 已回報 `patched_versions: >=3.0.4`。本輪依任務保留這一條暫時豁免，升級鎖檔並驗證後，應從 `EXEMPT` 移除該 ID、更新豁免測試及本段。追蹤 issue：[#570](https://github.com/roy4222/fju-im-project/issues/570)。

CI 在 audit 前跑 `node --test scripts/audit-gate.test.mjs`，涵蓋豁免混入其他 high／critical、異常 JSON 結構、缺欄位、錯誤報告與正常情況。本機在 `status/` 目錄執行相同命令；檢查既有報告可用 `node scripts/audit-gate.mjs /path/to/audit.json`，不給檔名則讀 stdin。
