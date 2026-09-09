# 規格覆蓋矩陣：📋 完整產品規格 v1.0.1 vs. 現有原型

- 規格：`📋 完整產品規格.md`（2026-09-07，spec_version 1.0.1）
- 程式：`src/`（worktree `claude/fju-capstone-website-redesign-851153`，commit 15abacc）
- 路徑省略前綴 `src/`。狀態：✅ 有畫面 / 🟡 部分 / ❌ 無
- 原型全部讀 `lib/fixtures.ts` 假資料，沒有任何 server action、API、DB。以下「有畫面」指靜態畫面存在，不代表流程可操作。

## 0. 路由與導覽現況

### 0.1 實際存在的頁面

| 路由 | 檔案 |
|---|---|
| `/` | `app/(public)/page.tsx` |
| `/news`、`/news/[id]` | `app/(public)/news/page.tsx`、`news/[id]/page.tsx` |
| `/industry`、`/industry/[id]` | `app/(public)/industry/page.tsx`、`industry/[id]/page.tsx` |
| `/projects`、`/projects/[id]` | `app/(public)/projects/page.tsx`、`projects/[id]/page.tsx` |
| `/honors` | `app/(public)/honors/page.tsx` |
| `/competitions` | `app/(public)/competitions/page.tsx` |
| `/rules` | `app/(public)/rules/page.tsx` |
| `/login`、`/register` | `app/(public)/login/page.tsx`、`register/page.tsx` |
| `/dashboard` | `app/dashboard/page.tsx`（硬轉址到 `/dashboard/student`） |
| `/dashboard/[role]` | `app/dashboard/[role]/page.tsx`（student / teacher / admin 三個 Dashboard） |
| `/dashboard/[role]/groups` | `app/dashboard/[role]/groups/page.tsx` + `groups-table.tsx` |
| `robots.txt`、`sitemap.xml` | `app/robots.ts`、`app/sitemap.ts` |

### 0.2 `lib/nav-config.ts` 每一條導覽與頁面檔是否存在

| 導覽群組 | href（相對 `/dashboard/[role]`） | label | 角色 | 頁面檔存在？ |
|---|---|---|---|---|
| 總覽 | `` (空) | 首頁 | 全部 | ✅ `app/dashboard/[role]/page.tsx` |
| 專題事務 | `/affairs` | 我的專題事務（badge 3） | student | ❌ |
| 專題事務 | `/affairs` | 各組繳交狀態 | teacher | ❌ |
| 專題事務 | `/affairs` | 專題事務工作台 | admin | ❌ |
| 專題事務 | `/editor` | 內容與表單編輯器 | admin | ❌ |
| 專題事務 | `/files` | 檔案與資源 | admin | ❌ |
| 分組與產學 | `/groups` | 我的組別 | student | ✅（但學生看到的是全體分組表，不是「我的組別」詳情） |
| 分組與產學 | `/groups` | 分組總覽 | teacher, admin | ✅ |
| 分組與產學 | `/industry` | 產學合作 | 全部 | ❌（注意：這是 `/dashboard/[role]/industry`，不是公開的 `/industry`） |
| 評分與簽核 | `/grading` | 我的評分工作（badge 2） | teacher | ❌ |
| 評分與簽核 | `/grading` | 成績管理 | admin | ❌ |
| 評分與簽核 | `/signoff` | 待我同意（badge 1） | student | ❌ |
| 評分與簽核 | `/signoff` | 簽核進度 | teacher, admin | ❌ |
| 系統管理 | `/accounts` | 帳號管理（badge 4） | admin | ❌ |
| 系統管理 | `/audit` | 操作紀錄 | admin | ❌ |

15 條導覽只有 3 條有頁面（首頁、兩條 `/groups`）。另外 Dashboard 首頁本體還連到這些不存在的路由：`${base}/affairs/${item.id}`、`${base}/affairs/mi-011`、`${base}/grading/${groupId}`、`${base}/accounts?status=pending`、`${base}/industry?status=open`（`app/dashboard/[role]/page.tsx`）。`components/public/site-footer.tsx` 的 `/industry?status=open` 頁面存在但 `industry/page.tsx` 不讀 searchParams，篩選無效。`login/page.tsx` 的「忘記密碼」是 `href="#"`。

---

## §2 帳號、登入與權限

