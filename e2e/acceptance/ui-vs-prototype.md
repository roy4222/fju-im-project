# 外觀對照：測試站 vs 原型

- 目的：逐頁把測試站 `https://test.fju.roy422.dev` 的**外觀與版型**跟原型 `https://fju-prototype.roy422roy.workers.dev` 比，列出差異。畫面以原型為準（前台已定稿；後台照原型）。
- 前提：測試站已部署最新 main；Doppler stg 有 `E2E_ADMIN_EMAIL`、`E2E_ADMIN_PASSWORD`。
- 帳號：E2E 管理員（帳密在環境變數，不要寫在這裡）。老師與學生頁需要老師、學生身分，測試站**沒有現成的測試帳號**，第 2–4 步自己建（都帶 `CODEX-` 前綴），最後收尾停用。
- **原型只能看**：原型是假資料的展示站，不用登入。只開頁面、截圖、用它的「切換角色」；不要在原型上填表或按送出。原型的後台直接開網址 `/dashboard/<角色>/…` 就行（`<角色>`＝`admin`、`teacher`、`student`），也可以用頂列右上帳號選單的「切換角色（原型）」。
- **原型是假資料：內容不同不算差異。** 名字、數字、筆數、日期、文章內容、圖表的值不一樣都不用記。只比：
  - 版型：欄數、區塊排列順序、寬度、卡片／表格／清單的形式；
  - 側欄與頂列：有沒有、位置、寬度、項目分組與順序、圖示、頁名、通知鈴鐺、帳號選單；
  - 配色：是否只有系網橘一個主軸色（按鈕、選取、連結、重點數字），有沒有多出別的顯眼顏色；深淺底色是否一致；
  - 元件樣式：按鈕、輸入框、標籤（badge）、表格、對話框觸發鈕的形狀、圓角、陰影、邊框；
  - 字級與字重：頁標題、區塊標題、內文、表格字；
  - 間距：頁面內距、卡片間距、表格列高；
  - 缺少的區塊（原型有、測試站沒有）與多出的東西（測試站有、原型沒有）。
- **測試站是空狀態**（還沒有資料，只顯示「目前沒有……」）時，只比外框（側欄、頂列、標題區、空狀態卡片的樣式），並在「看到什麼」註明「測試站空狀態」。原型沒有對應頁（404 或空白）就記「原型沒有對應頁」，結果記「明顯不同」。
- 工作階段（Playwright CLI 的 `--session`）：`proto`（原型，不登入）、`visitor`（測試站訪客，不登入）、`admin`（E2E 管理員）、`teacher`（這一輪的老師）、`student`（這一輪的學生）。
- 用臺灣時間取一個代號 `<T>`＝月日時分（例如 `09251430`），下面的 `<T>` 一律換成它。自己編一組這一輪的測試密碼（至少 12 個字元），**測試密碼與臨時密碼都不要寫進報告**。

## 每一頁怎麼比（第 5 步以後每一步都照這個做）

1. 兩個視窗寬度各做一次：**桌面 1440×900**、**手機 390×844**（Playwright CLI 用 `resize`；換寬度後重新整理再截圖）。
2. 每個寬度各截兩張整頁圖：原型那一張、測試站那一張，檔名：
   - `screenshots/NN-<英文頁名>-proto-1440.png`、`screenshots/NN-<英文頁名>-test-1440.png`
   - `screenshots/NN-<英文頁名>-proto-390.png`、`screenshots/NN-<英文頁名>-test-390.png`
   （NN 是步驟編號。環境裡有 ImageMagick 或 Python PIL 的話，另外合成左右並排的 `NN-<英文頁名>-side-1440.png`、`NN-<英文頁名>-side-390.png`；沒有就不用。）
3. 一張一張對著看，照上面「只比」的項目列出差異；手機寬另外看側欄是否收成選單鈕、表格是否變卡片或能橫向捲動、有沒有整頁橫向捲動。
4. 這一步的「結果」只填三級之一：
   - **明顯不同**：版型、側欄／頂列、主軸色、缺整個區塊這類一眼看得出的不同；
   - **小差異**：字級、間距、圓角、陰影、圖示、按鈕樣式這類細節；
   - **一致**：看不出外觀上的差別。
5. 「看到什麼」欄寫差異清單（最多 5 點，最重要的先寫，桌面與手機分開寫，例如「桌面：測試站側欄沒有分組標題；手機：頂列沒有鈴鐺」）；「截圖」欄寫 test-1440 那一張，其他三張檔名照規則推得出來。

