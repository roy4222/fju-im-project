---
type: slice
slice: S01
project: FJU IM Project
updated: 2026-09-13
status: written-v2.1-pending-review
---
# S01｜帳號與 Auth、最小屆別與開放註冊、名單、核准、稽核與帳本

## 2026-09-15 定案補充

Roy 在 9/14 會議後確認：完整 V1 可試用、分區實作；評分規則維持既定設計，僅補齊成績匯出與名單匯入／匯出。系級指「資管二甲／資管二乙」，不是專題屆別。本節為現行增補；與下方舊文字有衝突時以本節為準。僅文件與 issue 更新，未實作、未驗收，PR 未在本次合併。

### 名單與系級

- 名單匯入沿用 #51；支援系級完整文字並在預覽、保存、重開後一致。舊名單缺值保留空白，不猜填。
- 註冊申請及修改、Google 首次補資料、審核並列資料與核准後學生資料都承接系級；系級不改名單比對、人工核准或權限。
- 名單匯出明確由 #59／S01-16 承接，取代舊「不在本票／未定切片」說法；管理員可勾選部分或全選全部篩選結果，匯出 UTF-8 CSV，包含姓名、學號、系級、屆別、手機、Email、角色、狀態。未分組學生也可匯出。
- 匯入原檔下載、帳號名單匯出、組別名單匯出分別由 #51、#59、#105 承接。
- 匯出保留學號前導零及中文，沿用公式字首保護與每次重新授權；驗證選取範圍、筆數、系級及非管理員拒絕，追溯 ACC-15。


## 成果
只 seed A1 後：A1 登入（一次性密碼、強制改密）→ 建 115-TEST（最小屆別：code、名稱、狀態）並設為預設工作屆別與開放註冊屆別 → 匯入 15 列 CSV 預覽與匯入（原檔以最小檔案能力保存、可下載）→ 學生以密碼註冊停在等待審核頁並可修改 → A1 在待審清單看到比對標示、選核實方式核准或退回（核准同交易寫占用表與屆別）→ 學生登入進「首頁殼」→ A1 停用學生後其舊 session 立即被拒 → 臨時密碼一次顯示與強制改密 → 學生改手機與聯絡 Email → 本人連結 Google 與設密碼的入口。Google 三案（ACC-13／16／18）由 Roy 人工實測。

## 模組與前置
01、02（最小屆別：`cohorts` 三狀態、兩旗標，無階段）、10（audit、ledger、最小檔案能力）；前置 S00。

## 進場資料與產生方式
- `pnpm seed:a1`：只建立 A1（Email 與一次性密碼由環境變數提供，首次登入強制改密）；其他一律從 UI。
- 測試 CSV（去識別）：13 唯一＋1 重複 S03＋1 缺姓名，S09 無 email；`📖 操作與驗證/fixtures/roster-115-test.csv`（本輪只定格式，檔案隨實作提供）。

## schema／API／狀態依賴
第二支 migration：模組 01 附錄 A 全部表（含 `session_revocations`）與模組 10 的 `stored_files`、`file_references`（先建，供 `roster_versions.file_id` FK）；`cohorts` 已在 S00。`FileStorage` 最小（ticket、upload Route Handler、finalize、download 授權；無 GC）。`ActorResolver`、`RegistrationCommand`、`RosterCommand`、`AccountCommand`、`SelfAccountCommand`、`UserDirectoryQuery`、`EligibleStudentsQuery`；`CohortCommand.create／activate／setDefaultWorking／setRegistrationOpen` 與 `CohortStatusQuery.registrationOpen()` 的最小實作（模組 02 擁有，本切片交付）。

