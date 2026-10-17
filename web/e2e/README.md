# e2e 共用規則

e2e 全部 spec 共用同一個資料庫、同一個 app 程序、同一組共用帳號（`sharedTestSession`）。
下面這幾條是「一個 spec 不能把狀態留給下一個 spec」的規則（SH-B10）。

## 改業務鐘的 spec 一定要撥回

業務鐘（`business_clock_overrides`）是全站狀態：最新一筆說「今天」是哪一天，所有角色、所有頁都照它算。

- 只要把鐘設到**不是現在**的時間（經 `/dashboard/admin/clock`，或直接 `insert into business_clock_overrides`），
  就必須在 `finally` 或 `afterAll` 把它撥回真實時間；斷言失敗也要撥回，所以不能寫在測試本體最後一行。
- 撥回時用**當下**的時間（`new Date()`／`now()`），不要用檔案載入時記下的 `now`：跑久了會差好幾分鐘。
- 只在 `beforeAll` 寫一筆 `now(), now()`（讓鐘對齊真實時間）的不算改鐘，不用撥回。

2026-10-17 核對：設成非現在時間的只有 `timeline.spec.ts`（`afterAll` 撥回）與
`student-groups.spec.ts`（`finally`＋`afterAll` 撥回）；其餘寫這張表的 spec 都只寫 `now()`。

## 上傳限速：`UPLOAD_RATE_MAX`

上傳限速是每個使用者 20 次／10 分鐘（契約 03 §6），計數放在 app 程序的記憶體裡。
e2e 的共用帳號跨 spec 一路上傳，`signoff.spec.ts`、`showcase*.spec.ts` 連跑就會超過 20 次而拿到 429。

- 跑 e2e 時在**起 app 的那個程序**（`next start`）設 `UPLOAD_RATE_MAX=1000`；只掛在 `playwright test` 指令上沒有用。
- 沒設、或不是正整數（`abc`、`0`、`2.5`…）一律當 20，打錯不會變成關掉限速。
- 正式站與測試站不要設。

## 頁面指紋放在 `fingerprints.ts`

「有權限才看得到的一段字」只放在 `fingerprints.ts` 一處：否定斷言（回應裡不該有這一頁的內容）
與正向斷言（轉過去的頁真的是它）都從那裡拿。頁面文字改了，`pages.spec.ts` 的反向對照會先紅，改那一處就好。
