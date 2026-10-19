# overlay 測試用 fixtures（`test/overlay/merge.test.ts`）

- `ok/`：正常用法（I2-4）。三個小檔同時有 `set`、`override`（`from: base` 與 `from: <票號>`）、`delete`、帶 `from` 的 `set`（把刪掉的鍵加回來）、
  只改 `$shared.baseline`；檔名含子票 `C5-12a.json` 與修補票 `C2-22-fix1.json`。合併結果寫在測試裡。
- `conflict/`：兩個小檔撞同一個鍵（`budget.d` 是 `set` 撞 `set`、`fingerprints.d` 是分叉），給 `perf:bundle --budget` exit 1 與
  `fingerprints.ts` 載入丟錯用（I2-3）。其他單條錯誤直接在測試裡用字串 fixture 餵。
