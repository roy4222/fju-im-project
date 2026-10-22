# `sql-expect.d/`：每張票一個查詢數期望小檔

`sql-expect.json` 是基底，**不要改它**；新路由、改列都在這個資料夾放自己的 `<票號>.json`
（`C1-13.json`、子票 `C5-12a.json`、修補票 `C2-22-fix1.json`）。`perf:sql --expect` 讀的是基底＋小檔合併後的結果；
規則全文見 `docs/plans/2026-10-19-c-總表/D-23-放寬.md` §1。

```json
{
  "ticket": "C1-13",
  "set": { "/dashboard/admin/grading/teachers": { "as": "admin", "baseline": 9, "max": 9, "identity": 0 } },
  "override": { "/dashboard/admin/grading": { "from": "base", "value": { "as": "admin", "baseline": 15, "max": 15, "identity": 0, "noDuplicate": ["select …"] } } },
  "delete": [{ "key": "/dashboard/admin/settings", "from": "base" }]
}
```

- `ticket` 必須等於檔名主幹；只認 `ticket`、`set`、`override`、`delete` 四個欄位。
- 列的值是 `{ as, baseline, max, identity, noDuplicate? }`（`noDuplicate` 是簽名前綴的字串陣列），不准多欄位。
- `set`：新增一列（不能已在基底、也不能被別的小檔 `set` 過）。要把被刪掉的列加回來：`"set": { "<鍵>": { "from": "<刪它的票>", "value": {…} } }`。
- `override`／`delete`：必須寫 `from`——`"base"`＝改基底，`"<票號>"`＝改那張（已合進的）票設定的值。`from` 寫檔名主幹的 ASCII 形式。
- `$comment` 小檔一律不准動，要改請改基底。
- 同一個鍵只能排成一條鏈（`base` → A → B…）。兩張平行票撞到同一個鍵，後合的那張 CI 會紅，rebase 後把 `from` 改成先合的票。
- 撞鍵、格式錯、檔名不合規則：`perf:sql --expect` exit 1。先用 `pnpm -C web overlay check`、`pnpm -C web overlay print sql-expect` 看。
- 收尾要把小檔併回基底：`pnpm -C web overlay fold sql-expect`（只在沒有開著的 PR 動到小檔時做）。
- `sql-expect.timeline-*.json` 沒有票改；若要用同一套，小檔放在它旁邊的 `<檔名>.d/`（`--expect` 給哪個檔就找哪個資料夾）。
