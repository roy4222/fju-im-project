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
`student-groups.spec.ts`（`finally` 撥回用的是載入時記下的 `now`，靠 `afterAll` 的 `new Date()` 補正）；
其餘寫這張表的 spec 都只寫 `now()`。

## 上傳限速：`UPLOAD_RATE_MAX`

上傳限速是每個使用者 20 次／10 分鐘（契約 03 §6），計數放在 app 程序的記憶體裡。
e2e 的共用帳號跨 spec 一路上傳，`signoff.spec.ts`、`showcase*.spec.ts` 連跑就會超過 20 次而拿到 429。

- 跑 e2e 時在**起 app 的那個程序**（`next start`）設 `UPLOAD_RATE_MAX=1000`；只掛在 `playwright test` 指令上沒有用。
- 沒設、或不是正整數（`abc`、`0`、`2.5`…）一律當 20，打錯不會變成關掉限速。
- 正式站與測試站不要設。

## 頁面指紋放在 `fingerprints.ts`

「有權限才看得到的一段字」只放在 `fingerprints.ts` 一處：否定斷言（回應裡不該有這一頁的內容）
與正向斷言（轉過去的頁真的是它）都從那裡拿。頁面文字改了，`pages.spec.ts` 的反向對照會先紅，改那一處就好。
要加、改、刪指紋不改 `fingerprints.ts` 的基底，放自己的 `fingerprints.d/<票號>.json`（規則見 `fingerprints.d/README.md`）。

## 延遲載入／非同步確認的互動：用 `hold.ts` 卡住再點

「點開才下載」的視窗、選單、表單（`next/dynamic`、`import()`），以及送出後要等伺服器回覆的確認流程（刪除、提交、重新開放），
都要補一支「卡在半路時使用者又點了別的」的測試（CL-7 規則化；同類 3 次：C4-09、FIX-SC1、C3-13）。
範本：`showcase-lazy-honor.spec.ts`。

```ts
import { holdAction, holdChunk } from './hold'

const chunk = await holdChunk(page, '只出現在那個延遲 chunk 的一句字')   // 或 holdAction(page, '/路徑', { abort: true })
try {
  await 觸發鈕A.click()
  await chunk.waitHeld('那個 chunk 沒有開始下載')                         // 有上限、有訊息
  await 觸發鈕A.click()                                                   // 連點同一顆
  await 觸發鈕B.click()                                                   // 再點不同顆（別列的編輯／刪除、選單裡別的項目）
  chunk.release()
  await expect(page.locator('dialog[open]')).toHaveCount(1)               // 只開一個，而且是規格說的那一個
  await page.waitForLoadState('networkidle')
  await expect(page.locator('dialog[open]')).toHaveCount(1)               // 晚到的點擊也沒冒出第二個
  await page.keyboard.press('Escape')
  await expect(觸發鈕).toBeFocused()                                       // 焦點回觸發鈕
} finally {
  await chunk.dispose()                                                   // 失敗也放行、拿掉攔截
}
```

逐條要測：

- **下載或請求期間**：同一顆連點、不同顆交錯點，放行後畫面上只有一個開著的視窗（或一次送出）；按鈕顯示「載入中…／刪除中…」並停用。
- **計時與計數**照點擊當下算，不是照下載完成的時間。
- **中斷**：`holdAction(..., { abort: true })` 放行時讓請求失敗，畫面要回到可以再操作（按鈕恢復、有錯誤訊息、沒留下半開的視窗）。
- **送出中關窗**：結果回來後提示仍看得到（提示不隨被關掉的視窗卸載），焦點回合理的位置。
- `mark` 用只出現在那支延遲檔的字串（錯誤訊息之類），不要用 chunk 檔名（每次 build 都不同）。
