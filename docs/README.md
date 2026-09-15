# 文件與開發入口

> **2026-09-15 S00 已實作**：E00（#18）／S00-01–S00-11（#33–#43）完成，停在 [PR #199](https://github.com/roy4222/fju-im-project/pull/199)。正式碼 `web/` 從這一批開始存在，CI 七道實際跑過全綠。T3＝application 用例＋真 PostgreSQL、T2＝CSP 方案 A，由 Roy 定案。證據在 `steps/S00/`。沒有真部署、沒有動線上原型；branch protection 仍 **pending**；149 案狀態不變。


> **2026-09-15**：Roy 確認評分不改，補齊名單匯出及系級流程；[本次定案](<product/💬 討論與決策/2026-09-15 名單匯入匯出與系級定案.md>)。GitHub 既有票更新，正式功能未實作。


> **2026-09-13 現況**：15 個 epic＋166 張實作票已發布，[票號對照與發布核對](<engineering/slices/🎫 票草稿/02 GitHub 票號對照與發布核對.md>)。S00-01 等 GitHub 方案確認；10 張決策受阻、33 張間接受阻、123 張 planned。PR #7 未合併、正式碼未開始；145 NOT_RUN、4 DEFERRED。下方各輪「未開票／待拆票」是歷史記錄。

2026-09-11：產品文件已按模組拆分並同步本repo。先看 [產品規劃MOC](<product/🗺️ 專案目標與產品規劃.md>)、[產品總規格](<product/📐 產品總規格.md>)，再看十個模組。每模組含完整規則與案例，年度主線、例外及接受條件已有正文。

2026-09-12：Roy 與 Fable 以 grill-with-docs 七輪定案 17 題（帳號、個人收件、分組、時間與年度、評分異動、站內通知、校方確認），已回寫十模組、總規格 §4、年度主線、CONTEXT 與 [覆蓋矩陣](<product/✅ 接受條件/03 案例覆蓋矩陣.md>)（149 案，全部 NOT_RUN）。每輪定案頁在 [討論與決策](<product/💬 討論與決策/AGENTS.md>)；校方要提供或核可的事集中在 [校方確認清單](<product/💬 討論與決策/2026-09-12 校方確認清單.md>)。仍待校方：Q-ACC03 資料、Q-GRP05 例外組人數、Q-SUB04 老師填表、Q-SGN01／SHW01／FIL01 的採認、素材與容量證據。

## 目前範圍與狀態

9/14為VM測試帳號試用，以完整產品為目標；正式開放日期另定。Email寄送、Google Calendar／外部.ics訂閱整合延後；站內通知、站內日曆與Google OAuth登入保留。本次只完成產品文件，未改應用、未部署、未連VM、未跑功能驗收；149案（2026-09-12 起）例全部NOT_RUN。工程現况由Fable核對，不以舊README日期判定。

## 產品文件

- [年度主線](<product/🔁 年度情境/01 完整年度主線.md>)與[例外](<product/🔁 年度情境/02 例外情境與重跑規則.md>)：同資料集走完整一年。
- [VM試用](<product/✅ 接受條件/01 VM 試用接受條件.md>)、[正式Gate](<product/✅ 接受條件/02 正式開放 Gate.md>)、[覆蓋矩陣](<product/✅ 接受條件/03 案例覆蓋矩陣.md>)。
- [17項待討論（2026-09-12 全部有落點）](<product/💬 討論與決策/2026-09-11 產品待討論清單.md>)、[工程交接](<product/💬 討論與決策/2026-09-11 交給 Fable 的工程接續.md>)、[原規格承接](<product/💬 討論與決策/2026-09-11 原規格承接對照.md>)。
- [前台頁面清單](<product/🗺️ 前台頁面清單.md>)、[後台頁面](DASHBOARD-PAGES.md)、[術語](<product/CONTEXT.md>)：現行副本在 `docs/product/`；根目錄 `CONTEXT.md` 與 `docs/FRONTEND-PAGES.md` 是同文副本並在頂部導向，只為相容舊路徑。

