# 工程文件索引（Vault 🛠️ 工程開發 的鏡像）

> **2026-09-13 現況**：15 個 epic＋166 張實作票已發布，[票號對照與發布核對](<slices/🎫 票草稿/02 GitHub 票號對照與發布核對.md>)。S00-01 等 GitHub 方案確認；10 張決策受阻、33 張間接受阻、123 張 planned。PR #7 未合併、正式碼未開始；145 NOT_RUN、4 DEFERRED。下方各輪「未開票／待拆票」是歷史記錄。

2026-09-12 建立；同日第二輪同步整套 v2 文件；第三輪依 Codex 第二輪審查（RR01–RR12 與六小項）修訂為母 spec v3.3、契約 v2.1、模組 v2.1、切片 v2.1、劇本 v1.1，並新增 `operations/00 Roy 前置工作清單.md`；2026-09-13 第四輪依 Codex 對 PR #7 的第三輪 review（A1–A4、B1–B5、O1–O4）修訂為母 spec v3.4；同日第五輪依第四輪 review（C1–C6）修訂為母 spec v3.5、契約 01／05 v2.3、模組 01–10 v2.3、切片 v2.3、B07 v1.3、前置清單 v1.2，並在母 spec §9 與每份子 spec §7.1／7.2 附上 9/11 原型畫面對照（圖檔 `../product/assets/prototype-2026-09-11[-supplement]/`，commit 8e1cff8；沒有原型的流程列缺口）；同日第六輪依第五輪 review（D1）修訂為母 spec v3.6、契約 01 v2.4、契約 03 v2.2、模組 01 v2.4（`session_revocations` 改為一個狀態事件一筆主工作＋多筆收斂工作，收斂核對改唯讀查詢 `users.banned`，兩種保證分開並附逐列序列）、S01／S02 釘版測試。編輯來源在 Vault；這裡只讀。狀態：整套「已寫、待 Roy 與 Codex review」（通過後才拆 ticket）；正式碼未開始；SOP 執行 NOT_RUN；149 案 NOT_RUN（145 待執行、4 DEFERRED）。轉換規則與逐檔 hash 見 `../vault-sync-receipt-2026-09-13-round6.json`（本輪）、`../vault-sync-receipt-2026-09-13-round5.json`、`../vault-sync-receipt-2026-09-13-round4.json`、`../vault-sync-receipt-2026-09-12-round3.json`、`../vault-sync-receipt-2026-09-12-round2.json`、`../vault-sync-receipt-2026-09-12.json` 與 `../vault-sync-manifest.json`。

## 實作 backlog 已發布（2026-09-13）

- GitHub：15 個 epic（#18–#32）與 166 張實作票（#33–#198），對照與狀態統計見 [`slices/🎫 票草稿/02 GitHub 對照.md`](<slices/🎫 票草稿/02 GitHub 對照.md>)；每張票正文＝可讀正文層（白話目標、做到哪裡、Roy 操作→預期表、誰確認、原型圖）＋折疊技術九欄＋分類、依賴與固定來源。直接 BLOCKED 10 張（Roy 產品決策 D-01～D-09、D-11～D-13）、間接受阻 33 張、其餘依前置順序；唯一無前置的票是 S00-01（#33）。發布不等於開工授權：S00 開工前仍須 Roy 確認 GitHub 方案、T3、T2。

## 實作票草稿（2026-09-13，拆票階段，v0.3.1 全套 S00–S14）

- spec 基準 `f974bce`（母 spec v3.6）通過後進入拆票；v0.2 全套 158 張經 Codex 集中 review（F01–F15）後修為 v0.3，再依 Codex 局部 review R01–R08 修為 **v0.3.1：166 張（10 張直接 BLOCKED，待 Roy 產品決策；D-10 已改工程確認）**；修訂腳本從備份還原後連跑兩次零位元差異，重複段落／表格切斷／舊上限殘留檢查 0。入口：[`slices/🎫 票草稿/00 總索引.md`](<slices/🎫 票草稿/00 總索引.md>)、[`01 修訂差異、決策表與覆蓋表 v0.3.md`](<slices/🎫 票草稿/01 修訂差異、決策表與覆蓋表 v0.3.md>)（每項修訂位置、三類決策表、有效依賴圖、行為子項覆蓋表）＋每切片一份。spec 局部回寫：母 spec v3.7、契約 01 v2.5、契約 05 v2.4、模組 02／05／07／08／09／10 v2.4、切片總圖 v2.4、SOP 05 步驟 2（只回寫 review 導出的資料契約與 port，不重開需求）。待 Codex 集中核對局部差異與 Roy 回覆決策；通過後一次開齊 GitHub backlog（可開始票＋明確 BLOCKED 票），開票不等於開工。正式上票前最後核對（Codex 三項局部修正已修）：契約 01 §4.7 表格完整、模組 05 `syncRoster` 只限核准、受阻統計含切片 gate；`slices/🎫 票草稿/正文/SNN 正式正文.md` 是每張票的可讀正文層（白話目標、做到哪裡、Roy 操作→預期表、誰確認、原型圖），GitHub 實作票正文由此＋技術九欄組成。同步 receipt：`../vault-sync-receipt-2026-09-13-round11.json`。

