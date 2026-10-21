# 整體架構與資安審查（C ⑤-13，issue #717，AC-57）

- 審查對象：`stage-c` 的 commit `b8efb942336d69e2383cc008d11971d350120eaa`（2026-10-21 15:08，PR #809 合併後）。
- 審查日期：2026-10-21。
- 方法：逐章對照既有結構測試、整合測試、e2e 與 `git grep`；全部指令都可以在 repo 根目錄重跑。外部掃描只對測試站公開網址做 `curl -sI`（只讀標頭），沒有登入、沒有送任何會寫資料的請求、沒有碰主機。
- 本票不改程式。要改的一律列在最後一節「要開的票」，由主腦開票。
- 每一列的「結論」用四個等級：**OK**（有證據、不用動）、**低**（值得記錄，不急）、**中**（建議開票）、**高**（本次沒有發現）。

## 0. 先講結論

整體架構的守門是「每一層都自己認人、自己判狀態」，而且有兩份結構測試把 Server Action 的守門形狀鎖住（SEC-1、SEC-2）。本次逐一讀過結構測試掃不到的 9 條 route handler，沒有找到繞過守門的路。CSP、上傳憑證、私有檔授權、advisory lock 登記、監測與備份都和文件一致。

真正要處理的只有一件事，而且是「一致性」問題、不是漏洞：

1. **重播（requestId 冪等）排在屆別封存檢查之前，是全站的既定寫法**。⑤-12a／12c 把 7 處改成「封存檢查在前」，但其餘約 60 個寫入命令仍是「先重播、後看封存」。後果是：封存前成功過的 requestId，封存後再送一次會拿到原本的成功回執（不會寫入任何資料）。這和 AC-56c 定下的「封存後重播要回 `COHORT_ARCHIVED`」不一致。要請主腦先裁定是「全站統一」還是「只限繳交」，再決定要不要開一張掃全站的票（第 2 節第 3 列）。

其他列在「低」的項目都有記錄位置與理由，不影響上線。

測試站目前**還沒切 Cloudflare 橘雲**（回應沒有 `cf-ray`、`server: cloudflare`，只有 `via: 1.1 Caddy`）。正式站公開網址回 502（還沒部署）。這兩件事都是現況、不是缺陷，驗收夜前要照 `ops/README.md`「Cloudflare（橘雲代理）」那一節做。

## 1. 身分與權限