| 規格條目 | 現有畫面/元件 | 狀態 | 備註（缺什麼） |
|---|---|---|---|
| 2.1 單一登入入口，依角色進不同 Dashboard | `app/(public)/login/page.tsx`；`app/dashboard/page.tsx` | 🟡 | 登入按鈕無行為；`/dashboard` 硬轉 student，無角色判斷 |
| 2.1 多角色帳號可切換「目前工作角色」 | `components/layout/dashboard-header.tsx` 角色下拉 | 🟡 | 原型讓任何人切三種角色（標「原型」badge）；規格只允許持有多角色者切換。`CURRENT_USERS.admin.roles = ["admin","teacher"]` 但沒用到 |
| 2.2 權限矩陣（前端隱藏 ≠ 授權） | `lib/nav-config.ts` `roles` 過濾；`groups-table.tsx` 依 role 出不同操作鈕 | 🟡 | 只有入口顯示差異，無 server 驗證（原型範圍內可接受，但要記錄） |
| 2.3 Google OAuth 主要 + Email/密碼備援 | `login/page.tsx` | ✅ | 主／備層級在畫面上看得出；未接 Auth |
| 2.3 忘記密碼重設流程 | `login/page.tsx` 「忘記密碼」連結 | ❌ | `href="#"`，無重設頁 |
| 2.3 管理員建立臨時密碼／強制改密碼 | — | ❌ | 無帳號管理頁 |
| 2.4 學生註冊欄位（姓名、學號、屆別、手機、聯絡 Email；不收生日／照片） | `app/(public)/register/page.tsx` | ✅ | 欄位與規格一致；有「不收生日／照片」提示；無送出 |
| 2.4 本屆名單 CSV 匯入 preview（總筆數／有效／重複／缺欄／衝突） | — | ❌ | |
| 2.4 名單命中自動核准／未命中進待審清單 | `login`／`register` 說明文字；admin Dashboard「待審核帳號 4」ActionRow | 🟡 | 只有計數與說明，連到不存在的 `/accounts?status=pending` |
| 2.4 老師帳號新增／預授權／首次登入補資料 | `register/page.tsx` 提示「老師帳號由系辦建立」 | ❌ | 無畫面 |
| 2.5 管理員新增／編輯／停用／還原／永久刪除帳號 | — | ❌ | `/accounts` 不存在；`ADMIN_STATS.disabledAccounts` 在 fixture 但 Dashboard 沒渲染 |
| 2.5 永久刪除影響預覽＋二次確認 | — | ❌ | |
| 2.6 帳號表排序／搜尋／篩選／部分或全選匯出 CSV | `components/data-table/data-table.tsx`（通用能力已備） | ❌ | 沒有帳號表實例 |
| 2.6 批次停用 TXT 上傳＋preview | — | ❌ | |

## §3 資訊架構與三角色 Dashboard

### 3.1–3.3 架構

| 規格條目 | 現有畫面/元件 | 狀態 | 備註 |
|---|---|---|---|
| 3.1 公開前台與 Dashboard 同一 app、不同版面 | `app/(public)/layout.tsx` vs `app/dashboard/[role]/layout.tsx` | ✅ | |
| 3.2 公開路由 8 組 | 見 §0.1 | ✅ | `/news/[slug]` 實作為 `/news/[id]`（id 如 `n-31`，非 slug）；`/competitions` 無詳情頁（sitemap 用 `#anchor`） |
| 3.3 六個核心區域皆有入口 | `lib/nav-config.ts` | 🟡 | 入口齊全，但六區只有「分組」有頁面 |

### 3.4 學生 Dashboard（`app/dashboard/[role]/page.tsx` → `StudentDashboard`）

| 規格條目 | 現有畫面/元件 | 狀態 | 備註 |
|---|---|---|---|
| 下一個截止日與倒數 | 「待完成事項」每列 `DueChip`（剩 N 天／逾期 N 天） | 🟡 | 每列有倒數，但沒有一個突出的「下一個截止日」錨點 |
| 待完成／草稿／已繳交／需重送／已逾期 | `StateBadge`（`components/dashboard/primitives.tsx`）六態＋「待完成事項」「已完成」兩個 Panel | ✅ | CTA 文案依狀態變（繼續填寫／修正後重送／查看逾期處理），但目標 `/affairs/[id]` 不存在 |
| 自己的組別、五位成員確認進度、類型、指導老師 | 「我的組別」Panel | ✅ | |
| 近期公告 | 「近期公告」Panel（NEWS 前 4 則） | ✅ | |
| 重要規則 | — | ❌ | 學生 Dashboard 沒有規則入口 |
| 產學合作入口 | 側欄「產學合作」 | 🟡 | 連到不存在的 `/dashboard/student/industry`；Dashboard 本體無產學區塊 |
| 待本人同意與全組簽核進度 | 「待我同意」Panel：五人清單＋老師「尚未輪到」＋同意／不同意鈕 | ✅ | 按鈕無 handler；「不同意並填寫原因」無原因對話框 |
| 共用草稿與歷次繳交版本 | 「已完成」列的「查看版本」連結 | ❌ | 連到不存在的 `/affairs/[id]`；無草稿頁、無版本列表 |
| 不顯示任何分數／評語／排名 | `StudentDashboard` 未 import `GRADING_SCHEME`／`EVALUATION_QUEUE`；nav 對 student 無 grading 項 | ✅ | 已確認 grep 無洩漏 |