## 報告格式（這份清單專用）

- 報告表格照腳本給的格式，但「結果」欄填「明顯不同／小差異／一致」（第 1–4 步與收尾步驟照常填「通過／不通過」）。
- 表格之後，加一節 `## 差異彙整`，一張表：

| 頁面 | 原型路由 | 測試站路由 | 桌面 | 手機 | 最主要的差異 |
|---|---|---|---|---|---|
| 首頁 | `/` | `/` | 小差異 | 明顯不同 | …… |

- 最後一行寫：`總結：明顯不同 A、小差異 B、一致 C`（只算頁面對照的步驟；桌面與手機取比較差的那一級）。

## 準備

1. **管理員登入**（工作階段 `admin`）
   - 做：打開 `https://test.fju.roy422.dev/login` 用 E2E 管理員登入，再打開 `https://test.fju.roy422.dev/dashboard/admin`。
   - 預期：看到「系辦首頁」。
2. **建一位老師**（工作階段 `admin`）
   - 做：打開 `https://test.fju.roy422.dev/dashboard/admin/accounts`，按「新增老師」，「登入 Email」填 `codex-ui-<T>-teacher@example.com`、「姓名」填 `CODEX-UI-<T>老師`，勾「當面核對學生證或其他身分證件」，按「建立並產生臨時密碼」；把臨時密碼**只記在心裡**，按「關閉」。**臨時密碼顯示時不要截圖。**
   - 預期：出現「只顯示這一次」與臨時密碼。
3. **老師第一次登入**（工作階段 `teacher`）
   - 做：`/login` 用老師的 Email 與臨時密碼登入；改密頁「目前的一次性密碼」填臨時密碼、「新密碼」「再輸入一次新密碼」填測試密碼，按「設定新密碼」；補資料頁「手機」填 `0911-111-111`，按「儲存並進入老師首頁」。
   - 預期：最後到 `/dashboard/teacher`，標題「老師首頁」。
4. **建一位學生**（工作階段 `student`，核准用 `admin`）
   - 做：打開 `https://test.fju.roy422.dev/register`，填姓名 `CODEX-UI-<T>學生`、學號 `9<T>01`、系級 `資管二甲`、手機 `0912-345-678`、登入 Email `codex-ui-<T>-student@example.com`、密碼與確認密碼填測試密碼，按「送出註冊」。接著 `admin` 在帳號頁按「審核 CODEX-UI-<T>學生」，勾「當面核對學生證或其他身分證件」；這位學生不在名單上，要指定屆別：有預選就用預選的那一屆，沒有預選就選一個 `CODEX-` 開頭的屆別（都沒有就選列表第一個），**不要去改屆別旗標**。按「核准」再「關閉」。最後把 `student` 工作階段 `close` 再重新 `open`（換掉待審時的登入狀態），用學生的 Email 與測試密碼登入。
   - 預期：學生登入後到 `/dashboard/student`，標題「我的專題」。

## 前台（原型與測試站路由相同）

測試站用 `visitor` 工作階段（不登入）；第 10、11 步的「檔案下載」「產學合作」要登入才看得到內容，測試站改用 `admin` 工作階段。

5. **首頁 `/`**（英文頁名 `home`）
6. **登入頁 `/login`**（`login`）
7. **註冊頁 `/register`**（`register`）
8. **最新公告 `/news`**（`news`）；列表有公告的話，再各點第一則看內容頁 `/news/<id>`，差異一起寫在這一步。
9. **專題規則 `/rules`**（`rules`）
10. **檔案下載 `/files`**（`files`）
11. **產學合作 `/industry`**（`industry`）；列表有合作案的話，再各點第一個看 `/industry/<id>`，差異一起寫在這一步。
12. **本人帳號頁 `/account`**（`account`；測試站用 `admin` 工作階段）

## 系辦後台（原型 `/dashboard/admin/…`；測試站用 `admin` 工作階段）