## 寫入規則（2026-10-21，C ⑤-11；#411 第一組）

白話：好幾段程式同時改同一批資料時，大家要照同一個順序去「鎖」，才不會你等我、我等你卡死；字數也只用一種算法，畫面和後端才不會對不上。這節是規則，不是新程式；碰到下列情況，寫法要照做，Review 也照此檢查。

1. **鎖的順序一律固定**（交易內先鎖前面的，再鎖後面的，不准反過來）：
   - 檔案：**同一個檔案內**，先 `stored_files`，再 `file_references`。程式位置：`web/src/infrastructure/accounts/avatar-store.ts:47-59` 的 `softDeleteAvatarFile`（先更新 `stored_files` 標刪、再釋放 `file_references`），呼叫處 `avatar-store.ts:154`、`avatar-store.ts:200`。一次附多個檔時是逐檔做完（一個檔的 `stored_files`＋`file_references` 做完再換下一個，檔案依 id 排序），見 `pg-items.ts:1916-1922`、`pg-submissions.ts:293-304`。
   - 頭像（換頭像、系辦重設）的整串順序：（重設先整組管理員）→ `users` → `user_profiles` → 檔案，寫在 `avatar-store.ts:28-32` 與 `avatar-store.ts:194`。**這串只適用頭像**；停用帳號是先組別（屆別 `FOR SHARE` → 組別 `FOR UPDATE`）再 `users`，見 `web/src/application/groups/ports.ts:131`。
   - 屆別、組、成員：先屆別，再組，最後成員。程式位置：`web/src/infrastructure/groups/pg-groups.ts:1387`（屆別 `FOR SHARE` → 組別 `FOR UPDATE`）；註冊自動開通的整串順序 `cohorts → users → registration_applications → student_identities` 見 `web/src/infrastructure/accounts/registration-command.ts:376`。「組 → 成員」目前只是規則，程式裡沒有集中的一處可指，新寫入照此做。
2. **worker 與網站（兩個程序）會同時寫的資料，用 `pg_advisory_xact_lock`**，並且鎖的鍵要在同一張表列舉，避免兩邊各取各的名字：
   - 交易層級（`pg_advisory_xact_lock`）：交易結束自動放，不會漏放。**本表就是登記處，新增鍵一定要登記**（`git grep -n "pg_advisory"` 應該和本表一一對得上）。注意「雜湊函式」那欄：同一個字串用 `hashtext` 和 `hashtextextended` 算出來是兩把不同的鎖，互不排斥；同一把鎖的所有使用處必須用同一個函式。

     | 鍵（雜湊函式的輸入） | 雜湊函式 | 保護什麼 | 程式位置 |
     |---|---|---|---|
     | `signup-resume:<email>` | `hashtext` | 同一 Email 的註冊續辦／清理排隊 | `signup-resume.ts:302,393,464,500` |
     | `cohorts.<欄位>` | `hashtext` | 同時只有一屆帶 `is_default_working`／`is_registration_open`（設定新屆別時把舊的取消） | `pg-cohorts.ts:235` |
     | `groups.code:<cohortId>` | `hashtext` | 同屆組別代碼不重複 | `pg-groups.ts:691`、`pg-group-import.ts:270` |
     | `groups.student:<studentId>` | `hashtext` | 同一學生同時只能被一個組操作 | `pg-groups.ts:127`、`pg-group-import.ts:292` |
     | `items.rules:<cohortId>` | `hashtextextended`（seed 0） | 同屆規則集合 | `pg-items.ts:190` |
     | `items.resource_category` | `hashtextextended`（seed 0） | 資源分類 | `pg-items.ts:1672` |
     | `reminder:item:<id>`、`reminder:grading:<cohortId>` | `hashtext` | 催繳／評分提醒排隊 | `pg-reminders.ts:163,250,293`（取鎖函式在 498） |
     | `submission_reopen:<itemId>:<receiverId>` | `hashtextextended`（seed 0） | 重新開放繳交 | `pg-submissions.ts:723` |
     | `business_clock_overrides` | `hashtext` | 營運時鐘覆寫 | `pg-business-clock.ts:140` |

   - session 層級（`pg_try_advisory_lock`，綁在專用連線上，程序死掉自動放；也登記在這裡）：

     | 鍵 | 雜湊函式 | 保護什麼 | 程式位置 |
     |---|---|---|---|
     | `fju.worker` | `hashtextextended`（seed 0） | worker 只准一個在跑 | `worker-runtime.ts:10,28`（`WORKER_LOCK_NAME`、`acquireWorkerLock`，放鎖在 46） |