## 工程文件（2026-09-12 起）

Vault「🛠️ 工程開發」的鏡像（2026-09-13 第六輪，依 Codex 對 PR #7 的第五輪 review D1 修訂 `session_revocations` 為「一個狀態事件一筆主工作＋多筆收斂工作」並改收斂核對讀法；第五輪已依第四輪 review C1–C6 修訂並在母 spec §9 與十份子 spec §7.1／7.2 附上 9/11 原型畫面對照，圖檔為 `product/assets/`）：[工程母 spec v3.7](ARCHITECTURE.md)、[共用契約 01–05（01 v2.5、02 v2.1、03 v2.2、04 v2.1、05 v2.4）](<engineering/contracts/>)、[模組實作設計 01–10（01、02、05、07、08、09、10 v2.4，03、04、06 v2.3；含資料字典與原型畫面對照）](<engineering/modules/>)、[實作切片總圖 v2.4](<engineering/slices/00 切片總圖與依賴.md>)、[案例責任表 v1.2](<engineering/slices/01 案例責任表.md>)、S00–S14、[Roy 前置工作清單 v1.2](<engineering/operations/00 Roy 前置工作清單.md>) 與 [部署 SOP 01–06](<engineering/operations/>)、[操作手冊 v2.3](<engineering/verification/2026-09-12-handbook.md>) 與 [Codex 劇本 P00–P09、B01–B08](<engineering/verification/scripts/>)、[ADR 0001–0005](adr/)。索引、閱讀順序與 GitHub review issue／PR 編號見 [engineering/README.md](engineering/README.md)。狀態：整套「已寫、待 Roy 與 Codex review」，通過後才拆 ticket；正式碼 `web/` 未開始；SOP 執行 NOT_RUN；149 案 NOT_RUN（145 待執行、4 DEFERRED）。同步 receipt：[round6](vault-sync-receipt-2026-09-13-round6.json)、[round5](vault-sync-receipt-2026-09-13-round5.json)、[round4](vault-sync-receipt-2026-09-13-round4.json)、[round3](vault-sync-receipt-2026-09-12-round3.json)、[round2](vault-sync-receipt-2026-09-12-round2.json)、[首輪](vault-sync-receipt-2026-09-12.json)。

## 工程接續

[架構](ARCHITECTURE.md)、[ADR](adr/)、prototype與未來web正式碼由Fable依產品交接接續。舊架構正文可能仍帶拆分前引用與待同步決定，不能據此覆蓋新產品條文。工程區十模組設計、切片、部署維運、操作驗證與目前進度由Fable補寫。正式碼按需從prototype搬頁並拆元件，不整包升格；操作改動先改原型讓Roy確認，再回寫規格。

## 來源與同步

Vault現行來源位於「輔大資管系專題網站／🎯 專案目標」，工程來源在「🛠️ 工程開發」。需求先回寫Vault總規格／對應模組與決策，再同步這裡；不能只改repo鏡像。

每次先比對來源與工作樹，保留並整合雙邊改動，再轉換連結並更新 [來源與鏡像hash](vault-sync-manifest.json)。文件 PR 合併後，主工作副本（`proto/role-ux-round1`）不要只跑裸的 `git checkout -- . && git clean -fd docs`：那只清工作樹、不會把合併後的 `main` 帶進目前分支；完整程序（核對 PR 已合併→保存並逐檔核對本機修改→把合併結果 merge 進原型分支→驗證 spec 與原型都在）見 Vault `🛠️ 工程開發/🧭 文件分工與開發接續.md`「文件 PR 合併後」一節，逐步執行。只有本次verified_at更新項已重新核對正文；工程條目只修正搬移路徑時另註，不把舊hash當現在已同步。沒有背景同步。

原specs/product-v1.md保留相容入口；完整舊規格逐位元組保存在product歷史目錄。此次替換的repo入口原件保存在 [_archive/2026-09-11-before-product-module-split](<_archive/2026-09-11-before-product-module-split/docs/README.md>)。原始會議、圖片、研究、日記與其他歷史不刪除。
