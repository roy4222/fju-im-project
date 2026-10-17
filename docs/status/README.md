# 開發者後台的人維護設定檔（`docs/status/`）

開發者後台（`fju-status.roy422.dev`）大部分資料是自動收集的，只有這四個檔要**工程主腦手動維護**。收集器每 10 分鐘從 GitHub 的 main 抓一次（四個檔一定取自同一個 commit），所以**改完要合併進 main 才會出現在後台**。規格：`docs/plans/2026-10-12-status-console/設計方案.md` §3.4；2026-10-16 起的側欄、總覽、各子頁與新資料檔以 `docs/plans/2026-10-16-status/設計方案.md` 為準（第一版的 AC-S-1～26 仍是既有保證）。

| 檔 | 用在哪一頁 | 什麼時候要改 |
|---|---|---|
| `tickets.json` 票清單 | 開發進度 | 開新票、票換狀態（開工、送審、合併、卡住、不做）、PR 開出來 |
| `test-map.json` 測試地圖設定 | 驗收地圖 | 劇本步驟改號、多了新功能或前台新區塊、劇本「角色」欄出現新寫法 |
| `go-live-policy.json` 上線政策 | 能不能上線（總覽「能不能上線」區、`/go-live`） | `ops/acceptance-night.sh` 的 `PLAN_FULL` 增減項目、劇本步驟表或人設目標數改了 |
| `go-live-waivers.json` 上線豁免 | 能不能上線（同上） | Roy 在對話裡同意某一夜的某個「要修」先不修 |

**改名註記**：頁面「測試地圖」2026-10-16 起改叫「驗收地圖」（DV-1；側欄、`/map` 標題、提示句、`/go-live` G2 連結字都改了）。網址 `/map`、檔名 `test-map.json`、JSON 欄位名都**沒改**，本文件提到檔案時仍照檔名叫「測試地圖設定」。

改完一律跑：

```sh
node docs/status/check.mjs
```

通過印「格式檢查通過」、結束碼 0；有錯會逐條印「哪個檔、哪一筆、哪個欄位、哪裡不對」，結束碼 1。CI（`.github/workflows/status.yml`）也會跑同一行。測試用參數：`--dir <資料夾>` 改檢查別的資料夾裡的四個檔；`--night-script <檔>` 改拿別份夜跑腳本比對。

## 0. 後台有哪些頁、資料從哪來（DV 第 1、2 波合併後的樣子）

### 側欄八項＋外部工具

Roy 定案（Q99）：側欄由原本三頁改成八項，外部工具搬進側欄；淺色／深色跟系統設定（Q98），沒有切換鈕。側欄可收成只剩圖示。

| 順序 | 側欄名稱 | 網址 | 看什麼 | 主要資料檔 |
|---|---|---|---|---|
| 1 | 總覽 | `/` | 由上到下：狀態列（整體狀態、幾分鐘前更新、兩站藥丸）→ KPI 五卡（版本一致、24h 錯誤、備份、主機儲存、CI）→ 兩站 24 小時回應時間圖＋可用率 → 能不能上線五條摘要 → 最近 8 筆事件。不再有入口卡、工具卡、版本卡 | 幾乎全部（`metrics.json` 給圖與 24h 錯誤） |
| 2 | 服務健康 | `/health` | 兩站卡（健康、commit、最近 6 次、原因）、24h 回應時間圖、可用率表（24h／7d／平均回應／失敗次數）、Access 四個網址的守門結果 | `health.json`、`metrics.json`、`collector.json` |
| 3 | 部署與 CI | `/deploy` | 版本卡（三個 SHA 與不一致標黃）**正本**、main 最新 CI、映像 push、健康檢查 cron、兩站最近 5 筆部署 | `github.json`、`vm.json`、`health.json` |
| 4 | 錯誤紀錄 | `/errors` | 收集器六個來源各自成敗、只列失敗類事件（最多 50 筆），每筆一鍵開 Dozzle。容器內的錯誤這版不算，開 Dozzle 搜（Q95 簡單版） | `collector.json` 與事件來源各檔 |
| 5 | 備份與儲存 | `/backup` | 兩站最近一次備份（時間、大小、成敗、上次成功）、異地備份目錄、主機儲存進度條（80%／90% 兩條門檻線）、G4 一句判定 | `vm.json`（`backups`、`disk`） |
| 6 | 使用報表 | `/usage` | 7 天／30 天／本學期、角色篩選、每日活躍人數、最常用前 15 個功能、很少用的功能。**正式站開站、使用報表管線開通（B 階段 DV-B1）之前 `usage.json` 不存在：側欄不出現這項、網址回 404**（Q96） | `usage.json` |
| 7 | 開發進度 | `/progress` | 票清單、批次表、最近 5 個合併的 PR；main CI 只剩一行連到 `/deploy`（Q156） | `repo/tickets.json`、`github.json` |
| 8 | 驗收地圖 | `/map` | 原「測試地圖」，內容不變 | `repo/test-map.json`、`acceptance-index.json` |
| 外部工具 | Dozzle、PgHero、Beszel | 新分頁開啟 | 看 log、資料庫、VM 資源 | — |