3. **字數一律用 `charLength()`**（`web/src/shared/text.ts`，按字元算，一個表情符號算一個字）。不准用 `.length`（會把表情符號算成兩個字，和畫面計數不一致）。現有用法：`web/src/application/accounts/avatar.ts:84`、`application/cohorts/stages.ts:76`、`application/grading/scheme.ts:164`。
4. **requestId 重播預設回原回執，屆別已封存也一樣**（2026-10-21，#814，主腦裁定）：白話：同一個 requestId 再送一次，等於「上次那件事」，系統只把上次的結果再回你一次，不會再寫資料；就算那一屆後來封存了也照回，因為那次操作在封存前真的成功過。所以寫入命令的順序是先看重播、後看封存（全站約 56 處，不改）。**例外只有 AC-56c 指定的 7 處，封存檢查排在重播之前，封存後重送回 `COHORT_ARCHIVED`**：
   - `pg-submissions.ts`：`saveDraft`（`:210`，封存檢查 `:230`）、`submit`（`:312`，`:330`）、`setAdvisorVisibility`（改閱覽設定，`:553`，`:581`）、`reopen`（開放補交，`:639`，`:680`）、`setExempt`（設免繳，`:802`，`:836`）。
   - `ops/file-storage.ts` 的 `upload`（上傳完成，`:193`，封存檢查 `:220`）：這一處靠的是上傳憑證（ticket）只能用一次，不是 requestId 重播；同樣是封存後重送拿到錯誤而不是舊結果。
   - `signoff/pg-consent-bridge.ts` 的 `createForGroup`（同意書補建，`:228`，封存檢查 `:262` 在重播 `:277` 之前）。
   - 新寫入命令照預設（先重播、後封存）；要變成例外，要有規格明文（像 AC-56c），並在這裡登記。**不要**加「`ledger.begin(` 前必須有封存檢查」的結構測試，會擋到解封與 #715／#788 已裁定的例外。
   - 重新找出「先重播、後封存」的清單（預期印出 56 行與 `total 56`；在 repo 根目錄跑，來源：`docs/reviews/2026-10-21-architecture-security-review.md` 的重播掃描指令）：

     ```sh
     git grep -n -A40 'ledger.begin(' -- web/src/infrastructure ':!*.test.ts' | awk '
     function flush() { if (site != "" && rep && after && site !~ /pg-cohorts\.ts/) { print site; n++ } }
     /^[^ :]+:[0-9]+:.*ledger\.begin\(/ { flush(); split($0, a, ":"); site = a[1] ":" a[2]; rep = 0; after = 0; next }
     /replayed</ { rep = 1; next }
     rep && /status === .archived.|cohortStatus === .archived.|cohort_status === .archived.|archivedBlocks[(]|writeBlocked[(]|groupWriteBlocked[(]/ { after = 1 }
     END { flush(); print "total " n }'
     ```

   - 核對 7 處例外：`git grep -nE "archivedGuard\(|status === 'archived'|replayed<" -- web/src/infrastructure/submissions/pg-submissions.ts web/src/infrastructure/ops/file-storage.ts web/src/infrastructure/signoff/pg-consent-bridge.ts`，每個命令的封存檢查（`archivedGuard(` 或 `status === 'archived'`）行號要小於它自己的 `replayed<` 行號（上傳不走 requestId，只有封存檢查行）；測試見 `archived-readonly.integration.test.ts` 的 AC-56c。