| 項目 | 證據 | 結論 | 要開的票 |
|---|---|---|---|
| Better Auth 的 HTTP 入口預設拒絕，只放白名單路徑 | `web/src/infrastructure/auth/route-matrix.ts:54`（`ALLOWED_ROUTES`，其餘 403）、`wrapper.ts:26-60`（白名單先於 `toNextJsHandler`）；路由檔只有一行 `web/src/app/api/auth/[...all]/route.ts` | OK | — |
| session 不放 cookie 快取、停用立刻生效；fresh session 10 分鐘 | `auth-instance.ts:459`（`cookieCache: { enabled: false }`）、`:460`（`freshAge`）；身分快取 60 秒但會改身分的入口都 bust：`git grep -n bustIdentity -- web/src ':!*.test.ts'`（帳號命令 5 處、目錄命令、頭像 2 處、個資編輯）；設計說明 `identity-cache.ts:25-32` | OK | — |
| 身分快取是程序內的，多副本要換共用快取 | `identity-cache.ts:29` 已寫明；目前 compose 只有一個 app 容器 | 低（現況單副本；擴副本前要先處理） | — |
| 帳號狀態閘門：停用、去識別化一律當未登入（不給側通道） | `web/src/application/accounts/actor.ts:96-117`（`statusGate`） | OK | — |
| 後台每一頁都走 `requireRole`（角色不對導 `/403`，不是 layout 裡換畫面） | `web/src/app/_ui/guard.ts:79-96`；`git grep -L "requireRole\|requireActor\|requireAdmin\|currentActor\|resolveActor\|requireStudent\|requireTeacher\|requireSigned" -- 'web/src/app/dashboard/**/page.tsx'` 輸出為空（53 頁全有） | OK | — |
| SEC-2：所有 Server Action 逐一登記守門方式 | `web/test/structure/server-action-guard.test.ts`（169 筆登記；本票 verify 跑過 175 個案例全綠）；只掃 `src/app/**` 的 `'use server'`，而 `src/app` 之外沒有 `'use server'`：`git grep -l "'use server'" -- web/src ':!web/src/app/**'` 輸出為空 | OK | — |
| SEC-1：前台編輯 action 的 business 守門形狀 | `web/test/structure/front-edit-actor.test.ts`（55 個案例全綠） | OK | — |
| 結構測試掃不到的繞法：route handler | 9 條：`git ls-files 'web/src/app/api/**/route.ts'`。逐一讀過：4 條匯出 POST 都先同源檢查再認人再授權（`composition/accounts.ts:162-164`、`grade-export.ts:36-38`＋`pg-grade-export.ts:43`、`group-roster.ts:38-40`＋`pg-roster-export.ts:48`、`signoff-export.ts:14-15`＋`pg-signoff.ts:1275`）；下載與預覽共用 `downloadFile`，狀態閘門在查檔之前（`file-storage.ts:431-437`）；上傳先認人、狀態閘門、限速再驗憑證（`composition/files.ts:79-86`）；`/api/health` 不需登入，只回 `ok`／`version`／`commit`／`imageDigest`／`schemaVersion`／`worker`（`shared/health.ts:13-18`），沒有個資 | OK | — |
| route handler 沒有像 SEC-2 那樣的結構登記，新增一條只能靠 review | 同上 9 條；`web/test/structure/` 只有兩份 | 低 | 票 A（低）：把 `app/api/**/route.ts` 也納入結構登記（POST 必須先 `isSameOriginRequest`、進用例前必須經 `resolveActor`）；可改檔案 `web/test/structure/route-handler-guard.test.ts`（新） |
| 匯出一律 POST＋同源檢查（別站一個連結不能替管理員按下去） | `web/src/shared/same-origin.ts:13-40`（`Sec-Fetch-Site` 優先，否則比 `Origin` 與 `Host`） | OK | — |
| 限速：登入（IP＋帳號）、註冊（IP）、Google 入口（IP）、上傳（每人 20 次／10 分鐘）；套件內建的跨帳號共用桶已關 | `sign-in-rate-limit.ts`、`sign-up-rate-limit.ts`、`social-sign-in-rate-limit.ts`、`composition/files.ts:59-65,86`；關掉理由 `auth-instance.ts:329-372` | OK | — |
| Cloudflare 之後的來源 IP 信任 | app 讀 `x-real-ip` 優先（`auth-instance.ts:325`、`login/actions.ts:35`、`sign-in-rate-limit.ts:63`）；Caddy 只在連線來自 Cloudflare 網段時相信 `CF-Connecting-IP`，並一律覆寫 `X-Real-IP`（`ops/Caddyfile.vm:25-26,54,64`）；app 容器不對外發布埠（`docker-compose.vm.yml:93`） | OK | — |
| Cloudflare 網段清單寫死（抓取日 2026-10-19），兩個檔要一起更新 | `ops/Caddyfile.vm:25`、`ops/cloudflare-origin-lock.sh:20,27-34`；README 已寫更新步驟 | 低（維運例行） | — |
| SQL 注入面：全部參數化；字串拼接只用於常數欄位清單與白名單排序鍵 | `git grep -nE '\$\{[^}]+\}' -- web/src/infrastructure ':!*.test.ts' \| grep -iE '\b(select\|insert\|update\|delete\|where\|from\|order by\|values)\b'`：結果都是 `COLUMNS`／`APPLICATION_COLUMNS` 這類常數、`for update` 開關，或白名單對照表（排序 `account-directory-command.ts:270-273` 的 `ORDER_BY[filter.sort]`，`filter.sort` 由 `application/accounts/directory.ts:105` 的 `oneOf` 正規化；屆別旗標欄位 `pg-cohorts.ts:231` 的 `FLAG_COLUMN[flag]`） | OK | — |
| 富文字只存白名單淨化後的 HTML；`dangerouslySetInnerHTML` 只渲染伺服器淨化結果 | `web/src/application/items/rich-text.ts:1-16`（sanitize-html 白名單）；`git grep -n dangerouslySetInnerHTML -- web/src ':!*.test.*'` 7 處，各自的來源都是用例回傳的 `bodyHtml`／`contentHtml`，或帶 nonce 的 GA 初始化腳本 | OK | — |
| 上傳憑證金鑰從 `BETTER_AUTH_SECRET` 以固定標籤導出，拿到 session 簽章也偽造不了憑證 | `web/src/infrastructure/ops/upload-ticket.ts:31-38` | OK | — |