### 3.5 老師 Dashboard（`TeacherDashboard`）

| 規格條目 | 現有畫面/元件 | 狀態 | 備註 |
|---|---|---|---|
| 我的學生／指導組別 | StatTile「我的指導組別」＋「我的指導組別與繳交狀態」Panel | ✅ | |
| 全體分組與未分組名單 | `groups/page.tsx` 表格（全體分組）；未分組只有 StatTile 計數 | 🟡 | 未分組**名單**只出現在 admin Dashboard，老師看不到姓名／opt-in 狀態 |
| 尚未指派、可認領的產學組 | 「尚未指派的產學組」Panel＋「指定為我的組別」鈕；`groups-table.tsx` 操作欄同樣 | ✅ | 按鈕無 handler，無競態衝突訊息 |
| 自己建立的產學合作案 | — | ❌ | `INDUSTRY` 有 `advisorName` 但老師 Dashboard 沒渲染 |
| 待評分／已暫存／已送出的評分工作 | StatTile×2＋「待評分」Panel（pending/staged/submitted 三態） | ✅ | 連到不存在的 `/grading/[groupId]` |
| 待老師同意的簽核 | — | ❌ | `SIGNOFF.teacherApproval` 在 fixture 但老師 Dashboard 無簽核區塊 |
| 近期截止與各組繳交狀態 | 「我的指導組別與繳交狀態」`ProgressBar` | 🟡 | `done={3} total={5}` 硬編，非依項目計算；沒有截止日列表 |

### 3.6 管理員 Dashboard（`AdminDashboard`）

| 規格條目 | 現有畫面/元件 | 狀態 | 備註 |
|---|---|---|---|
| 待審核帳號、停用／異常帳號 | 「需要處理」ActionRow「待審核帳號」 | 🟡 | `disabledAccounts` 未渲染；無異常帳號 |
| 本屆已分組／未分組、組別例外、產學未指派數 | StatTile「本屆已分組學生」（hint 含未分組／例外）、「組別總數」、ActionRow「產學案未指派組別」、「未分組學生」Panel | ✅ | |
| 各收件項目完成率、逾期、重新開放狀態 | 「收件項目完成率」Panel（`ProgressBar` 含逾期紅段、schema 版本 badge）、ActionRow「逾期未繳組別」 | 🟡 | 無「已重新開放」狀態顯示 |
| 評分完成率、缺評老師 | ActionRow「缺評老師」 | 🟡 | `count={2}` 硬編；無完成率 |
| 簽核進度 | — | ❌ | admin Dashboard 沒有簽核區塊 |
| 檔案儲存量、最近備份、最近還原演練 | StatTile「檔案儲存量」「最近成功備份」＋還原演練警示 banner | ✅ | 規格 §11.4「失敗紀錄不得覆蓋最後成功時間」已寫進文案 |
| 瀏覽量、公告閱讀、下載量 | — | ❌ | |
| 最近高權限操作 | — | ❌ | `/audit` 不存在，Dashboard 無 audit 區塊 |
| 需處理的系統警示 | 「系統狀態」Panel（PostgreSQL／volume／外部備份未設定） | ✅ | |
| 不放營收／訂閱假數據 | `primitives.tsx` `StatTile` 註解明示 | ✅ | |

## §4 專題事務管理

