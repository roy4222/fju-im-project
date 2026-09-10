# Product

<!-- impeccable:product-schema 1 -->

> 2026-09-09 由 docs/PROJECT.md、docs/specs/product-v1.md、docs/DASHBOARD-PAGES.md 與 ANTI-PATTERNS.md 整理；沒有新增未經 Roy 確認的事實。需求以 Vault 完整產品規格為準，本檔只是給設計工具讀的摘要。

## Platform

web

## Users

- 學生：登入後看下一個截止、待完成／草稿／已繳交、組別五人確認、同意書；不看分數。
- 指導老師：指導組別、可認領產學組、評分工作台（暫存／送出鎖定）、待我同意的簽核。
- 系辦管理員：帳號審核、專題事務工作台（公告／資源／收件／需求同一編輯器）、分組例外、成績方案、簽核重置、檔案與備份、操作紀錄。
- 訪客與校外合作方：只用公開前台。

## Product Purpose

讓輔大資管系一個專題年度的工作（發布、收件、分組、產學、評分、簽核）在同一套校方可控的平台完成；公開前台承接公告、規則、成果與榮譽。交付日 2026-09-14。

## Operating Context

- 學校官方子站，語氣是公告不是行銷。前台參考系網 im.fju.edu.tw；後台 UX donor 是 Kiranism/next-shadcn-dashboard-starter 與 demos.shadcndashboard.dev。
- Dashboard 先回答「我現在要做什麼」，統計排在後面（規格 §10.4）。
- 原型階段全部讀假資料（src/lib/fixtures.ts），身分由 cookie 模擬；Auth／DB 尚未接。

## Capabilities and Constraints

- 後台固定左側欄工作台 `/dashboard/[role]/…`，側欄可收合；頂列有搜尋（未接）、通知、帳號選單、深淺色切換（窗簾動畫，只影響後台）。
- 首頁固定：問候一句話 → 統計 → 模組；「現在要做」固定存在，其他模組有才出現；里程碑模組永遠在。
- 禁止：假數據圖表（營收／MRR）、donor 的 billing／kanban／chat、emoji 當 icon、裝飾性漸層／光暈、插畫（Roy 怕 AI 生成圖）、行銷標語。
- 元件一律 shadcn/ui；大型名單用 Data Table；icon 用 @tabler/icons-react。

## Brand Commitments

- 系網色票：深藍 #003366、橘 #E56E00、暖白 #FFF4EA；後台只有一個主軸色＝橘（主要動作、目前選取、最新達成）；綠＝完成、紅＝逾期；其餘中性灰。數字一律黑。
- 全站黑體：Geist ＋ Noto Sans TC；中文標題不用襯線。
- 官方橫式 logo `public/brand/fju-im-logo.png`。

## Evidence on Hand

- 三角色 23 張後台截圖：docs/screenshots/2026-09-08/。
- Roy 回饋原文：docs/ANTI-PATTERNS.md、docs/DASHBOARD-PAGES.md、.design-sync/NOTES.md。
- 沒有系辦真照片與真資料；不得捏造。

## Product Principles

- 一屏一件事，先告訴使用者下一步。
- 字少、數字與圖表只呈現真實業務量。
- 每個動作都有回饋（換頁進度條、hover、按下回彈、完成回執）。
- 同一種東西全站長一樣（表格、卡片、按鈕）。

## Accessibility & Inclusion

WCAG 2.2 AA：不移除 focus ring、icon-only 按鈕有 aria-label、對比 ≥ 4.5:1（深色也要）、觸控目標 ≥ 44px、尊重 reduced-motion、360px 寬可完成核心流程。