## 2. 資料一致性

| 項目 | 證據 | 結論 | 要開的票 |
|---|---|---|---|
| advisory lock 鍵表與程式一一對得上 | `git grep -n "pg_advisory" -- web/src ':!*.test.ts'` 共 16 處，逐一對上 `docs/engineering/README.md:26-42` 的兩張表（註冊續辦 4、屆別旗標、組別代碼 2、學生 2、規則、資源分類、催繳 1 個取鎖函式、重新開放繳交、營運時鐘、worker 單實例）；雜湊函式也一致 | OK | — |
| 鎖的順序（檔案：`stored_files` → `file_references`；屆別 → 組 → 成員） | `docs/engineering/README.md:19-21` 列的程式位置都存在（`avatar-store.ts:47-59`、`pg-groups.ts:1387`、`registration-command.ts:376`）；「組 → 成員」只是規則、沒有集中檢查 | 低（規則靠 review） | — |
| **重播（requestId 冪等）與屆別封存檢查的順序** | ⑤-12 改成「封存檢查在重播之前」的 7 處：`pg-submissions.ts` 的 `saveDraft`／`submit`／`setAdvisorVisibility`／`reopen`／`setExempt`（用 `#archivedGuard`，例如 `:325-334`）、`file-storage.ts:218-221`（上傳完成）、`pg-consent-bridge.ts:261-265`（同意書補建）。其餘命令仍是「先重播、後看封存」，實際讀過確認的 6 處：`pg-grading.ts:218-231`、`pg-timeline.ts:226-239`、`pg-items.ts:1146-1162`、`pg-groups.ts:993-1006`（`groupWriteBlocked` 在 `replayed` 之後）、`pg-advisors.ts:259-274`（`writeBlocked` 在之後）、`pg-opportunities.ts:562-577`。全站掃法：`git grep -n -A18 'ledger.begin(' -- web/src/infrastructure ':!*.test.ts' \| grep -E "replayed<\|archived\|archivedBlocks\|writeBlocked\|groupWriteBlocked\|#archivedGuard"`，每個 `ledger.begin` 後面 `replayed<` 先出現、封存檢查後出現的都是同一類；grading、timeline、items、groups、advisors、opportunities、signoff、reminders、showcase、cohorts、profile-card、profile-edit、account-command（新增學生）全部如此，約 60 處。後果：封存前成功的 requestId 封存後重送，拿到原本的成功回執、**不寫任何資料**；`archived-readonly.integration.test.ts:863-923`（AC-56c）只對 5 條繳交命令驗「重播回 `COHORT_ARCHIVED`」 | 中（一致性；不是資料外洩或損毀） | 票 B（中）：主腦先裁定「全站統一 AC-56c 的語意」或「只限繳交」。若統一：(1) 一張掃全站的票，把封存檢查搬到 `ledger.begin` 之前（各模組一個 `#archivedGuard` 樣式）；(2) 補一條結構測試：`ledger.begin(` 之前必須已出現封存檢查，反例要紅；(3) `archived-readonly.integration.test.ts` 的 AC-56c `replays` 清單擴到每個模組至少一條。可改檔案：各模組 `pg-*.ts`、`web/test/structure/ledger-order.test.ts`（新）、`archived-readonly.integration.test.ts` |
| 授權在重播之前 | 同一個掃描：每個 `ledger.begin` 所在方法開頭都先 `authorizeAdmin`／`authorizeTeacher`／`authorizeReceiver`／`statusGate`／`prepareGroupChange` 等，只有 4 個私有 helper（`pg-advisors.ts:486`、`pg-group-import.ts:255`、`file-storage.ts:634`、`pg-home-settings.ts:124`）由呼叫端守門 | OK | — |
| 屆別封存唯讀：封存拒絕寫入、鎖序決定先後、解封不延長截止 | `web/src/infrastructure/cohorts/archived-readonly.integration.test.ts`（`:507` 已封存清單涵蓋評分、結算、簽核、催繳、指導、匯入、名單、註冊、個資轉屆、新增學生、繳交、建組；`:817-860` AC-56a／56b 鎖序；`:979` AC-56e）；主腦裁定的維護例外 `:750` | OK | — |
| 封存後仍可讀、可匯出（D-08） | 同檔 `:925`、`:957`、`:970` | OK | — |
| 多路徑寫入同一欄位都帶 `revision`（舊版本存回去回 `CONFLICT`） | 例：`pg-timeline.ts:240`（`cohort.revision !== expectedRevision`）、`pg-groups.ts:1006`（`groupWriteBlocked(..., input.revision)`） | OK | — |

