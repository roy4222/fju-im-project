# 工程文件索引（Vault 🛠️ 工程開發 的鏡像）

2026-09-12 建立；同日第二輪同步整套 v2 文件；第三輪依 Codex 第二輪審查（RR01–RR12 與六小項）修訂為母 spec v3.3、契約 v2.1、模組 v2.1、切片 v2.1、劇本 v1.1，並新增 `operations/00 Roy 前置工作清單.md`。編輯來源在 Vault；這裡只讀。狀態：整套「已寫、待 Roy 與 Codex review」（通過後才拆 ticket）；正式碼未開始；SOP 執行 NOT_RUN；149 案 NOT_RUN（145 待執行、4 DEFERRED）。轉換規則與逐檔 hash 見 `../vault-sync-receipt-2026-09-12-round3.json`（本輪）、`../vault-sync-receipt-2026-09-12-round2.json`、`../vault-sync-receipt-2026-09-12.json` 與 `../vault-sync-manifest.json`。

## GitHub review 入口（2026-09-12）

- 文件 PR：`docs/engineering-spec-2026-09-12` → `main`（編號見 PR 列表；本節在 PR 建立後補上）。
- 母 spec issue #6：更新為 v3.3 全文，並串起十份子 spec review issue 與五份契約。
- 十份子 spec review issue：建立後在本節列出編號（模組 01–10）。

閱讀順序：`../ARCHITECTURE.md` → `contracts/01→05` → `modules/01→10` → `slices/00 總圖`、`slices/01 案例責任表` → `verification/2026-09-12-handbook.md` 與 `verification/scripts/` → `operations/`。Codex 從 handbook §1 開始。

| 目錄 | 內容 |
|---|---|
| `../ARCHITECTURE.md` | 工程母 spec v3.3（to-spec 結構；§7 落點表回覆 Codex R01–R17 與第二輪 RR01–RR12；附錄 B＝v2 歷史參考） |
| `contracts/` | v2.1：01 資料模型與一致性（含共用基礎表字典、逐表權限矩陣、帳本協議）、02 前後端介面與 UI 整合（Server Action 邊界）、03 安全與隱私（v2）、04 測試與驗收（規則層 A；切片出場 ≠ 年度 PASS）、05 CI-CD、部署與維運（變數名、告警通道） |
| `modules/` | v2.1：01–10 模組實作設計（十二節＋附錄 A 資料字典，含九張輔助表逐欄） |
| `slices/` | 00 切片總圖與依賴 v2.1（切片出場與年度案例 PASS 的分界、逐張操作起點）、01 案例責任表 v1.1（層 C：149 案→子 spec→劇本步驟→最終責任切片＝缺陷歸屬）、S00–S14 切片卡（出場條件固定四項）；第一條主線 S00→S07 |
| `operations/` | 00 Roy 前置工作清單（登入、開通、金鑰、校方申請的現況與待辦；四項待決技術選擇）；SOP 01–06（VM、三組憑證與變數名、部署與健康判定、備份還原與副本一致性窗口、監測與告警通道、staging→正式 reset 範圍） |
| `verification/` | 2026-09-12 操作手冊 v2.1（Codex 總入口，層 B）與 `scripts/` P00–P09 主線劇本、B01–B08 分支劇本（每份十段；P02、P07、P08、P09、B01–B07 為 v1.1） |
| `../adr/` | 0001–0005（0005 proposed） |

產品規則與案例 ID 只在 `../product/`；工程文件引用不改寫。