5. 本機工具（教學影片環境）的跨程序鎖是另一組規則，見 [`tools/tutorial/README.md` 的「跨程序鎖」](../../tools/tutorial/README.md#跨程序鎖)。

## GitHub review 入口（2026-09-12）

- 文件 PR：[#7](https://github.com/roy4222/fju-im-project/pull/7)（`docs/engineering-spec-2026-09-12` → `main`；第三輪 commit `2dea682`，最新 head 見 PR；issue 全文與連結釘在第六輪 commit）。
- 母 spec：[issue #6](https://github.com/roy4222/fju-im-project/issues/6)（v3.6 全文含 §9 畫面導覽；頂部表格串起十份子 spec issue 與五份契約）。
- 十份子 spec review issue（全文，同一 commit）：
  - 模組 01 帳號與權限：[#8](https://github.com/roy4222/fju-im-project/issues/8)
  - 模組 02 屆別與年度流程：[#9](https://github.com/roy4222/fju-im-project/issues/9)
  - 模組 03 分組、指導與產學：[#10](https://github.com/roy4222/fju-im-project/issues/10)
  - 模組 04 專題事務發布與編輯：[#11](https://github.com/roy4222/fju-im-project/issues/11)
  - 模組 05 個人與組別繳交：[#12](https://github.com/roy4222/fju-im-project/issues/12)
  - 模組 06 評分與成績：[#13](https://github.com/roy4222/fju-im-project/issues/13)
  - 模組 07 線上簽核：[#14](https://github.com/roy4222/fju-im-project/issues/14)
  - 模組 08 站內通知與日曆：[#15](https://github.com/roy4222/fju-im-project/issues/15)
  - 模組 09 公開展示與共用介面：[#16](https://github.com/roy4222/fju-im-project/issues/16)
  - 模組 10 檔案與服務維運：[#17](https://github.com/roy4222/fju-im-project/issues/17)
- 五份共用契約沒有獨立 issue，在 PR #7 與 issue #6 的表格內連結（`contracts/01–05`）。

閱讀順序：`../ARCHITECTURE.md` → `contracts/01→05` → `modules/01→10` → `slices/00 總圖`、`slices/01 案例責任表` → `verification/2026-09-12-handbook.md` 與 `verification/scripts/` → `operations/`。Codex 從 handbook §1 開始。

| 目錄 | 內容 |
|---|---|
| `../ARCHITECTURE.md` | 工程母 spec v3.7（to-spec 結構；§7 落點表回覆 Codex R01–R17、RR01–RR12、A1–A4／B1–B5／O1–O4、C1–C6、D1；§9 畫面導覽；附錄 B＝v2 歷史參考） |
| `contracts/` | 01 v2.4 資料模型與一致性（共用基礎表字典、逐表權限矩陣、`showcase_drafts`、S11 建表順序、admin plugin 套件欄 `banned`）、02 v2.1 前後端介面與 UI 整合（Server Action 邊界）、03 v2.2 安全與隱私（`/unlink-account` 封鎖；內部能力清單與 `banned` 唯讀查詢）、04 v2.1 測試與驗收（規則層 A；切片出場 ≠ 年度 PASS）、05 v2.3 CI-CD、部署與維運（變數名、告警通道、插槽 host、token 類型、人工 approval） |
| `modules/` | 01 v2.4、02–10 v2.3：模組實作設計（十二節＋附錄 A 資料字典；§7.1 原型畫面對照與 §7.2 缺口；01 撤 session 每人序列化執行器與多筆收斂工作、06 退回鎖序、07 授權範圍從草稿凍結、08 測試事件、09 草稿與版本分開與 S11 建表順序） |
| `slices/` | 00 切片總圖與依賴 v2.3（切片出場與年度案例 PASS 的分界、逐張操作起點；S11 建精選草稿表與空的版本表）、01 案例責任表 v1.2（層 C：149 案→子 spec→劇本步驟→最終責任切片＝缺陷歸屬）、S00–S14 切片卡（出場條件固定四項）；第一條主線 S00→S07 |
| `operations/` | 00 Roy 前置工作清單 v1.2（登入、開通、金鑰、校方申請的現況與待辦；插槽 host、GitHub 能力逐項表與人工 approval、Google Testing 例外；四項待決技術選擇）；SOP 01–06（VM、三組憑證與變數名、部署與健康判定、備份還原與副本一致性窗口、監測與告警通道、staging→正式 reset 範圍） |
| `verification/` | 2026-09-12 操作手冊 v2.3（Codex 總入口，層 B）與 `scripts/` P00–P09 主線劇本、B01–B08 分支劇本（每份十段；B07 v1.3，P02、B01、B06 v1.2，P07、P08、P09、B02–B05 v1.1） |
| `前端慣例.md` | 規格④ 的前端寫法（只在 repo，不鏡像）：不准 `style=`、`pointer-coarse:` 觸控目標、`fx/frame-loop` 用法、特效點開才下載、版面斷點 |
| `../adr/` | 0001–0005（0005 proposed） |

產品規則與案例 ID 只在 `../product/`；工程文件引用不改寫。