| 規格條目 | 現有畫面/元件 | 狀態 | 備註 |
|---|---|---|---|
| 4.1 專題事務項目（標題／摘要／內文／封面／分類／附件／欄位／上傳／期限／對象／單一發布位置） | `lib/fixtures.ts` `ManagedItem` 型別＋5 筆資料 | ❌ | 只有資料模型；無建立／編輯畫面 |
| 4.2 七個主要發布位置 | `PLACEMENT_LABEL` 七種 | 🟡 | 前台模板：公告 ✅ `news/`；專題規則 ✅ `rules/`；歷屆專題 ✅ `projects/`；榮譽／競賽 ✅ `honors/`、`competitions/`；**檔案／資源下載 ❌**（無 `/resources` 頁）；**文件繳交 ❌**（無學生繳交頁）；**專題需求 ❌**（無填寫頁） |
| 4.2 首頁精選／Dashboard 待辦自動帶出 | `(public)/page.tsx` 「近期截止」讀 `MANAGED_ITEMS`；學生 Dashboard 讀同一份 | ✅ | 單一來源在 fixture 層成立 |
| 4.3 發布對象五種 | `ManagedItem.audience` 純字串「114 學年度學生」 | ❌ | 無選擇 UI；型別未列舉五種 |
| 4.4 拖拉式編輯器（左元件／中 canvas／右設定／上方發布列／預覽） | — | ❌ | nav `/editor` 無頁面；§16.3 Prototype B 未做 |
| 4.4 v1 元件清單（說明、富文字、圖片、短文字、textarea、單複選、日期、附件、上傳、唯讀組別資訊區塊） | — | ❌ | |
| 4.5 生命週期 Draft→Published→NewVersion→Archived | `ManagedItem.status` 三值＋`schemaVersion` badge（admin Dashboard） | 🟡 | 只顯示版本號；無發布／撤回／下架／新版確認操作 |
| 4.6 同組共用草稿、任一人送出全組完成 | 學生 Dashboard `myState`＝`draft`／`submitted`；`NEWS_BODY`、`RULES_DOC` 文案描述此規則 | 🟡 | 只有狀態 badge 與文案；無草稿頁、無並發衝突提示 |
| 4.6 截止前重送、不可變版本、預設最新版 | 「查看版本」連結 | ❌ | 目標頁不存在 |
| 4.6 截止後鎖定、管理員對指定組別 reopen（理由＋新期限） | `SubmissionState.locked`；admin ActionRow「處理逾期」 | ❌ | 連到不存在的 `/affairs/mi-011`；無 reopen 對話框 |
| 4.6 送出後清楚回執 | — | ❌ | |
| 4.7 共用檔案服務、工作台內依類型／項目／組別／屆別／上傳人／日期查找 | — | ❌ | nav `/files` 無頁面 |
| 4.7 公告附件下載 | `news/[id]/page.tsx` 附件列表（檔名／大小／下載鈕） | 🟡 | 檔名硬編，下載鈕無行為 |

## §5 分組管理

| 規格條目 | 現有畫面/元件 | 狀態 | 備註 |
|---|---|---|---|
| 5.1 本屆已分組／未分組名單（學生可見） | `groups/page.tsx` 表格對三角色都開；未分組名單只在 admin Dashboard | 🟡 | 學生看不到未分組名單；無聯絡 Email 顯示 |
| 5.1 未分組「公開找組員」opt-in 開關 | admin Dashboard「公開找組員／未公開」badge；`UNGROUPED.openToJoin` | 🟡 | 只有管理視角的顯示；學生沒有開關 |
| 5.1 本屆／過往屆別分開，過往唯讀 | `COHORT` 單一 active | ❌ | 無屆別切換 |
| 5.2 組長輸入五個學號→五人各自確認→transaction 成組 | 學生 Dashboard「成員確認進度 3/5」「等待 2 人確認」 | 🟡 | 只有確認進度顯示；無建組表單、無「確認／拒絕加入」動作 |
| 5.2 非五人組只有管理員能建例外＋理由 | `groups-table.tsx` 人數≠5 標橘、狀態「例外組」badge；fixture `g-09` | 🟡 | 顯示 ✅；建立例外＋理由 ❌ |
| 5.3 GENERAL／INDUSTRY 類型、組長可改、留 audit | 類型 badge（表格、Dashboard） | 🟡 | 無修改 UI |
| 5.3 分類不限制老師可見 | `groups/page.tsx` 藍色 info banner 明示 | ✅ | |
| 5.4 老師認領未指派產學組（first-success） | 老師 Dashboard Panel＋表格操作欄「指定為我的」 | ✅ | 無 handler、無衝突訊息 |
| 5.4 管理員覆寫／重派／解除＋理由 | 表格操作欄「指派老師」（admin） | 🟡 | 無對話框、無理由欄 |
| 5.5 管理員新增／編輯／解散／重組＋影響預覽 | — | ❌ | |
| 5.5 分組表搜尋／排序／依屆別／類型／老師／狀態篩選 | `groups-table.tsx`：搜尋題目、排序、facet 類型／指導老師／狀態 | 🟡 | 缺屆別篩選（單屆情境下暫可） |
| 5.5 勾選部分或全選匯出 CSV／Excel | bulkActions「匯出所選 N 筆 CSV」「批次指派老師」 | 🟡 | 無行為；無 Excel |