## 3. 檔案與上傳

| 項目 | 證據 | 結論 | 要開的票 |
|---|---|---|---|
| 上傳憑證：HMAC-SHA256、常數時間比對、有效期、綁定使用者與檔案列、一張只能用一次 | `upload-ticket.ts:31-38,56-63`；`file-storage.ts:200-214`（`claims.userId` 要等於登入者、列必須仍是 `uploading`）；大小以實收位元組計、不信 `Content-Length`（`:261`） | OK | — |
| 封存後不准完成上傳（憑證內帶記號，前端改不掉） | `upload-ticket.ts:26`（`rejectWhenCohortArchived` 在簽章內）、`file-storage.ts:185,218-221` | OK | — |
| `placement`：封存屆別只放行可編輯的位置（榮譽） | `pg-items.ts:223-232`（`archivedBlocks`／`editableInArchivedCohort`）；用例在 `pg-items.ts:386,500,577,752,1028,…` | OK | — |
| 私有檔授權：每次下載重新認人；「沒有這個檔」與「不是你的」同一回應、同樣查詢次數；待審與必須改密的人只拿得到訪客也拿得到的檔 | `file-storage.ts:425-475`；公開讀取例外清單 `composition/download-policy.ts:11`（`photo`、`attachment`、`poster`）；政策登記 `composition/ops.ts:79-111` | OK | — |
| `FILE_GONE`：換掉或清掉的頭像一律 404，不導 `/403` | `file-storage.ts:453-456`、`composition/files.ts:141` | OK | — |
| 下載一律 `attachment`＋`default-src 'none'; sandbox`；預覽只收 PDF 與點陣圖、`frame-ancestors 'self'` | `app/api/files/[id]/route.ts:34-42`、`preview/route.ts:36-42`；預覽路徑從 `proxy.ts` matcher 排除、標頭自己給齊（`proxy.ts:84-93`） | OK | — |
| 上傳路由不經 proxy（避免 body 被緩衝、超過 10 MB 靜靜截斷），自己帶 `nosniff`、`no-store` | `proxy.ts:84-93`、`upload/route.ts:28` | OK | — |
| 全站 CSP 沒有 `unsafe-inline`、沒有 `unsafe-eval`（只有 development 才加） | `web/src/shared/security-headers.ts:19-26,37`；測試站實測標頭見第 7 節 | OK | — |
| 不輸出 `style=` 屬性 | `git grep -nE 'style=\{\|style="' -- web/src ':!*.test.*'`：程式碼裡只有註解與一處例外——簽核可列印匯出頁的 `application/signoff/export.ts:226`。那是獨立的 HTML 文件，回應自帶 `default-src 'none'; style-src 'unsafe-inline'; sandbox allow-modals`（`app/api/admin/signoff/[versionId]/export/route.ts:46`），沒有 script、內容逐欄逸出 | OK（例外有理由） | — |
| 上傳限速 `UPLOAD_RATE_MAX` 打錯不會變成關掉限速 | `composition/files.ts:59-65` | OK | — |

## 4. 前端效能與首載

