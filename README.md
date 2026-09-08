# 輔仁大學資訊管理學系 — 專題管理平台

> 讓訪客找得到系上的專題成果，讓學生與老師一登入就知道現在該做什麼，讓管理員在一個一致、好用的後台完成發布、收件、分組、評分與簽核；所有核心資料與檔案都留在校方可控的環境中。

取代使用超過十年的舊專題網站（`project.im.fju.edu.tw`）。**不沿用舊程式碼、不遷移舊資料庫、不接 LDAP。**

---

## ⚠️ 目前狀態：原型階段

**這個 repo 目前沒有資料庫、沒有登入、沒有後端。** 所有畫面讀取的都是
`src/lib/fixtures.ts` 裡的假資料（虛構的姓名、學號、公司與公告，不含任何真實個資）。

| 範圍 | 狀態 |
|---|---|
| 公開前台 16 個路由（首頁四角色、公告、競賽、規則、優秀專題、歷屆一覽、榮譽榜、產學、檔案下載、帳號、403／404） | ✅ 2026-09-07 依定案設計重做；身分由原型操作列的 cookie 模擬 |
| 設計 token、字體系統、Data Table、Sidebar shell | ✅ 完成 |
| 三角色 Dashboard | 🟡 首頁與分組總覽已做，視覺待依新設計語言重做 |
| 專題事務編輯器（拖拉表單） | ❌ 未開始 |
| 評分工作台、簽核流程、帳號管理、檔案管理 | ❌ 未開始 |
| PostgreSQL、Auth、檔案儲存、權限驗證 | ❌ 未開始 |
| Docker、校內 VM 部署、備份與還原 | ❌ 未開始 |

畫面上的照片暫用系網 im.fju.edu.tw 的素材（`public/placeholder/`），上線前必須換成系辦提供的照片。

---

## 快速開始

需要 Node.js 20+ 與 pnpm。

```bash
pnpm install
pnpm dev          # http://localhost:3000
```

| 路徑 | 內容 |
|---|---|
| `/` | 前台首頁；登入後多「我的工作」列、近期截止、歷屆一覽區 |
| `/news`、`/news/[id]` | 公告列表（置頂大卡、分類、搜尋、分頁）與詳情 |
| `/competitions` | 競賽資訊 |
| `/rules` | 專題規則（舊站九節全文，只有現行版） |
| `/projects/featured`、`/projects/[id]` | 優秀專題（公開，一圖一文 dialog）與詳情 |
| `/projects` | 歷屆專題一覽（登入後；卡片式、依屆別分段、搜尋排序） |
| `/honors` | 榮譽榜（`?item=` 深連結開 dialog） |
| `/industry`、`/industry/[id]` | 產學合作（登入後；Data Table 可排序搜尋） |
| `/files`、`/account` | 檔案下載、個人資料（登入後） |
| `/login`、`/register`、`/register/pending`、`/forgot-password`、`/403` | 帳號與系統頁 |

右下角「原型操作列」可切換訪客／學生／老師／管理員，這是 cookie 模擬，不是登入。
| `/dashboard/student`、`/dashboard/teacher`、`/dashboard/admin` | 三角色 Dashboard（右上角可切換角色） |
| `/dashboard/admin/groups` | 分組總覽（Data Table） |

其他指令：

```bash
pnpm build                        # production build（公開頁應全為 Static/SSG）
npx tsc --noEmit                  # 型別檢查
node scripts/shoot.mjs / --light  # 用本機 Chrome 截圖，支援深淺主題與手機寬度
```

---

## 技術棧

| 項目 | 選擇 | 理由 |
|---|---|---|
| 框架 | Next.js 16.3（App Router） | 公開頁需要 SSR／SSG 以滿足 SEO |
| UI | React 19.2 + Tailwind CSS v4 | v4 的 `@theme` 讓品牌色票變成單一 CSS 檔 |
| 元件 | shadcn/ui `style: base-nova` + **Base UI** primitives | 與 UX donor 對齊，可整檔移植其 sidebar 與 data-table |
| 表格 | TanStack Table **v8** | v9 是全新 API，donor 與 shadcn 文件皆為 v8 |
| Icon | `@tabler/icons-react` | 與 donor 一致 |
| 套件管理 | pnpm | 校內 VM 只有 8GB RAM，disk 與 build 記憶體都要省 |

**尚未封板**：ORM（傾向 Drizzle）、Auth（傾向 Auth.js v5）、reverse proxy、外部備份目的地、正式網域。

Base UI 不是 Radix：沒有 `asChild`，改用 `render` prop；`Checkbox` 的
`indeterminate` 是獨立 prop。細節見 `.design-sync/conventions.md`。

---

## 設計系統

**品牌色票取樣自系網** `im.fju.edu.tw`（2026-08-17）：

| 用途 | 色值 | Token |
|---|---|---|
| 主色（深藍） | `#003366` | `--primary` |
| 品牌強調（橘） | `#E56E00` | `--brand` |
| 次要底（暖白） | `#FFF4EA` | `--secondary` |

品牌橘刻意**不併入** shadcn 的 `--accent`——`accent` 在 shadcn 語意是 hover 底色，
塞橘色會讓全站每個 hover 都變橘。

