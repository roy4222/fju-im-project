# 工程文件索引（Vault 🛠️ 工程開發 的鏡像）

2026-09-12 建立；同日第二輪同步整套 v2 文件；第三輪依 Codex 第二輪審查（RR01–RR12 與六小項）修訂為母 spec v3.3、契約 v2.1、模組 v2.1、切片 v2.1、劇本 v1.1，並新增 `operations/00 Roy 前置工作清單.md`；2026-09-13 第四輪依 Codex 對 PR #7 的第三輪 review（A1–A4、B1–B5、O1–O4）修訂為母 spec v3.4、契約 01 v2.2／03 v2.1／05 v2.2、模組 01／06／07／08／09 v2.2、切片 v2.2、責任表 v1.2、劇本 P02／B01／B06／B07 v1.2、前置清單 v1.1。編輯來源在 Vault；這裡只讀。狀態：整套「已寫、待 Roy 與 Codex review」（通過後才拆 ticket）；正式碼未開始；SOP 執行 NOT_RUN；149 案 NOT_RUN（145 待執行、4 DEFERRED）。轉換規則與逐檔 hash 見 `../vault-sync-receipt-2026-09-13-round4.json`（本輪）、`../vault-sync-receipt-2026-09-12-round3.json`、`../vault-sync-receipt-2026-09-12-round2.json`、`../vault-sync-receipt-2026-09-12.json` 與 `../vault-sync-manifest.json`。

## GitHub review 入口（2026-09-12）

- 文件 PR：[#7](https://github.com/roy4222/fju-im-project/pull/7)（`docs/engineering-spec-2026-09-12` → `main`；第三輪 commit `2dea682`，第四輪 commit 見 PR 最新 head，issue 全文與連結釘在第四輪 commit）。
- 母 spec：[issue #6](https://github.com/roy4222/fju-im-project/issues/6)（v3.4 全文；頂部表格串起十份子 spec issue 與五份契約）。
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
| `../ARCHITECTURE.md` | 工程母 spec v3.4（to-spec 結構；§7 落點表回覆 Codex R01–R17、第二輪 RR01–RR12 與第三輪 A1–A4／B1–B5／O1–O4；附錄 B＝v2 歷史參考） |
| `contracts/` | 01 v2.2 資料模型與一致性（共用基礎表字典、逐表權限矩陣、`showcase_drafts`）、02 v2.1 前後端介面與 UI 整合（Server Action 邊界）、03 v2.1 安全與隱私（`/unlink-account` 封鎖）、04 v2.1 測試與驗收（規則層 A；切片出場 ≠ 年度 PASS）、05 v2.2 CI-CD、部署與維運（變數名、告警通道、插槽 host、token 類型） |
| `modules/` | 01／06／07／08／09 v2.2、其餘 v2.1：01–10 模組實作設計（十二節＋附錄 A 資料字典；01 撤 session 重試取消、06 退回鎖序、07 授權範圍從草稿凍結、08 測試事件、09 草稿與版本分開） |
| `slices/` | 00 切片總圖與依賴 v2.2（切片出場與年度案例 PASS 的分界、逐張操作起點；S11 交付最小精選草稿）、01 案例責任表 v1.2（層 C：149 案→子 spec→劇本步驟→最終責任切片＝缺陷歸屬）、S00–S14 切片卡（出場條件固定四項）；第一條主線 S00→S07 |
| `operations/` | 00 Roy 前置工作清單 v1.1（登入、開通、金鑰、校方申請的現況與待辦；插槽 host、GitHub 方案限制；四項待決技術選擇）；SOP 01–06（VM、三組憑證與變數名、部署與健康判定、備份還原與副本一致性窗口、監測與告警通道、staging→正式 reset 範圍） |
| `verification/` | 2026-09-12 操作手冊 v2.2（Codex 總入口，層 B）與 `scripts/` P00–P09 主線劇本、B01–B08 分支劇本（每份十段；P02、B01、B06、B07 為 v1.2，P07、P08、P09、B02–B05 為 v1.1） |
| `../adr/` | 0001–0005（0005 proposed） |

產品規則與案例 ID 只在 `../product/`；工程文件引用不改寫。
