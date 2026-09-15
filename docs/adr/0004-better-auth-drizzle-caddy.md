---
status: accepted
decision_date: 2026-09-07
recorded: 2026-09-07
---
# Auth 用 Better Auth、ORM 用 Drizzle、proxy 用 Caddy

主規格 §2 要求 Google OAuth 主用、Email／密碼備援、管理員可停用帳號、撤銷 session、建立一次性臨時密碼並強制改密碼，且任何人不能查看既有密碼。§13.3 原本把 Auth 套件、ORM 與 reverse proxy 留到實作期封板；README 傾向 Auth.js v5 與 Drizzle，7/16 日記另探索過 Better Auth。

2026-09-07 Roy 依討論封板：

- **Better Auth** 取代 Auth.js v5。Auth.js 官方不建議使用 Credentials provider 做密碼登入，而密碼備援是 §2.3 的 `DECIDED` 需求；Better Auth 原生提供 Email／密碼與 Google provider、密碼雜湊與重設流程，admin 外掛直接對應 §2.5 的停用、撤 session 與臨時密碼，且以 Drizzle adapter 落在同一個 PostgreSQL。代價是社群比 Auth.js 小、版本演進快，升級時要重驗 §2 的 AUTH 驗收。
- **Drizzle** 取代 Prisma。schema 以 TypeScript 定義、migration 為純 SQL 檔可審閱，執行期沒有額外 engine，符合 8GB VM 的資源邊界與 §13.4「migration 必須明確」。代價是關聯查詢要自己寫得更明確。
- **Caddy** 取代 Nginx。自動申請與續期 TLS、設定檔短，減少校方接手後的維運項目；私有檔案仍由 app 授權串流，Caddy 不直接暴露 volume（§11.1）。代價是校內若有既有 Nginx 慣例需另行說明。

這三項不改變 §2 的授權模型、§11 的資料所有權與 §13 的部署邊界。外部備份目的地與正式網域仍為 TBD。

> **2026-09-12 補充（不改當時決定）**：外部備份目的地已於 2026-09-11 決定為 Cloudflare R2（DB-only、每日加密、30 天；本機快照 7 天；附件無異地），見 [共用契約 05](<../engineering/contracts/05 CI-CD、部署與維運.md>) §6。正式網域仍暫用 `fju.roy422.dev`，校方網域待定。Better Auth 的能力邊界（端點白名單、admin 只經用例、impersonation 不用、cookieCache 關閉）見 [共用契約 03](<../engineering/contracts/03 安全與隱私.md>) §2。

來源：[完整主規格](<../product/📋 完整產品規格.md>) §2、§11、§13；2026-09-07 grill-with-docs 討論。本 ADR 記錄選型，不代表實作或驗收已完成。