## 責任範圍、公開介面、跨模組協議
- Better Auth 設定與路由×狀態矩陣（契約 03 §2）；`generateId` uuidv7；`databaseHooks.user.create.before` 注入 pending；`disableImplicitLinking`；`cookieCache` 關；`freshAge`；內部呼叫辨識；admin plugin 只在伺服器。
- 核准用例：`registration_applications` FOR UPDATE＋revision→`student_identities` 插入→`role_assignments`→`user_profiles.cohort_id`→呼叫 05 `syncRoster`（S01 時為 no-op 介面，S04 後才有名單）→commit 後 `banUser`／`unbanUser` 不在此用例。
- 頁面：`/login`、`/register`、`/register/pending`、`/account`、`/dashboard/admin/accounts`（列表、審核對話框、停用、臨時密碼、匯入）、`/dashboard/admin/cohorts`（最小：建立、啟用、兩旗標）、首頁殼。

## 正常與拒絕路徑
模組 01 §8；pending 帳號呼叫業務 action `ACCOUNT_PENDING`；停用 `UNAUTHENTICATED`；must-change 帳號業務 action `PASSWORD_CHANGE_REQUIRED`；封鎖端點 403；同 Email Google 登入 `account_not_linked` 文案；沒有開放註冊屆別時 `/register` 顯示「目前未開放註冊」。

## 重試／回滾／恢復
核准回應遺失→`getOperationResult`；匯入整批一交易；臨時密碼只顯示一次，遺失就再發（新 audit）；`banUser` 經 `session_revocations` 每人序列化執行器（queued→executing→done／failed；失敗不重用同一列，由管理端「重試」（`manual_retry` 收斂工作）或 worker（S02 起）的收斂核對接手；模組 01 v2.4 附錄 A 規則 5）。

## 最終責任案例、子步驟、自動測試、Codex、四欄
- 最終責任案例：ACC-01、02、03、04、05、06、07、08、09、10、11、14、15、17；ACC-13、16、18（環境：人工 Roy，Codex 只留入口截圖，結果 BLOCKED 直到 Roy 執行）。
- 子步驟案例（不在此 PASS）：COH-01 的最小屆別建立（最終 S02）。
- 自動：模組 01 §10 全部；契約 04 §4 的「一次性秘密不入紀錄」掃描。D1 釘版（模組 01 v2.4 §10 第（1）–（8）項，本切片負責執行器、讀取與序列）：`readBanned` 唯讀查詢正向（內部包裝 `banUser` 後 true、`unbanUser` 後 false、無 request context）與反向（`/admin/list-users` 帶管理員 session 仍被擋）、admin plugin 欄名 gate、`session_revocations` 三條部分唯一與 `reconcile_round` 上限（自動 round 10→failed `RECONCILE_LIMIT`＋audit）、逐列序列（b）的列級斷言（含兩個核對者同時插入只留一筆）、owner fencing 與順序保證以同步屏障量測；worker 週期核對本身在 S02。
- Codex：劇本 P01、P02、B01；四欄證據：註冊回執、待審標示截圖、`SELECT status, must_change_password`、`student_identities` 列、S03 直接請求 S01 資料回應、封鎖端點回應。
- 切片出場操作起點（v2.1）：總圖「切片出場與年度案例 PASS 的分界」表的 S01 列；證據存 `steps/S01/`；不以案例 PASS 為出場條件。

## 出場條件（環境：staging；staging 未就緒時 local，並標明）
本切片自動測試綠；操作起點走通（總圖 v2.1 表：只用 S00、S01 功能，不需階段、業務鐘或 worker）並留 `steps/S01/`；Fable review；Roy 看核准對話框與等待審核頁。案例 PASS 在完整年度（P01、P02、B01）判定；Google 三案 Roy 人工。

## 未涵蓋
階段、業務鐘、活動（S02）；任何收件；Google 實測。

## 依賴
Roy：第一次 staging 部署時點（預設本切片後）；Google OAuth client 與測試身分（Roy 實測時；前置清單 §2.2、§3.2）。校方：無（CSV 樣本不阻塞）。

## 狀態
文件已寫｜待 review｜可實作：否｜實作完成：否｜自動驗證：否｜瀏覽器：否｜VM：否｜Roy 接受：否
