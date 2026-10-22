# `fingerprints.d/`：每張票一個指紋小檔

`fingerprints.ts` 裡的 `BASE_FINGERPRINTS` 是基底，**不要改它**；要加、改、刪指紋，在這個資料夾放自己的 `<票號>.json`
（`C1-13.json`、子票 `C5-12a.json`、修補票 `C2-22-fix1.json`）。spec 用的 `FINGERPRINTS` 是基底＋小檔合併後的結果；
規則全文見 `docs/plans/2026-10-19-c-總表/D-23-放寬.md` §1。

```json
{
  "ticket": "C1-13",
  "set": { "/dashboard/admin/grading/teachers": "每一組由哪幾位老師評分" },
  "override": { "/dashboard/admin/grading": { "from": "base", "value": "成績總表" } },
  "delete": [{ "key": "/dashboard/admin/signoff", "from": "C1-11" }]
}
```

- `ticket` 必須等於檔名主幹；只認 `ticket`、`set`、`override`、`delete` 四個欄位；值是非空字串。
- `set`：新增一個鍵（不能已在基底、也不能被別的小檔 `set` 過）。要把被刪掉的鍵加回來：`"set": { "<鍵>": { "from": "<刪它的票>", "value": "…" } }`。
- `override`／`delete`：必須寫 `from`——`"base"`＝改基底的值，`"<票號>"`＝改那張（已合進的）票設定的值。`from` 寫檔名主幹的 ASCII 形式（`"C5-15"`，不是 `"⑤-15"`）。
- 同一個鍵只能排成一條鏈（`base` → A → B…）。兩張平行票撞到同一個鍵，後合的那張 CI 會紅（`set` 撞 `set`／分叉），rebase 後把 `from` 改成先合的票就好。
- 撞鍵、格式錯、檔名不合規則一律在 `fingerprints.ts` 被 import 時丟錯（所有用到它的 spec 都載入失敗）。
  先用 `pnpm -C web overlay check` 看三個資料夾、`pnpm -C web overlay print fingerprints` 看合併結果。
- 收尾要把小檔併回基底：`pnpm -C web overlay fold fingerprints` 印出 TS 字面值供貼回（只在沒有開著的 PR 動到小檔時做）。