| 項目 | 證據 | 結論 | 要開的票 |
|---|---|---|---|
| 打包預算（基底＋小檔合併後） | `pnpm -C web overlay print budget`：`$shared` baseline 224.7 KB／上限 230；`/dashboard/teacher/grading/[groupId]` 236.6／250；`/dashboard/admin/grading/[groupId]` 228.7／250 | OK | — |
| `$shared` 離上限只剩約 5 KB | 同上 | 低（規則已在：根層與 `SiteShell` 不准再加 client 元件；下一張碰全站殼的票要先量） | — |
| 根層 `not-found` 沒有 client 元件；壞掉頁特效由 `SiteHeader` 的載入器看到 `data-broken-fx` 才下載 | `web/src/app/_ui/broken-page.tsx:1-3,36`；`web/src/app/_ui/fx/lazy-loaders.ts`（6 個延遲入口） | OK | — |
| 根層 layout 的 client 元件只有 GA 腳本、換頁追蹤、導覽中狀態 | `web/src/app/layout.tsx:4-6`（已在 baseline 內） | OK | — |
| 點開才下載：對話框、選單、評分卡算分都走 `next/dynamic` 或延遲 import | `git grep -l "next/dynamic\|lazy(" -- web/src` 12 檔；延遲 chunk 下載期間的互動已有 e2e 規則（C4-09、FIX-SC1） | OK | — |
| D-23 小檔合法 | `pnpm -C web overlay check`：三個資料夾（指紋 10 檔、預算 11 檔、查詢數 12 檔）無撞鍵、exit 0 | OK | — |

## 5. 維運與監測

| 項目 | 證據 | 結論 | 要開的票 |
|---|---|---|---|
| health-cron：每 10 分鐘巡兩站，判 `ok`、`commit`、worker 心跳 5 分鐘內；失敗與恢復送 Discord；workflow 無任何 repo 權限 | `.github/workflows/health-cron.yml`（`permissions: {}`、`CHECK` 的 jq 判定、`notify` job） | OK | — |
| Healthchecks.io 打卡網址不進指令列（`ps` 看不到） | `ops/lib/healthchecks.sh:35-40`（curl 設定檔經 stdin）；worker 從環境變數讀（`web/src/composition/worker.ts:161`、`docker-compose.vm.yml:85`） | OK | — |
| 每日備份＋磁碟 ≥ 80% 告警；異地副本目錄 700／檔案 600；非 `deploy` 身分直接擋 | `ops/backup-daily.sh:31,38,44-49,74-80` | OK | — |
| 機密不進 argv | `ops/seed-demo.sh:79-81`（`-e 名稱` 不帶值）；全 repo 掃 `git grep -nE "(PASSWORD\|SECRET\|TOKEN\|KEY)=\\$\|--password" -- ops '*.sh' '*.yml' '*.mjs'`：只有本機 verify 起測試容器時的固定測試密碼（`web/scripts/verify.mjs:39,321`，不是正式機密） | OK | — |
| `.env.example` 與 Doppler 清單 | `.env.example` 27 鍵；`docs/engineering/operations/02 …清單.md` 已標 `ALERT_WEBHOOK_URL`、R2、age 不用（`:11`），但 `:55` 的舊段落仍列著它們，且 `BREVO_API_KEY`、`MAIL_FROM`、`UPLOAD_RATE_MAX`、`IDENTITY_CACHE_TTL_SECONDS`、`HTTP_PORT`、`DB_POOL_MAX` 在該文件找不到 | 低（文件） | 票 C（低，純文件）：`02 環境變數、OAuth 與 Secrets 清單.md` 以 `.env.example` 為準重列一張「鍵／誰用／放哪」表，舊段落移到摺疊區；可改檔案只有那一份文件 |
| 容器以非 root 執行、不送 `X-Powered-By`、app 埠不對外 | `web/Dockerfile:94`（`USER nextjs`）、`web/next.config.ts:18`、`docker-compose.vm.yml:93` | OK | — |
| 依賴稽核：high 以上就擋，只看會進到 web 的相依 | `.github/workflows/ci.yml:244-245` | OK | — |
| Cloudflare 切橘雲後的來源限制腳本（VM 只接受 Cloudflare 連線） | `ops/cloudflare-origin-lock.sh`；操作清單 `ops/README.md:1118-1148` | OK（尚未執行，見第 8 節） | — |

