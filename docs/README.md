# 文件與開發入口

2026-09-07 文件集中更新。先讀 [完整規格](specs/product-v1.md)、[目標與範圍](PROJECT.md)、[系統架構與資料流](ARCHITECTURE.md)、[術語](../CONTEXT.md) 及相關 [ADR](adr/)。完整產品規格目前在 Vault 的「設計與決策」，原主 MOC 改為導航。

## 目前狀態

本輪唯讀核對本機 HEAD `15abaccee79a446f7727e1c06e7406acfe31a1ee`，有文件未提交改動。公開頁、登入／註冊畫面、Dashboard 首頁與分組是 fixtures 原型；Auth、DB、正式業務流程與校內 VM 尚無本輪完成證據。本輪未 build、部署或驗收服務。開始開發時另查當下 HEAD 與工作樹。

現行交付目標為 9/10，之後維護；沒有縮減完整 v1。舊時程保存於 Vault 歷史原稿。規格 §19.6 記錄來源差異與實作前仍需釐清的邊界。

## 每份文件的責任

- `PROJECT.md`：完整目的、使用者、成果與來源。
- `ARCHITECTURE.md`：package 宣告版本、現有前端、目標模組與資料流、部署及未決選型。
- `specs/product-v1.md`：完整規格 §0–§21 與後續修訂，不是某一輪功能 ticket。
- `CONTEXT.md`：領域詞彙，保持與 Vault 原文一致。
- `adr/`：重要取捨與原因，三份既有決策不代表實作完成。
- `vault-sync-manifest.json`：來源／鏡像 hash；來源與轉換後鏡像各自核對。

## 討論與同步

[Vault 文件分工與開發接續](</Users/lubaiyu/Documents/roy422的人生online/專案/🌐 網站與互動/📁 輔大資管系專題網站/🧭 設計與決策/🧭 文件分工與開發接續.md>)保存完整操作方式。需求先在 Vault 的完整產品規格討論、回寫；依影響更新目標、架構、術語及 ADR，再同步 repo。開發時發現差異也要回寫 Vault，不能由程式默默取代需求。原始日記與會議留 Vault。

開始先比對 HEAD、工作樹與來源內容；兩邊有改動先整合，再轉換連結並重新計算 hash。完整正文與後續修訂都要同步；不只擷取舊 §0–§20。這是當次收尾步驟，沒有背景同步。

`grill-me` 轉用 `grilling`，已決定的需求直接沿用，只釐清真正未決事項。其後可按任務使用 `grill-with-docs → to-spec → to-tickets → implement → code-review`；先讀當時技能和 repo 規則，不能把這份文件當成自動發布／部署授權。

第一條正式路徑沿用 §16.7：管理員建立文件繳交 → 學生共用草稿與整組送出 → 管理員追蹤版本。按依賴形成可驗證切片，不重做已存在的全部原型。

## 既有資產

- [根 README](../README.md)：前端執行與已知缺口。
- [原型封存](_archive/codex-open-design-prototypes/README.md)：歷史設計探索，非正式系統。
- [反樣式清單](ANTI-PATTERNS.md)、[設計同步踩坑](../.design-sync/NOTES.md)：保留本人回饋與元件限制。
- [0001 單一應用](adr/0001-school-owned-modular-monolith.md)、[0002 不遷移舊 DB](adr/0002-new-system-without-legacy-migration.md)、[0003 統一事務](adr/0003-unified-project-affairs.md)。

七月 Better Auth／PostgreSQL 探索有歷史紀錄，不能因目前 repo 缺後端而抹去；取得舊程式前也不直接算新版完成。README 字體與 ANTI-PATTERNS 的已知差異留到 UI 工作確認。Auth、ORM、proxy、備份等選型依規格保持未決，不把 README 的傾向當成封板。