## §6 產學合作

| 規格條目 | 現有畫面/元件 | 狀態 | 備註 |
|---|---|---|---|
| 6.1 訪客／學生看公開列表與詳情 | `industry/page.tsx`、`industry/[id]/page.tsx` | ✅ | |
| 6.1 老師建立／編輯／下架自己的合作案 | — | ❌ | `/dashboard/[role]/industry` 不存在 |
| 6.1 管理員管理全部 | — | ❌ | |
| 6.2 公開欄位（公司、部門、內容、條件、備註、負責老師、日期） | 列表摘要三欄＋詳情三段長文 | ✅ | |
| 6.2 私有欄位（地址、聯絡人、電話、Email）預設不公開 | 詳情頁「聯絡資訊」虛線框，值以 `＊` 遮罩 | 🟡 | 畫面表達了權限模型，但實作是把 `privateFields` 渲染給訪客再遮罩；正式版必須 server 端不回傳（頁面註解已承認） |
| 6.2 三個長文字用可拉伸 textarea 輸入 | — | ❌ | 無輸入表單 |
| 6.2 狀態 草稿／公開／下架 | `IndustryItem.status: "open" \| "claimed"` | ❌ | fixture 的 status 是「有無組別認領」，與規格的發布狀態語意不同 |
| 6.3 產學案連結零或多組、基數清楚呈現 | 詳情側欄「連結的組別」＋列表「已有 N 組」 | ✅ | |
| 6.3 認領產學組 ≠ 建立合作案，各自留痕 | — | ❌ | 無 audit 呈現 |

## §7 成績管理

| 規格條目 | 現有畫面/元件 | 狀態 | 備註 |
|---|---|---|---|
| 7.2 評分方案：階段／項目／滿分／輸入型態／百分比 | `lib/fixtures.ts` `GRADING_SCHEME`（2 階段 60/40，7 項合計 100%，number/letter） | ❌ | 只有資料；無管理畫面。`st-2 專題發表` items 為空，違反「項目權重合計 100%」 |
| 7.2 即時公式與示例計算、權重不合法不能發布 | `rules/page.tsx` 「成績計算」段列出公式文字 | ❌ | 公開規則頁有公式說明，不是管理員預覽 |
| 7.3 decimal 計算、round-half-up 兩位、letter mapping 版本化、pass/fail 獨立 | — | ❌ | |
| 7.4 管理員依階段×組別指派評分老師 | — | ❌ | |
| 7.4 老師只看受指派組別；逐組暫存／送出；送出鎖定 | 老師 Dashboard「待評分」Panel（未開始／已暫存／已送出・鎖定） | 🟡 | 佇列有，評分表 `/grading/[groupId]` 不存在；§16.4 Prototype C 未做 |
| 7.4 多老師算術平均、階段完成標記 | — | ❌ | |
| 7.5 方案版本鎖定、新版重算預覽、管理員更正留原值／新值／原因 | `GRADING_SCHEME.locked`、`version` | ❌ | 無畫面 |
| 7.6 學生完全看不到 | 已驗證（見 §3.4） | ✅ | |
| 7.6 管理員依屆別／階段／組別／完成狀態篩選匯出 | — | ❌ | `/grading`（admin）不存在 |

## §8 簽核管理

| 規格條目 | 現有畫面/元件 | 狀態 | 備註 |
|---|---|---|---|
| 8.1 管理員建立簽核內容版本與適用組別 | `SIGNOFF.packageVersion` | ❌ | 無畫面 |
| 8.1 五位學生各自登入閱讀並同意；每人只有自己一票 | 學生 Dashboard「待我同意」Panel（五人清單、時間戳、「我已閱讀並同意」） | ✅ | 無 handler；沒有「閱讀內容」本體，只有標題 |
| 8.1 五人全同意後老師才能同意 | Panel 內「指導老師 陳建宏 — 尚未輪到」 | ✅ | 順序表達清楚；老師端無同意畫面 ❌ |
| 8.1 不同意須填原因→Revision | 「不同意並填寫原因」鈕 | 🟡 | 無原因對話框、無 Revision 狀態顯示 |
| 8.1 內容或組員變更→舊同意失效 | Panel 下方一行說明文字 | 🟡 | 文案有，無版本失效的畫面 |
| 8.2 管理員看各組進度、缺誰、最後事件時間；重開／作廢／重置＋原因 | — | ❌ | admin Dashboard 與 `/signoff` 都沒有 |
| 8.2 不可代簽 | 「待我同意」description「每個人只能提交自己的同意，不能代替他人」 | ✅（文案） | |
| 8.3 兩種類型（最終文件同意／驗收確認） | 只有一筆 `so-01` | ❌ | |
| 三角色 Dashboard 狀態一致 | 只有學生端 | ❌ | 老師、管理員端缺 |