`-subtle` 與 `-on-subtle` 必須成對使用：前者是淺色底、後者是配在那個底上的文字色。
把 `-foreground`（實色底上的文字）用在 `-subtle` 底上會造成對比不足。

**字體**：全站黑體，Geist（拉丁與數字）＋ Noto Sans TC（漢字），標題靠字重與字級分層。
2026-09-07 Roy 定案，系網本身就是黑體；先前的 Noto Serif TC 與 Kaisei Tokumin 已移除。

公開站版面語言依系網實測（`docs/research/2026-09-07-design-reference.md`）：大標首字橘色、灰藍圓角標題板、暖白照片卡、深藍左線列表、橘色外框「查看更多」。對應的 utility 在 `globals.css` 的 `.btn-fju*`、`.fju-list-item`、`.fju-panel-title`。

全部定義在 `src/app/globals.css`。

### 硬約束

`docs/ANTI-PATTERNS.md` 是從第一版原型被評為「太 AI」後反推出來的 22 條規則，
涵蓋文案、視覺、資訊密度、元件、Dashboard 與可存取性。**每個新畫面完成後逐條自檢。**

### Claude Design 同步

`.design-sync/` 是把這套元件庫同步到 claude.ai/design 的設定，讓該平台的設計 agent
使用我們自己的元件與品牌 token。詳細流程與已知陷阱見 `.design-sync/NOTES.md`。

---

## 目錄結構

```
src/
├─ app/
│  ├─ (public)/          前台（共用 layout：SiteHeader + SiteFooter + PrototypeBar；依 cookie 身分渲染）
│  ├─ api/proto-role/    原型用：切換身分 cookie（接 Auth 後移除）
│  └─ dashboard/[role]/  登入後 Dashboard，角色由路由參數決定
├─ components/
│  ├─ ui/                shadcn 元件（24 檔，130 個匯出）
│  ├─ public/            前台區塊：SiteHeader、sections、NewsTabs…
│  ├─ layout/            Dashboard shell：AppSidebar、DashboardHeader
│  ├─ dashboard/         Panel、StatTile、StateBadge、ProgressBar、EmptyState
│  └─ data-table/        共用 Data Table（TanStack Table）
└─ lib/
   ├─ data/              前台資料存取層：viewer（身分）、catalog（可見性在這層決定）、roles
   ├─ fixtures.ts        全站共用假資料（三角色讀同一份）
   ├─ nav-config.ts      角色感知導覽
   └─ fonts.ts           字體載入策略
```

**假資料是單一來源**：三個角色的 Dashboard 讀同一份 fixtures，差別只在權限與視角——
這樣才看得出權限矩陣在畫面上的真實差異。fixtures 的型別刻意貼近規格書的核心資料模型
（`ManagedItem`、`GroupResponse`、`SubmissionVersion`、`GradingSchemeVersion`…），
之後接資料庫時可直接對照。

---

## 規格與決策

**產品需求、範圍、名詞、流程與驗收的唯一主規格**是 Obsidian 中的
`🗺️ 輔大資管系專題網站重構 MOC.md`。會議紀錄、Google Sheet 與舊網站都是來源或歷史證據；
內容衝突時以該檔目前版本為準。

要改需求：先更新該檔與決策紀錄，再同步 issue、設計、資料模型與程式碼。
**不可讓程式碼反過來定義產品。**

幾條會直接影響實作的既定決策：

- 登入為 Google OAuth 主用 ＋ Email/密碼備援；名單命中自動核准，否則進人工審核
- 管理員可重設臨時密碼，但**任何人都不能查看既有密碼**
- 專題事務以**整組一份**為原則，任一成員送出即代表全組完成，截止前可重送並保留版本
- 一筆內容只選**一個**主要前台位置，Dashboard 與首頁自動摘要，不複製成多筆
- 簽核為五位組員逐一線上同意、指導老師最後同意，**全程不下載或上傳簽名檔**
- 學生在 v1 **完全看不到成績**
- 前端隱藏按鈕不是權限控制；所有讀寫權限均須在伺服器端依資料庫事實重新驗證

---

## 交付

**2026-09-14** 完成 v1 驗收：公開前台、學生端、老師端、管理員後台，並於校內 Ubuntu VM
（4 cores / 8GB / 200GB）以限制測試帳號完成跨角色 E2E、真實 PostgreSQL migration、
檔案儲存與權限、外部備份與至少一次還原演練。

Mock、fixture、單元測試、頁面數量或程式碼行數都不能單獨替代這個 Gate。

---

## 授權與致謝

專案為輔仁大學資訊管理學系內部使用。UI 參考下列 MIT 授權專案，移植時保留其授權聲明：

- [Kiranism/next-shadcn-dashboard-starter](https://github.com/Kiranism/next-shadcn-dashboard-starter) — Dashboard shell 與 Data Table 的 UX donor
- [hasanharman/form-builder](https://github.com/hasanharman/form-builder) — 拖拉式表單編輯器的 UX 參考（其欄位資料結構不適用，schema 需自行設計）
- [shadcn/ui](https://ui.shadcn.com/) — UI primitives