## 6. 測試穩定度

| 項目 | 證據 | 結論 | 要開的票 |
|---|---|---|---|
| nav-skeleton：操作前先等 hydrate 與主執行緒閒置，`requestIdleCallback` 帶 2 秒上限；開的兩個分頁都關 | `957ba37e`（FIX-NS1）、`bea252ba`（C4-11 r1）；`web/e2e/nav-skeleton.spec.ts:68,196-202` | OK | — |
| rwd-overflow：同上，兩次 idle 都有上限 | `web/e2e/rwd-overflow.spec.ts:110` | OK | — |
| broken-page（`:84` 取 canvas 顏色）：抖動改用 `MutationObserver` 在 class 加上的當下抓，等待都有上限（8 秒、7.5 秒） | `9a0b1079`（C4-05）；`web/e2e/broken-page.spec.ts:150-170,198-210`；顏色取樣前先 `expectFuzzyReady`（`:76`） | OK（推斷：本票沒有重跑 5 次） | — |
| front-edit-activity（`:152` 之後的「建立活動」）：C3-08 修 e2e 回饋後沒有再紅的紀錄 | `d5f27bce`；`web/e2e/front-edit-activity.spec.ts:140-165` 的等待都是 `expect(...).toHaveCount(0)`（有預設上限） | OK（推斷） | — |
| deidentify：`browser.newContext()` 開了兩個 context，測試結尾有關 | `web/e2e/deidentify.spec.ts:58-65,120-121` | OK | — |
| 其他 spec 用 `browser.newContext()` 卻從不 `close()`，context 會活到 worker 結束，連跑整套時累積 | `for f in web/e2e/*.spec.ts; do …; done` 比對 `newContext(` 與 `close()` 次數：`account-edit.spec.ts`（4／0）、`admin-roles.spec.ts`（2／0）、`role-switch.spec.ts`（2／0）、`email-verify.spec.ts`（1／0）、`google.spec.ts`（1／0）、`accounts-tabs.spec.ts`（3／1） | 低 | 票 D（低）：六份 spec 的 `newContext()` 改成 `try/finally` 或 `test.afterEach` 關掉；可改檔案只有那六份 spec |
| 「等某件事」都有上限 | `page.waitForEvent`／`waitForResponse` 23 處沒寫 `timeout`，但 Playwright 預設 30 秒；`grading.spec.ts:659-663` 的 `holdNextAction` 兩個 Promise 沒有自己的上限，由測試整體逾時兜底 | 低 | — |
| 跳過開關 | `web/e2e/grading.spec.ts` 的 `GRADING_E2E_SKIP` 只在重現舊紅燈時用；`file-download-pages.spec.ts:414,616` 依環境跳過 fd 與檔案本體檢查 | OK | — |
| 本票 verify | `pnpm -C web verify`：lint 12.3 秒、typecheck 19.8 秒、單元 150 檔 1951 通過／7 跳過（含 `test/structure/server-action-guard.test.ts` 175 個、`front-edit-actor.test.ts` 55 個、`test/overlay/merge.test.ts` 43 個）；全部通過 | OK | — |

## 7. 外部掃描（只讀；測試站公開網址，2026-10-21 15:16 台灣時間）

指令：對首頁、`/login`、`/api/health` 各做一次 `curl -sI`。沒有登入、沒有 POST。