## §9 公開內容與首頁

| 規格條目 | 現有畫面/元件 | 狀態 | 備註 |
|---|---|---|---|
| 9.1 最新公告 | `news/page.tsx` + `news-list.tsx`（分類 tab）、`news/[id]`（圖＋文＋附件＋同分類） | ✅ | 列表無分頁（文案自承） |
| 9.1 競賽資訊 | `competitions/page.tsx`（卡片、狀態、倒數） | ✅ | 無詳情頁；報名連結 `href="#"` |
| 9.1 榮譽榜／得獎相簿 | `honors/page.tsx` + `honors-cards.tsx`（卡片→Dialog 一圖一文） | ✅ | 相簿只有單張佔位 |
| 9.1 歷屆專題與優秀專題 | `projects/page.tsx` + `projects-grid.tsx`（屆別／得獎篩選）、`projects/[id]`（摘要、技術、影片外連、海報、指導老師、組員） | ✅ | 海報 PDF 鈕無行為 |
| 9.1 專題規則（含歷史版本資訊） | `rules/page.tsx`（平鋪全文、側欄目錄、歷史版本清單） | ✅ | 歷史版本只列出、不可切換 |
| 9.1 公開產學合作 | 見 §6 | ✅ | |
| 9.2 重要消息與近期截止優先 | `(public)/page.tsx`：hero 焦點公告 → 公告 tab → 近期截止 → 產學 → 歷屆 → 榮譽＋規則 | ✅ | |
| 9.2 每區最新／精選三筆再進列表 | 各區 `.slice(0,3)` + `MoreLink` | ✅ | 「近期截止」取 4 筆、榮譽列出全部 4 筆（小差異） |
| 9.2 卡片含封面、分類、標題、摘要、日期與動作 | `components/public/sections.tsx` `ContentCard` | ✅ | |
| 9.2 封面 16:9 預設；人物照不粗暴裁切（contain／焦點） | `ImagePlaceholder`；hero 用 `aspect-[16/9]`，`ContentCard`／honors／competitions 用 `aspect-[16/10]` | 🟡 | 卡片比例是 16:10 不是 16:9；contain／焦點只寫在註解與佔位文案，沒有真實圖片處理 |
| 9.2 手機一欄、桌機二至三欄 | `grid sm:grid-cols-2 lg:grid-cols-3` | ✅ | |
| 9.2 canonical、metadata、OG、sitemap、可讀正文 | `app/layout.tsx` metadata、`robots.ts`、`sitemap.ts`；各頁 `generateMetadata` 只設 title | 🟡 | **`alternates.canonical: "/"` 與 `openGraph.url: "/"` 設在 root layout，子頁未覆寫 → 每一頁 canonical 都指向首頁**，違反「詳情具有穩定 URL」；各頁也沒有 description／OG image |
| 9.3 匿名信箱 `DEFERRED` | — | ❌ | 合規（deferred） |

## §10 共用 UI／UX

### 10.1–10.2 視覺與 design system

| 規格條目 | 現有畫面/元件 | 狀態 | 備註 |
|---|---|---|---|
| 公開前台參考系網品牌 | `components/public/*`、`public/brand/fju-im-logo.png`、橘色 `brand` token | ✅ | |
| Dashboard 採 Kiranism shell（側欄、導覽、搜尋、表格、主題切換） | `components/layout/app-sidebar.tsx`、`dashboard-header.tsx`、`components/ui/sidebar.tsx`、`theme-toggle.tsx` | ✅ | ⌘K 搜尋是假按鈕 |
| 深色主題可選，預設品牌色 | `theme-provider.tsx`（`defaultTheme="light"`, `enableSystem={false}`） | ✅ | |
| 移除 billing／kanban／chat 等 donor 展示功能 | 無此類頁面 | ✅ | |
| shadcn/ui primitives、Data Table＋TanStack | `components/ui/*`、`data-table.tsx` 用 `@tanstack/react-table` | ✅ | |
| token 化色彩／圓角／字級 | `app/globals.css` | ✅ | |

### 10.3 Data Table（`components/data-table/data-table.tsx`，唯一實例 `groups-table.tsx`）

