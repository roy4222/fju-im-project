# 工程文件索引（Vault 🛠️ 工程開發 的鏡像）

2026-09-12 建立；同日第二輪同步整套 v2 文件；第三輪依 Codex 第二輪審查（RR01–RR12 與六小項）修訂為母 spec v3.3、契約 v2.1、模組 v2.1、切片 v2.1、劇本 v1.1，並新增 `operations/00 Roy 前置工作清單.md`；2026-09-13 第四輪依 Codex 對 PR #7 的第三輪 review（A1–A4、B1–B5、O1–O4）修訂為母 spec v3.4；同日第五輪依第四輪 review（C1–C6）修訂為母 spec v3.5、契約 01／05 v2.3、模組 01–10 v2.3、切片 v2.3、B07 v1.3、前置清單 v1.2，並在母 spec §9 與每份子 spec §7.1／7.2 附上 9/11 原型畫面對照（圖檔 `../product/assets/prototype-2026-09-11[-supplement]/`，commit 8e1cff8；沒有原型的流程列缺口）；同日第六輪依第五輪 review（D1）修訂為母 spec v3.6、契約 01 v2.4、契約 03 v2.2、模組 01 v2.4（`session_revocations` 改為一個狀態事件一筆主工作＋多筆收斂工作，收斂核對改唯讀查詢 `users.banned`，兩種保證分開並附逐列序列）、S01／S02 釘版測試。編輯來源在 Vault；這裡只讀。狀態：整套「已寫、待 Roy 與 Codex review」（通過後才拆 ticket）；正式碼未開始；SOP 執行 NOT_RUN；149 案 NOT_RUN（145 待執行、4 DEFERRED）。轉換規則與逐檔 hash 見 `../vault-sync-receipt-2026-09-13-round6.json`（本輪）、`../vault-sync-receipt-2026-09-13-round5.json`、`../vault-sync-receipt-2026-09-13-round4.json`、`../vault-sync-receipt-2026-09-12-round3.json`、`../vault-sync-receipt-2026-09-12-round2.json`、`../vault-sync-receipt-2026-09-12.json` 與 `../vault-sync-manifest.json`。

## 實作票草稿（2026-09-13，拆票階段，v0.2 全套 S00–S14）

- Codex 核對 `f974bce` 後判 D1 閉合、無阻止拆票的文件問題；Roy 決定進入拆票並要求一次拆完 S00–S14。全套票草稿在 [`slices/🎫 票草稿/`](<slices/🎫 票草稿/>)：[00 總索引](<slices/🎫 票草稿/00 總索引.md>)（158 張票的票號、目標、前置、spec／案例對照、待 Roy 條件、跨切片依賴、核對結果、各切片起草時發現的 spec 問題）＋每切片一份 `SNN 票草稿.md`。v0.2 已納入第一批 review 的五項修正（共用工具前置、頁面殼與整合分離、預授權沿同一帳號、GitHub 方案確認時點、通知已讀驗證）與 S02-05 拆三張；第一批草稿檔已移除。待 Codex 集中 review 與 Roy 審；審過後才在 GitHub 開 epic 與票，開票不等於開工。同步 receipt：`../vault-sync-receipt-2026-09-13-round8.json`。

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
| `../ARCHITECTURE.md` | 工程母 spec v3.6（to-spec 結構；§7 落點表回覆 Codex R01–R17、RR01–RR12、A1–A4／B1–B5／O1–O4、C1–C6、D1；§9 畫面導覽；附錄 B＝v2 歷史參考） |
| `contracts/` | 01 v2.4 資料模型與一致性（共用基礎表字典、逐表權限矩陣、`showcase_drafts`、S11 建表順序、admin plugin 套件欄 `banned`）、02 v2.1 前後端介面與 UI 整合（Server Action 邊界）、03 v2.2 安全與隱私（`/unlink-account` 封鎖；內部能力清單與 `banned` 唯讀查詢）、04 v2.1 測試與驗收（規則層 A；切片出場 ≠ 年度 PASS）、05 v2.3 CI-CD、部署與維運（變數名、告警通道、插槽 host、token 類型、人工 approval） |
| `modules/` | 01 v2.4、02–10 v2.3：模組實作設計（十二節＋附錄 A 資料字典；§7.1 原型畫面對照與 §7.2 缺口；01 撤 session 每人序列化執行器與多筆收斂工作、06 退回鎖序、07 授權範圍從草稿凍結、08 測試事件、09 草稿與版本分開與 S11 建表順序） |
| `slices/` | 00 切片總圖與依賴 v2.3（切片出場與年度案例 PASS 的分界、逐張操作起點；S11 建精選草稿表與空的版本表）、01 案例責任表 v1.2（層 C：149 案→子 spec→劇本步驟→最終責任切片＝缺陷歸屬）、S00–S14 切片卡（出場條件固定四項）；第一條主線 S00→S07 |
| `operations/` | 00 Roy 前置工作清單 v1.2（登入、開通、金鑰、校方申請的現況與待辦；插槽 host、GitHub 能力逐項表與人工 approval、Google Testing 例外；四項待決技術選擇）；SOP 01–06（VM、三組憑證與變數名、部署與健康判定、備份還原與副本一致性窗口、監測與告警通道、staging→正式 reset 範圍） |
| `verification/` | 2026-09-12 操作手冊 v2.3（Codex 總入口，層 B）與 `scripts/` P00–P09 主線劇本、B01–B08 分支劇本（每份十段；B07 v1.3，P02、B01、B06 v1.2，P07、P08、P09、B02–B05 v1.1） |
| `../adr/` | 0001–0005（0005 proposed） |

產品規則與案例 ID 只在 `../product/`；工程文件引用不改寫。