`/go-live`（能不能上線詳情）**保留但不進側欄**（Q155）：從總覽「能不能上線」標題點進去，看五條判定的原因清單。

**每個資訊只有一個正本**：版本卡與 main CI 詳情在 `/deploy`、備份與主機儲存在 `/backup`、Gatus 圖與可用率在 `/health`、G1～G5 原因在 `/go-live`、來源成敗與完整事件在 `/errors`；總覽和其他頁只放摘要或連結。

### Roy 定案的顯示規則（Q151～Q157，2026-10-16）

1. **圖表**（Q151）：伺服器端自己畫 SVG，瀏覽器不用多下載任何程式；總覽與 `/health` 共用同一個圖表元件。
2. **正式站尚未開站**（Q152）：`health.json` 正式站不健康，**而且** `vm.json` 查到正式站網域沒有 A 記錄時，總覽狀態列顯示灰字「正式站 尚未開站」，版本一致、24h 錯誤、備份卡都只看測試站；G5 照常紅（它就是要提醒還沒開站）。`/health` 的正式站卡這版不套這條，照實顯示失敗。
3. **24h 錯誤**（Q153）：兩站 Gatus 端點 24 小時內檢查失敗的次數（未開站的正式站不算）；收集器來源失敗不算在這裡，列在事件。
4. **最近事件**（Q154）：七類（部署、備份、來源失敗、健康失敗、CI 失敗、映像 push 失敗、驗收跑完）；總覽 8 筆，`/errors` 只列失敗類、最多 50 筆。
5. **`/go-live`**（Q155）：保留、不進側欄（見上）。
6. **開發進度的 CI 卡**（Q156）：拿掉，改成一行連到 `/deploy`；「最近 5 個合併的 PR」留著。
7. **使用報表「本學期」**（Q157）：從資料最後一天往回找，最近的 2/1 或 8/1 起算到那天。功能代碼的白話對照由工程先填，Roy 看畫面再改字。

### 收集器寫出的資料檔（`STATUS_DATA_DIR`，不用人改）

| 檔 | 內容 | 這批新增的 |
|---|---|---|
| `github.json` | main CI、映像 push、健康檢查 cron、PR 狀態 | — |
| `health.json` | 兩站健康、Access 守門 | — |
| `vm.json` | 部署紀錄、備份、正式站設定檢查、`prodDns` | **`disk`**：主機儲存（總量、已用、可用、百分比、量測時間），量 `STATUS_INBOX_DIR` 所在的磁碟（可用選用的 `STATUS_DISK_PATH` 覆寫）；量失敗時保留上次的值、`diskError` 記錯誤代碼，畫面標灰。**`backups.{test,prod}.lastOk`**：最後一次**成功**備份的時間與大小，後面的失敗備份不會蓋掉它 |
| `metrics.json` | **新檔**（DV-12）：每輪向 Gatus 抓兩站 24 小時回應時間（每 5 分鐘一點）、24h／7d 可用率、24h 平均回應與失敗次數。Gatus 不通時 `gatusOk:false`，保留上次的數字照寫檔，畫面標灰 | 整檔 |
| `usage.json` | **新檔**（型別與頁面已做，DV-7）：使用報表的計數，只有人數與次數，沒有任何帳號、Email、名字。**A 階段收集器還不寫這個檔**，要等 B 階段 DV-B1 開通管線、正式站有人用之後才出現 | 整檔 |
| `acceptance-index.json` | 驗收夜跑索引 | — |
| `collector.json` | 收集器各來源成敗。來源從五個變六個：github、repo、health、vm、acceptance、**metrics** | `metrics` 來源 |
| `repo/*.json` | 本資料夾四個檔的副本 | — |

G5（正式站設定齊全）現在也自動看 `vm.json.prodDns`：沒資料或超過 26 小時→灰「DNS 檢查沒有資料」；沒有 A 記錄→紅；有 A 記錄且設定檢查全過→綠（DV-9）。

## 1. 票清單 `tickets.json`