| 規格條目 | 現有畫面/元件 | 狀態 | 備註 |
|---|---|---|---|
| 固定欄寬、cell 單行不撐高 | `table-fixed` + `meta.width`；`TableCell className="truncate"` | ✅ | |
| ellipsis／tooltip／詳情 drawer | `groups-table.tsx` 題目、組員欄用 `Tooltip` | 🟡 | 無 drawer |
| 整表水平捲動＋邊緣漸層提示 | `max-h-[32rem] overflow-auto` | 🟡 | 檔頭註解說「右緣有漸層提示」但程式碼裡**沒有**任何漸層元素 |
| 弱化捲軸仍可操作 | 無自訂捲軸樣式 | ✅（預設） | |
| sticky header | `TableHeader className="sticky top-0 z-10"` | ✅ | |
| 固定第一欄與操作欄 | — | ❌ | |
| 搜尋、篩選、排序、分頁、勾選、全選目前篩選結果、批次動作 | 工具列、facet、排序鈕、分頁、checkbox、bulkActions 列 | 🟡 | 表頭 checkbox 是 `toggleAllPageRowsSelected`（本頁），不是「全選目前篩選結果」（全部頁）；分頁 client-side |
| 五種狀態：空白／載入／錯誤／無權限／無搜尋結果 | 空白（`emptyTitle`）✅、載入（Skeleton）✅、無搜尋結果（「沒有符合條件的資料」＋清除條件）✅ | 🟡 | **錯誤 ❌、無權限 ❌**；`primitives.tsx` `EmptyState` 註解引用此條但也只做空白 |
| 手機水平滑動；窄螢幕 card/detail 不隱藏必要資料 | overflow-auto 可滑 | 🟡 | 無 card/detail 模式；「欄位」下拉可隱藏欄（使用者自選） |

### 10.4 UX 原則

| 規格條目 | 現有畫面/元件 | 狀態 | 備註 |
|---|---|---|---|
| Dashboard 先「我現在要做什麼」再統計 | 學生「待完成事項」在最上；admin「需要處理」在 StatTile 之前 | ✅ | 老師 Dashboard 反而 StatTile 在最上（小違反） |
| 狀態用人話＋下一步 | `STATE_LABEL`、CTA 依狀態變文案、EmptyState hint | ✅ | |
| 破壞性操作先 preview 再確認 | — | ❌ | 無任何破壞性操作畫面 |
| 表單自動儲存「已儲存／儲存中／失敗」 | — | ❌ | |
| 發布／繳交／評分送出／簽核完成頁或回執 | — | ❌ | |
| 預設繁體中文 | 全站 | ✅ | |

---

## 與規格或專案自訂規範相牴觸之處

1. **canonical 全指首頁**：`app/layout.tsx` 的 `alternates.canonical: "/"`、`openGraph.url: "/"` 會被所有子頁繼承，`news/[id]`、`industry/[id]`、`projects/[id]` 的 `generateMetadata` 只回 `title`，結果每頁 canonical 都是 `/`。違反 §9.2、§14.4「詳情具有穩定 URL」。
2. **中文標題用襯線體**：`app/globals.css` 對 `h1–h4`、`.type-display/.type-section/.type-card-title` 套 `--font-display` = Noto Serif TC（`lib/fonts.ts` 有意為之），但 `docs/ANTI-PATTERNS.md` 第 5 條明寫「中文標題禁用襯線體。前一版用大字 serif 做 hero，氣質完全偏離系網」。首頁 hero `type-display` 正是那個情境。規格 §10.1 本身只說「參考系網」，牴觸的是專案自己的 ANTI-PATTERNS。
3. **角色切換對所有人開放**：`dashboard-header.tsx` 任何角色都能切到 admin。規格 §2.1 只允許多角色帳號切換，且切換不得提升權限。原型有標註，但正式化時要拆掉。
4. **產學案狀態語意錯置**：`IndustryItem.status` 是 `open | claimed`（有無組別），規格 §6.2 的狀態是「草稿／公開／下架」。兩個概念都需要，現在只有一個且名字用錯。
5. **私有欄位由前端遮罩**：`industry/[id]/page.tsx` 把 `privateFields` 渲染給訪客（值是 `＊`）。規格 §6.2／§14.1 要求 server 依角色過濾、不回傳。原型註解已承認，但 fixture 結構會誘導直接沿用。
6. **簽核被塞進專題事務**：`MANAGED_ITEMS` 的 `mi-010 專題成果授權同意書` placement 為 `submission`、`myState: resubmit`，並出現在學生「待完成事項」。規格 §4.6 明說「個人同意屬各自固定流程，不塞進表單編輯器」，簽核應獨立在 `SIGNOFF`（fixture 裡兩者並存，同一份文件重複）。
7. **組別未全員確認卻已 `active`**：`MY_GROUP.status = "active"` 但只有 3/5 `confirmed`。規格 §5.2 五人全部確認後才以 transaction 成組，未成組前應是 `forming`。學生 Dashboard 因此同時顯示「已成立組別」與「等待 2 人確認」。
8. **硬編數字冒充計算**：老師 Dashboard `ProgressBar done={3} total={5}`、admin「缺評老師 `count={2}`」、「逾期未繳 `count={3}`」都是常數，不是從 fixture 算出。原型可接受，但會讓驗收誤以為邏輯已存在。
9. **Data Table 註解與實作不符**：檔頭宣稱「右緣有漸層提示」，程式碼沒有；「全選目前篩選結果」實作為全選本頁。
10. **評分方案 fixture 違反自身規則**：`GRADING_SCHEME.stages[1].items = []`，§7.2 要求每階段項目權重合計 100%；`rules/page.tsx` 又說「期中僅評定通過或不通過」，但方案裡沒有 pass/fail 階段。
11. **卡片封面 16:10**：`ContentCard`、honors、competitions 用 `aspect-[16/10]`，§9.2 預設 16:9（hero 有照做）。
12. **`/news/[id]` 非 slug**：§3.2 寫 `/news/[slug]`；現用 `n-31` 這類 id。路由名可微調，但 SEO 友善度差。
13. **學生「我的組別」導到全體分組表**：nav 對 student 的 `/groups` 標籤是「我的組別」，頁面卻是 `groups/page.tsx` 的全體分組 Data Table（含 admin 視角 StatTile），沒有「我的組別詳情」頁。
14. 學生端可見分數：**無**（已 grep 驗證，符合 §1.4／§7.6）。