| 標頭 | 實測 | 和程式對照 | 結論 |
|---|---|---|---|
| `strict-transport-security` | `max-age=63072000; includeSubDomains` | `security-headers.ts:69` | OK（沒有 `preload`，和契約一致） |
| `content-security-policy` | `default-src 'self'; script-src 'self' 'nonce-…' 'strict-dynamic'; style-src 'self' 'nonce-…'; … frame-ancestors 'none'`，三個頁面 nonce 各不同 | `security-headers.ts:19-49` 逐項相同；沒有 `unsafe-inline` | OK |
| `x-frame-options` / `x-content-type-options` / `referrer-policy` / `permissions-policy` / `cross-origin-opener-policy` | `DENY` / `nosniff` / `strict-origin-when-cross-origin` / `camera=(), microphone=(), geolocation=(), interest-cohort=()` / `same-origin` | `security-headers.ts:61-66` | OK |
| `cache-control` | 頁面 `private, no-cache, no-store, max-age=0, must-revalidate`；`/api/health` `no-store` | `health/route.ts:11` | OK |
| `x-robots-tag` | `noindex, nofollow` | `ops/Caddyfile.vm:61`（只有測試站） | OK |
| `server` / `x-powered-by` | 都沒有 | `next.config.ts:18` | OK |
| **Cloudflare 橘雲** | **沒有** `cf-ray`、`cf-cache-status`、`server: cloudflare`；有 `via: 1.1 Caddy` | 代表連線直接到 Caddy，DNS 仍是灰雲 | 現況：還沒切（AC-68 的前置） |
| 正式站公開網址 | `HTTP/2 502`、`server: Caddy` | `ops/Caddyfile.vm:10`「某一站還沒部署時回 502」 | 現況：正式站尚未部署 |

## 8. 驗收夜要跑

這些不是程式缺口，是只能在測試站或正式站跑的劇本（`docs/engineering/slices/01 案例責任表.md` 標 `NOT_RUN`），加上切橘雲之後才做得到的端到端。

| 編號 | 內容 | 位置 |
|---|---|---|
| ACC-10 | 多角色切換 | 案例責任表 `:24`（P02 步驟 19） |
| GRP-18 | 組長更換與接任 | 案例責任表 `:58`（B02 步驟 8、13） |
| NTF-07 | 額外事件（通知） | 案例責任表 `:132`（B08 步驟 1） |
| AC-68 | 切橘雲之後的 9 步端到端（註冊兩分頁、公開 PDF 第二次 `cf-cache-status: HIT`、登入錯 5 次只鎖自己、暫停自動部署 20 分鐘收到 Discord、`/api/health` 經 Cloudflare 仍 `no-store`、從外面直打 VM 被拒）；全程 console 無 CSP 違規 | `docs/plans/2026-10-19-c-fixes-ops/驗收案例.md:134` |
| 切橘雲清單 | DNS 橘雲 → SSL Full (strict) → 關 Rocket Loader 與 Email Obfuscation → `/api/files/*` 的 Cache Rule → WAF 限速一條 → `cloudflare-origin-lock.sh --execute` → `FILE_MAX_BYTES` 改 95 MiB（要在切之前） | `ops/README.md:1118-1148` |
| 監測一次性驗證 | 四個 Healthchecks.io check 全綠；手動跑一次 `health-cron` 填連不上的網址，Discord 收到「🔴」 | `docs/engineering/operations/05 監測與告警.md`「Roy 要做的設定」第 4 點 |

## 9. 要開的票（彙總）

| 票 | 等級 | 一句話 | 建議可改檔案 |
|---|---|---|---|
| A | 低 | route handler 也納入結構登記：POST 先同源檢查、進用例前先 `resolveActor` | `web/test/structure/route-handler-guard.test.ts`（新） |
| B | 中 | 主腦先裁定 AC-56c「封存後重播回 `COHORT_ARCHIVED`」是全站語意還是只限繳交；若全站，掃約 60 處把封存檢查搬到 `ledger.begin` 之前，補結構測試與 AC-56c 各模組重播案例 | 各模組 `web/src/infrastructure/**/pg-*.ts`、`web/test/structure/ledger-order.test.ts`（新）、`web/src/infrastructure/cohorts/archived-readonly.integration.test.ts` |
| C | 低（純文件） | 環境變數文件以 `.env.example` 為準重列，舊的 R2／age／`ALERT_WEBHOOK_URL` 段落收進摺疊區 | `docs/engineering/operations/02 環境變數、OAuth 與 Secrets 清單.md` |
| D | 低 | 六份 e2e 的 `browser.newContext()` 補 `close()` | `web/e2e/account-edit.spec.ts`、`admin-roles.spec.ts`、`role-switch.spec.ts`、`email-verify.spec.ts`、`google.spec.ts`、`accounts-tabs.spec.ts` |

本次沒有發現「高」等級的問題。