- `status` 只能是 `todo`（還沒開始）、`doing`（做中）、`review`（送審）、`merged`（已合併）、`blocked`（卡住）、`dropped`（不做）。`blocked`、`dropped` 的 `note` 必填原因；`merged` 一定要有 `pr`。
- `pr` 是 PR 號（整數）或 `null`；`branch` 還沒開分支就寫空字串。`dependsOn` 只能寫檔內有的票號。
- 後台會拿 GitHub 的 PR 狀態比對：GitHub 已合併但這裡沒寫 `merged`（或反過來），那列會標黃提醒你改，**不會自動改檔**。
- 改任何一張票時，順手把最上面的 `updatedAt` 改成現在（台灣時間）。
- 第一段修正沒有 T10：第一段設計方案 §12 的拆票本來就跳過 T10，所以 P1 是 13 張票、對 13 個 PR（#335–#347，`gh pr list` 核對過）。
- 開發者後台這批（S-1～S-9）是 2026-10-12 依拆票表填的初值：第一波 S-1、S-3、S-4、S-9 填 `doing`、分支與 PR 未填；S-2 填 `review`；第二波填 `todo`。各票送審、合併時請更新 `branch`、`pr`、`status`。

## 2. 測試地圖設定 `test-map.json`

三段：

- **`roles`**：四個角色（訪客、學生、老師、系辦）。`aliases` 是驗收報告「角色」欄可能出現的寫法；後台用**完全相等**比對把每一列歸到角色，對不到的會列在驗收地圖頁尾「認不得的角色」。同一個寫法不能同時歸兩個角色（檢查器會擋）。
- **`features`**：功能清單。`roles` 是這個功能該由哪些角色測（不在裡面的格子顯示「不適用」）；`evidence` 是哪個驗收項目的哪幾步算證據（步驟號＝劇本 `## 步驟` 底下的編號）；`e2e` 是對應的自動測試檔（檢查器會確認檔案存在）。步驟號必須在 `go-live-policy.json` 該項目的步驟清單裡，劇本改號後兩邊一起改。
- **`sections`**：前台每一區對應哪個管理後台頁、後台能不能新增／編輯／刪除（`crud` 只能寫 `有`、`無`、`只能下架`、`程式寫死`）。`adminPage` 是 `null` 又沒寫 `exception` 的列，後台會整列標紅「Q12：前台有這區但沒有後台」——這是故意的，代表真的還缺後台。

### 初版怎麼填的

- 功能與證據步驟：依 main（`7162644`）的 `e2e/acceptance/story-1`～`story-6` 劇本步驟表。任務單寫「五個劇本」，main 上已有第 6 章（CSV 與越權），一併納入。
- 前台各區：依 `F-前台後台對照CSV與UX主題.md` 第 1 題「首頁各內容區」與「前台各頁」兩張表，再補上 P1-T9 之後首頁多出來的「近期活動」。
  - 系辦聯絡卡、快速入口：標 Q18 例外（用程式改，不做後台）。
  - 首頁大圖與標語：Q18 說要做「首頁設定」後台，但現在還沒有，所以照實標「程式寫死」、不標例外（會顯示紅）。
  - 歷屆專題、優秀專題、榮譽榜：2026-10-16 改：精選後台可發布、下架、刪除，榮譽走專題事務，照實標。
  - 「各頁頁首標題與說明文字」：F 表列為寫死；Q18 的例外沒提到它，先照實列（會顯示紅），見下方待決定第 3 點。
  - 登入、註冊、帳號、403 頁不是內容；頁尾在 Q12 規則裡排除；都不列。

### 2026-10-16 修正 19 列（DV-10）

- 7 列原本寫 `adminPage: null`（誤標沒有後台）：歷屆專題、優秀專題、專題內容頁改指 `/dashboard/admin/showcase`（可發布、下架、刪除）；首頁與榮譽榜頁的榮譽兩列改指 `/dashboard/admin/affairs`。三種操作都標「有」。
- 12 列原本寫 `delete: 只能下架`，其實能刪（有 e2e 證明），改成「有」。「已有學生交件的收件項目只能下架」（Q28）是收件項目的規則，不是這 12 列。
- 順帶：`showcase-admin` 功能補上 `web/e2e/showcase-admin.spec.ts`；產學兩列的後台頁從老師端改成 `/dashboard/admin/industry`。`page-headings` 占位列不動（下方待決第 3 點）。

### 尚未對應到任何功能的 e2e 檔

下面這些 `web/e2e/*.spec.ts` 沒有列在任何 `features[].e2e`，驗收地圖看不到它們的結果。這批不處理，留給下一批補對應（依 main `316a426` 盤點：69 個 spec 檔中 34 個沒對到；規格寫的「14 個」是 c0f32bd 時的數字，之後各角色票又新增了檔）：