---

## 缺的畫面（依規格 §16.7 第一條垂直切片優先序排）

§16.7：管理員登入 → 編輯器建「文件繳交」→ 選位置／對象／欄位／檔案／期限 → 學生 Dashboard 看見待辦 → 同組共用草稿並由一人送出 → 管理員看見完成率、最新版本與歷史版本。

1. **`/dashboard/admin/editor`** — 拖拉式編輯器（§4.4；三欄＋上方發布列：主要位置單選、對象、狀態、預覽、發布）。切片第 2、3 步全部落在這裡。
2. **`/dashboard/admin/affairs`** — 專題事務工作台列表（§4.1、§4.5：Draft／Published／Archived、schema 版本、完成率欄）。
3. **`/dashboard/student/affairs`** 與 **`/dashboard/student/affairs/[id]`** — 學生專題事務列表＋整組共用草稿填寫／上傳頁（§4.6：自動儲存三態、optimistic concurrency 衝突提示、送出確認、**回執頁**、截止鎖定、版本切換）。學生 Dashboard 的所有 CTA 都指向這裡，現在全部 404。
4. **`/dashboard/admin/affairs/[id]`** — 單一項目的完成率、各組最新版本與歷史版本、逾期組別、**指定組別 reopen（理由＋新期限）**（§4.6）。切片最後一步。
5. **`/dashboard/admin/files`** — 檔案與資源檢視／篩選（§4.7；切片提到「檔案」核心）。
6. **`/dashboard/admin/accounts`**（＋`?status=pending` 待審核、CSV 名單匯入 preview、新增／停用／還原／臨時密碼）— §2.4–2.6；切片第 1 步「管理員登入」要能落到真實帳號。
7. **`/dashboard/teacher/affairs`** — 各組繳交狀態（§3.5）。
8. **`/dashboard/teacher/grading`**、**`/grading/[groupId]`**、**`/dashboard/admin/grading`** — 評分工作台與方案管理（§7；§16.4 Prototype C）。
9. **`/dashboard/[role]/signoff`** — 學生閱讀＋同意頁（含不同意原因）、老師同意頁、管理員進度／重開／重置（§8）。
10. **`/dashboard/[role]/industry`** — 老師建立／編輯／下架合作案（三個 textarea、私有欄位）、管理員代管（§6）。
11. **`/dashboard/student/groups`** 的真正「我的組別」— 組長輸入五學號、成員確認／拒絕、類型修改、找組員 opt-in 開關（§5.1–5.3）。
12. **`/dashboard/admin/audit`** — 操作紀錄（§2.2、§3.6）。
13. 零散：忘記密碼／重設頁；`/competitions/[id]`；資源下載公開頁（發布位置「檔案／資源下載」的前台模板）；Data Table 錯誤／無權限狀態、邊緣漸層、固定操作欄；per-page canonical 修正。