13. **系辦首頁**：原型 `/dashboard/admin`、測試站 `/dashboard/admin`（`admin-home`）
14. **帳號管理**：原型 `/dashboard/admin/accounts`、測試站 `/dashboard/admin/accounts`（`admin-accounts`）
15. **屆別**：原型 `/dashboard/admin/timeline`（只比其中屆別的部分）、測試站 `/dashboard/admin/cohorts`（`admin-cohorts`）
16. **時間軸設定**：原型 `/dashboard/admin/timeline`、測試站 `/dashboard/admin/timeline`（`admin-timeline`）
17. **分組總覽**：原型 `/dashboard/admin/groups`、測試站 `/dashboard/admin/groups`（`admin-groups`）
18. **專題事務工作台**：原型 `/dashboard/admin/affairs`、測試站 `/dashboard/admin/affairs`（`admin-affairs`）；工作台有項目的話，各點第一個看收件名單頁 `/dashboard/admin/affairs/<id>`，差異一起寫。
19. **內容編輯器**：原型 `/dashboard/admin/editor`、測試站 `/dashboard/admin/editor/new`（`admin-editor`）。**只看，不要按存草稿或發布。**
20. **產學合作**：原型 `/dashboard/admin/industry`、測試站 `/dashboard/admin/industry`（`admin-industry`）
21. **成績管理／評分**：原型 `/dashboard/admin/grading`、測試站 `/dashboard/admin/grading`（`admin-grading`）
22. **通知匣**：原型 `/dashboard/admin/inbox`、測試站 `/dashboard/admin/inbox`（`admin-inbox`）。**不要按「發送測試通知」。**

## 老師後台（原型 `/dashboard/teacher/…`；測試站用 `teacher` 工作階段）

23. **老師首頁**：`/dashboard/teacher`（`teacher-home`）
24. **分組**：`/dashboard/teacher/groups`（`teacher-groups`）。**不要按「認領」。**
25. **各組繳交**：`/dashboard/teacher/affairs`（`teacher-affairs`）
26. **我的合作案**：`/dashboard/teacher/industry`（`teacher-industry`）。**不要新增合作案。**
27. **評分**：`/dashboard/teacher/grading`（`teacher-grading`）
28. **通知匣**：`/dashboard/teacher/inbox`（`teacher-inbox`）

## 學生後台（原型 `/dashboard/student/…`；測試站用 `student` 工作階段；第 4 步不通過就全部略過）

29. **學生首頁（含行事曆）**：`/dashboard/student`（`student-home`）
30. **我的組別**：`/dashboard/student/groups`（`student-groups`）。**不要按「公開找組員」或發起提案。**
31. **作業區**：`/dashboard/student/affairs`（`student-affairs`）
32. **成績**：`/dashboard/student/grading`（`student-grading`）
33. **通知匣**：`/dashboard/student/inbox`（`student-inbox`）
33a. **專題時間軸**：`/dashboard/student/timeline`（`student-timeline`；票 38 新頁）。點一下目前階段以外的一張卡片看展開，再點回來。
33b. **作業內容**：作業區有收件的話，點第一個看 `/dashboard/student/affairs/<id>`（原型 `/dashboard/student/affairs/mi-011`），再點「繳交歷史」分頁（`student-affair`）。**不要按儲存草稿或正式送出。**
33c. **產學合作**：`/dashboard/student/industry`（`student-industry`；票 38 新頁）
33d. **同意書**：`/dashboard/student/signoff`（`student-signoff`）。**不要勾「已完整閱讀」或按同意／不同意。**

## 收尾（不論前面成敗，一定要做）

34. **停用這一輪的老師與學生**（工作階段 `admin`）
    - 做：打開 `https://test.fju.roy422.dev/dashboard/admin/accounts?q=CODEX-UI-<T>`。學生若還在待審核清單，按「審核」→ 理由填 `CODEX 外觀對照收尾` → 「退回」；已核准的老師與學生各按「停用」，理由填 `CODEX 外觀對照收尾：停用測試帳號`，按「確認停用」。**只動姓名完全等於 `CODEX-UI-<T>老師`、`CODEX-UI-<T>學生` 的兩位。**
    - 預期：兩位都是「已停用」（或學生是「已退回」）。
35. **登出**
    - 做：`admin` 按「登出」。
    - 預期：回到登入頁或首頁。

## 失敗時

- 第 1 步不通過：後台頁都做不了；前台（第 5–11 步）照做，其餘略過。
- 第 2–3 步不通過：老師頁（第 23–28 步）略過，記「沒有老師身分」。
- 第 4 步不通過：學生頁（第 29–33d 步）略過，記「沒有學生身分」。
- 某一頁打不開（測試站 404／500、原型 404）：照「每一頁怎麼比」的第 4 點記「明顯不同」並寫原因，繼續下一頁。
- 收尾第 34–35 步一定要做。
- 管理員只登入**一次**、整條流程共用 `admin` 工作階段（登入限速：同 IP 同帳號 10 分鐘 10 次）。