`admin-audit-search`、`admin-editor-preview`、`admin-grading-rules`、`admin-home-tiles`、`admin-link-opportunity`、`admin-settings-home`、`bulk-approve`、`content-delete-misc`、`deny-not-found`、`featured-filters`、`google`、`grading-scheme-hint`、`hero`、`history-matrix`、`honor-admin`、`honors-entry`、`identity-per-request`、`image-attrs`、`industry-tag`、`item-delete`、`item-pin`、`login-keep-email`、`page-title`、`requirement-template`、`showcase-video`、`smoke`、`student-affairs`、`student-groups`、`student-home`、`student-redirects`、`targeted-reopen`、`teacher-announcements`、`teacher-industry`、`timeline-page`（都在 `web/e2e/`，副檔名 `.spec.ts`）。

重新盤點：

```sh
node -e 'const m=require("./docs/status/test-map.json"),fs=require("fs");const u=new Set(m.features.flatMap(f=>f.e2e||[]));fs.readdirSync("web/e2e").filter(f=>f.endsWith(".spec.ts")).map(f=>"web/e2e/"+f).filter(f=>!u.has(f)).forEach(f=>console.log(f))'
```

### 角色寫法怎麼歸類

從六個劇本與 R1 的步驟標題「（角色：…）」抽出所有寫法，單一角色的全部歸進四類（例如 `系辦林雅婷`→系辦、`學生 s7 陳冠廷（待審核）`→學生、`t1`→老師、`訪客 v2 家長`→訪客），另加角色表的代號（`admin`、`t1`、`t2`、`s1`～`s8`、`v1`～`v3`）與規格範例裡的人設稱呼。

## 待主腦決定

1. **一列寫了好幾個角色**：有些步驟本來就是多人一起做，劇本角色寫成 `訪客 v1、系辦、s1～s7、t1、t2`、`s1、s2、s3、t1、系辦，各自的`、`系辦、學生、老師、訪客` 這種組合（共 28 步：story-1 第 37 步；story-2 第 0、6、8、9、11、22、23、25、34、40、41 步；story-3 第 0、6、19、27、32、34、36、37、39 步；story-4 第 0、31、43、44 步；story-5 第 0 步；story-6 第 0、16 步）。報告「角色」欄若照抄，完全相等比對歸不到任何一類，會出現在「認不得的角色」。沒有硬塞進四類之一。建議做法 A：驗收地圖頁（S-5）遇到 `、` 分隔就拆開逐一比對；B：劇本規定多人步驟的角色欄只寫主角。
2. **10/9 那夜的 `summary.json` 不在這台機器上**（只在 Mac mini 的 `e2e/acceptance/.out/`；這裡只有 `~/work/fju-inputs/驗收-20261009-summary.md`，它沒有角色欄）。請在 Mac mini 跑下面這行，把輸出裡沒出現在 `aliases` 的寫法補進去（或列進第 1 點）：
   ```sh
   jq -r '.items[] | (.steps[]?.角色, .problems[]?.角色) // empty' e2e/acceptance/.out/night-20261009-*/summary.json | sort | uniq -c
   ```
3. **「各頁頁首標題與說明文字」算不算 Q12 要有後台的內容區**：不算的話，在 `page-headings` 那列加 `"exception": "…"`；算的話維持紅色。
4. story-6 第 25 步劇本寫 `（角色：系辦；登入那一列用前面的步驟結果）`，報告實際應寫 `系辦`，已按系辦處理。

## 3. 上線政策 `go-live-policy.json`

- `requiredItems`：上線前最新一夜完整驗收必須跑過的項目，**一定要和 `ops/acceptance-night.sh` 的 `PLAN_FULL` 一模一樣**（目前 18 項，含 `story-6`、`r1-login-limit`）。檢查器直接讀那支腳本的文字比對，多、少、重複都會紅。
- `items`：每個必要項的「證據要齊」條件——
  - `story-*`、`r1-*`：`steps` 是劇本步驟表的全部步驟號（story-4 第 11–22 步劇本寫明不做，所以不列）。
  - `ux-*`：`tasks` 是人設卡「你的目標」底下的目標數。
  - `security-static`：`{}`，只看有沒有跑成功。
- 劇本加步驟、刪步驟、人設目標數改了，這裡要一起改；不改的話，那一夜會因為「步驟不齊」被判紅。

## 4. 上線豁免 `go-live-waivers.json`

- 平常是 `{"waivers": []}`。Roy 在對話裡同意某一夜某個「要修」問題先不修時，加一筆：
  ```json
  { "runId": "night-20261012-2200", "item": "story-2", "problemId": "S2-07",
    "approvedBy": "Roy", "approvedAt": "2026-10-13", "reason": "第二段再修" }
  ```
- 只對那一夜有效（`runId`）；新的一夜重新驗收，要重新問 Roy。後台沒有寫入按鈕，只能改這個檔。
