# `budget.d/`：每張票一個打包預算小檔

`budget.json` 是基底，**不要改它**；新路由、改列、刪列都在這個資料夾放自己的 `<票號>.json`
（`C1-13.json`、子票 `C5-12a.json`、修補票 `C2-22-fix1.json`）。`perf:bundle` 讀的是基底＋小檔合併後的結果；
規則全文見 `docs/plans/2026-10-19-c-總表/D-23-放寬.md` §1。

```json
{
  "ticket": "C1-13",
  "set": { "/dashboard/admin/grading/teachers": { "baseline": 223.5, "limit": 246 } },
  "override": {
    "/dashboard/admin/grading": { "from": "base", "value": { "baseline": 245.4, "limit": 250 } },
    "$shared": { "from": "base", "value": { "baseline": 222, "limit": 230 } }
  },
  "delete": [{ "key": "/dashboard/admin/settings", "from": "base" }]
}
```

- `ticket` 必須等於檔名主幹；只認 `ticket`、`set`、`override`、`delete` 四個欄位。
- 路由列的值是 `{ baseline, limit }`，而且 **`limit` 必須等於 `limitFor(baseline)`**（`scripts/perf/limits.mjs`：`ceil(baseline×1.1)`，
  baseline ≤ 250 時封頂 250、超過 250 時不封頂）。基底有 5 列舊值不符這條（`limit` 寫死 250），基底不驗；要 `override` 那幾列就照 `limitFor` 填。
  照 JS 浮點算（例如 100×1.1 會進位成 111），不確定就直接問它：
  `node -e "import('./scripts/perf/limits.mjs').then(m => console.log(m.limitFor(223.5)))"`（在 `web/` 下跑）。
- `set`：新增一列（不能已在基底、也不能被別的小檔 `set` 過）。要把被刪掉的列加回來：`"set": { "<鍵>": { "from": "<刪它的票>", "value": {…} } }`。
- `override`／`delete`：必須寫 `from`——`"base"`＝改基底，`"<票號>"`＝改那張（已合進的）票設定的值。`from` 寫檔名主幹的 ASCII 形式。
- `$shared` 只准 `override`，而且 `limit` 要跟基底一樣（230）——也就是只能改 `$shared.baseline`（C4-11 用）；
  `$comment`、`$rules` 小檔一律不准動，要改請改基底。
- 同一個鍵只能排成一條鏈（`base` → A → B…）。兩張平行票撞到同一個鍵，後合的那張 CI 會紅，rebase 後把 `from` 改成先合的票。
- 撞鍵、格式錯、檔名不合規則：`perf:bundle` exit 1。先用 `pnpm -C web overlay check`、`pnpm -C web overlay print budget` 看。
- 這裡有小檔時 **`perf:bundle --write-baseline` 會拒絕**（它會整份重寫基底）；要重基準先 `pnpm -C web overlay fold budget`
  把小檔併進基底（只在沒有開著的 PR 動到小檔時做）。C4-11 更新 baseline 請用 `override`，不要跑 `--write-baseline`。
