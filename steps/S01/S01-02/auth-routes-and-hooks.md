# S01-02 證據：Better Auth 掛上網站、封鎖不該對外的路由

票：[#45](https://github.com/roy4222/fju-im-project/issues/45)｜執行時間：2026-09-15 20:30 CST
｜better-auth **1.7.5**（`package.json` 釘死）｜PostgreSQL 16.10

## 1. 兩層攔截長什麼樣

| 層 | 位置 | 做什麼 |
|---|---|---|
| 第一層 | `src/infrastructure/auth/wrapper.ts` | 路徑白名單，**在 `toNextJsHandler` 之前**；不在白名單就直接回 403，請求根本不進 Better Auth |
| 第二層 | `src/infrastructure/auth/auth-instance.ts` 的 `hooks.before` | 只擋「帶著 HTTP request」的呼叫；繞過第一層（例如直接打 `auth.handler`）照樣 403 |

矩陣是資料，不是散在程式裡的 if：`src/infrastructure/auth/route-matrix.ts`
（`ALLOWED_ROUTES` 白名單 10 條、`BLOCKED_ROUTE_REASONS` 逐條封鎖理由）。
**預設拒絕**——沒被白名單命中的一律 blocked，所以套件升級多長出端點時不會靜靜對外開。

## 2. gate (a)：安裝版本的實際 route table 逐條覆核

從真的 `auth.api` 讀出來的 45 條帶路徑端點（第 46 條 `setPassword` 的端點物件沒帶 `path`），
以及矩陣對每條的判定：

```
/account-info                  GET:blocked
/admin/ban-user                POST:blocked
/admin/create-user             POST:blocked
/admin/get-user                GET:blocked
/admin/has-permission          POST:blocked
/admin/impersonate-user        POST:blocked
/admin/list-user-sessions      POST:blocked
/admin/list-users              GET:blocked
/admin/remove-user             POST:blocked
/admin/revoke-user-session     POST:blocked
/admin/revoke-user-sessions    POST:blocked
/admin/set-role                POST:blocked
/admin/set-user-password       POST:blocked
/admin/stop-impersonating      POST:blocked
/admin/unban-user              POST:blocked
/admin/update-user             POST:blocked
/callback/:id                  GET:allowed  POST:allowed
/change-email                  POST:blocked
/change-password               POST:allowed
/delete-user                   POST:blocked
/delete-user/callback          GET:blocked
/error                         GET:allowed
/get-access-token              POST:blocked
/get-session                   GET:allowed  POST:allowed
/link-social                   POST:allowed
/list-accounts                 GET:allowed
/list-sessions                 GET:blocked
/ok                            GET:blocked
/refresh-token                 POST:blocked
/request-password-reset        POST:blocked
/reset-password                POST:blocked
/reset-password/:token         GET:blocked
/revoke-other-sessions         POST:blocked
/revoke-session                POST:blocked
/revoke-sessions               POST:blocked
/send-verification-email       POST:blocked
/sign-in/email                 POST:allowed
/sign-in/social                POST:allowed
/sign-out                      POST:allowed
/sign-up/email                 POST:allowed
/unlink-account                POST:blocked
/update-session                POST:blocked
/update-user                   POST:blocked
/verify-email                  GET:blocked
/verify-password               POST:blocked
TOTAL 45
```

**gate 結果：通過，但發現兩處 spec 與實際版本不符，已依票面「不一致先回 Vault 改 spec」處理：**

1. 契約 03 §2 寫的 `/forget-password` 在 1.7.5 **不存在**；實際是 `/request-password-reset`
   與 `/reset-password/:token`。契約 03 §2 的表格已更名。
2. 契約 03 §2 原本沒列到的 11 條端點（`/account-info`、`/get-access-token`、`/refresh-token`、
   `/list-sessions`、`/revoke-session`、`/revoke-sessions`、`/revoke-other-sessions`、
   `/update-session`、`/verify-password`、`/set-password`、`/ok`）一律封鎖，逐條理由寫進
   `BLOCKED_ROUTE_REASONS`，並在契約 03 §2 加了一段覆核結果說明。

`/error` 是套件在 OAuth 失敗時**自己導過去**的錯誤頁，放行（不吐任何帳號資料）。

自動化的部分寫成三條測試（不是一次性的人工比對）：每條實際路由都必須被矩陣分類到、
矩陣列的路徑都必須真的存在、白名單列的方法要和端點宣告的一致。套件升級後這三條會先紅。

## 3. gate (b)：`hooks.before` 在 server-only 呼叫時 `ctx.request` 不存在

| 情境 | 結果 |
|---|---|
| 伺服器端直接 `auth.api.listUsers({...})` | 失敗，但**不是**因為路由封鎖（訊息不含「這個入口不對外開放」）→ 代表 hook 看不到 `request` |
| 同一個端點走 HTTP（`auth.handler(new Request(...))`） | 403，回應內容含「這個入口不對外開放」 |

**gate 結果：通過。** marker（AsyncLocalStorage）條件是 S01-03 的範圍——本票只做到
「`ctx.request` 存在就擋」，「缺 marker 的伺服器端呼叫也要擋」是三向測試的第三向，S01-03 補。

## 3.5 2026-09-16 review 修正：白名單路由現在真的受帳號狀態矩陣管（Spec 2／P1）

review 用隔離 PostgreSQL 重現了三個缺口，都是同一個根因：**狀態檢查只做在頁面導向與
Server Action 上，直接打 `/api/auth/*` 就繞過去了**。

| 重現的情況 | 修正前 | 修正後 |
|---|---|---|
| `status='disabled'`、`banned=false`（ban 還沒收斂）的帳號登入 | HTTP 200 | **登入失敗，session 不會被建出來** |
| 同一個帳號的既有 session 呼叫改密 | `ok: true` | **401** |
| pending／must-change 打 `/list-accounts` | 都 200 | **都 403** |

修在兩個地方，兩個都在 Better Auth 的 hook 裡，所以 HTTP 與伺服器端呼叫走同一條路：

1. **`hooks.before` 的第二關**：路由通過之後再看帳號狀態。
   `route-matrix.ts` 的每一條白名單路由多了一個 `session` 欄位（`none`／`signed-in`／`active-only`），
   對應契約 03 §2 矩陣的那幾欄；`sessionRequirement()` 回答這條路要什麼，
   hook 用 `getAuthoritativeSessionFromCtx` 拿 session、再回資料庫讀 `users.status`。
2. **`databaseHooks.session.create.before`**：停用或去識別化的人**建不出 session**，
   所以登入直接失敗。

兩個判斷都**只看 `users.status`，不看 Better Auth 的 `banned`** —— 後者是 commit 後的外部
呼叫，可能還沒收斂（模組 01 v2.4 規則 6 寫的就是這個情境）。

**為什麼擋在「建 session 的那一刻」而不是登入前先查 Email**：先查再拒絕，等於送對方一個
「這個帳號存在而且被停用」的探測管道。擋在密碼驗過之後，外面看到的就只是一次普通的登入失敗。
同理，被停用的人拿到的是 `UNAUTHENTICATED`／「請重新登入」，不是「你被停用了」。

新增 6 條回歸測試（`auth-routes.integration.test.ts` 最後一組），涵蓋上面三種重現情況、
「登入後才被停用，同一個 cookie 立刻失效」、以及正向的「active 用得了 `list-accounts`」與
「must-change 仍然讀得到 session、登得出去」。

## 4. 真的打進去（本機跑起來的站，不是模擬）

站起在 `http://127.0.0.1:3000`（`pnpm -C web start`，`/api/health` 先綠）：

```
$ curl -s http://127.0.0.1:3000/api/health
{"ok":true,"version":"s01-02-evidence","commit":"local","imageDigest":null,
 "schemaVersion":"0002_s01_accounts_and_files","worker":{"version":null,"lastTickAt":null}}

### 1. 註冊（白名單）                                            HTTP 200
### 2. 登入，取 cookie                                           HTTP 200
### 3. 把這個帳號標成管理員
 admin | active
UPDATE 1

### 4. 帶管理員 session 打 GET /api/auth/admin/list-users
{"error":{"code":"FORBIDDEN","message":"這個入口不對外開放。"}}
HTTP 403

### 5. 帶管理員 session 打 POST /api/auth/admin/list-users
{"error":{"code":"FORBIDDEN","message":"這個入口不對外開放。"}}
HTTP 403

### 6. POST /api/auth/admin/ban-user
{"error":{"code":"FORBIDDEN","message":"這個入口不對外開放。"}}
HTTP 403

### 7. get-session（白名單，可用）                                HTTP 200
{"session":{...,"loginMethod":"password",...},
 "user":{"email":"evidence-a1@example.com","role":"admin","banned":false,
         "status":"active","mustChangePassword":false,...}}

### 8. 資料庫：status 與 login_method
          email          | status | must_change_password | login_method
-------------------------+--------+----------------------+--------------
 evidence-a1@example.com | active | f                    | password
 evidence-a1@example.com | active | f                    | password
(2 rows)
```

這正是票第 3 節要的那張證據：**用管理員身分直接打 `/api/auth/admin/list-users`（GET 與 POST 各一次）都回 403。**
（第 3 步刻意把帳號改成 `role='admin'`、`status='active'`，就是為了證明「帶著管理員登入狀態也一樣被擋」。）

證據帳號用完已從本機開發資料庫刪掉（`delete from sessions/accounts/users where email='evidence-a1@example.com'`）。

## 5. 三個 hook 與四項設定

| 項目 | 怎麼驗 | 結果 |
|---|---|---|
| 新帳號一律 `status='pending'` | 註冊後讀 `users.status` | ✅ pending |
| 請求體偷帶 `status=active` 無效 | 註冊時多送 `status`／`mustChangePassword` 欄位 | ✅ 仍是 pending（`input:false` ＋ hook 兩層） |
| session 記下登入方式 | 密碼登入後讀 `sessions.login_method` | ✅ `password` |
| 主鍵 uuidv7 | 讀 `users.id` 的版本位元 | ✅ 第 15 個字元是 `7` |
| fresh session 10 分鐘 | 讀 `auth.options.session.freshAge` | ✅ 600 |
| cookie 快取關閉 | `auth.options.session.cookieCache.enabled` | ✅ false |
| 關掉隱含帳號合併 | `auth.options.account.accountLinking.disableImplicitLinking` | ✅ true |

## 6. admin plugin 欄名覆核（模組 01 v2.4 D1 gate）

`pnpm -C web auth:generate` 在 1.7.5 重跑，輸出與 repo 內 `auth.generated.ts` **逐字相同**
（只有檔頭註解裡的檔案路徑說明變了，因為實例搬到 `infrastructure/auth/`）：

```
$ git diff --stat web/src/infrastructure/db/schema/auth.generated.ts
 web/src/infrastructure/db/schema/auth.generated.ts | 4 ++--
 1 file changed, 2 insertions(+), 2 deletions(-)     ← 兩行都是註解
```

也就是 `banned`／`ban_reason`／`ban_expires` 欄名與 S00 核對時一致，沒有變。
`readBanned` 的實作由 S01-03／S02 承接，本票不做。

## 7. 檔案位置的調整（請 review 注意）

S00 的 eslint 規則早就寫好「`better-auth/api` 與 `infrastructure/auth/auth-instance` 只能由
`infrastructure/auth/wrapper` 引用」，但實例當時還放在 `src/composition/auth.ts`，規則等於空轉。
本票把實例搬到規則指的位置：

| 之前 | 之後 |
|---|---|
| `src/composition/auth.ts`（實例本體） | `src/infrastructure/auth/auth-instance.ts`（延後建立的實例） |
| — | `src/infrastructure/auth/wrapper.ts`（唯一入口；S01-03 會在這裡加內部包裝器） |
| — | `src/infrastructure/auth/route-matrix.ts`（矩陣資料） |
| — | `src/app/api/auth/[...all]/route.ts`（只有一行 `export const { GET, POST }`） |
| `src/composition/auth.ts` | 只剩一行 re-export，給 app 層用 |

eslint 另外開了兩個窄口，都寫了理由：實例檔可以從 `better-auth/api` 取 `APIError` 與
`createAuthMiddleware` 兩個名字（寫 hook 用，**不是** `auth.api`）；測試檔可以 import 實例，
因為要同時打「經包裝器」與「繞過包裝器」兩條路才證明得了兩層。

**實例改成延後建立**（`getAuth()`）的原因很實際：`betterAuth()` 會馬上要一條資料庫連線，
而 `next build` 收集路由設定時沒有 `DATABASE_URL`，模組載入時就建會讓 build 直接失敗。

## 8. 本機跑出來的結果

```
$ pnpm -C web typecheck                 ✅
$ pnpm -C web lint                      ✅
$ pnpm -C web lint:boundaries-test      ✅ 全部符合預期
$ pnpm -C web build                     ✅ /api/auth/[...all] 出現在路由表
$ pnpm -C web test:unit                 ✅ 7 檔 88 條（route-matrix 新增 14 條）
$ pnpm -C web vitest run --project integration src/
                                        ✅ 5 檔 264 條（auth-routes 新增 36 條）
```

## 9. NOT_RUN／沒做什麼

- CI 七道在本 PR 的最新 commit：**待 PR 開出後回填**。
- 路由矩陣「每路由 × 每帳號狀態」的**狀態格**只填到本票能填的部分：pending／must-change／
  disabled 的差別要等 ActorResolver（S01-03）、A1 改密（S01-05）與停用（S01-09），
  屆時擴充**同一支**測試。本票不假裝那幾格已經驗過。
- 內部呼叫包裝器、AsyncLocalStorage marker、三向測試的第三向：**S01-03**。
- 登入限速、Turnstile、Google 真登入：**S01-05／S01-14／S01-15**，本票沒做。
- VM 部署：**NOT_RUN**（#187–#189）。

## 2026-09-16 複核：fresh session 根本沒生效（Spec 1）

契約 03 §2 對 `POST /link-social` 與 `GET /list-accounts` 要求 fresh session（10 分鐘）。
上一輪的作法是設 `session.freshAge = 600`，驗收時確認「這個選項存在於 session 設定」。

**驗選項存在 ≠ 它會生效。** 安裝版本 1.7.5 的 `dist/api/routes/session.mjs` 裡，
只有 `/list-sessions` 掛了 `freshSessionMiddleware`；`/link-social` 與 `/list-accounts`
掛的是一般的 `sessionMiddleware`，`freshAge` 對它們從頭到尾不會被讀到。
實測把 `sessions.created_at` 回推 11 分鐘，`GET /list-accounts` 仍然回 200。

改法：把 fresh 變成**路由矩陣上的一欄**（`route-matrix.ts` 的 `fresh`），由 `hooks.before`
自己比對 `session.created_at`，判準與套件那支一致（`now - created_at >= freshAge` 即拒絕），
回 403 `SESSION_NOT_FRESH`。矩陣是單一來源，新路由要不要 fresh 就寫在同一張表上。

順帶把 `sessionRequirement()` 的回傳從單一字串改成 `{ session, fresh }`，
並加上 `requirementByPath()`——後者是 #207 的 server-only 修正要用的，見那一票。

### 測試

- 整合（`auth-routes.integration.test.ts`）4 項：9 分鐘仍通；11 分鐘的 `list-accounts` 回
  403 `SESSION_NOT_FRESH`；`link-social` 同樣；**不**要求 fresh 的 `get-session` 與 `sign-out`
  放 120 分鐘照樣通（釘住「沒有擋過頭」）。
- 單元（`route-matrix.test.ts`）5 項：矩陣本身的規則，含「要 fresh 的一定是 active-only」。

對照組：把 `auth-instance.ts` 與 `route-matrix.ts` 還原成修正前、**測試維持新版**再跑一次
——fresh 的 2 項紅，其餘綠。修正後本檔 46 項整合＋19 項單元全綠。

**VM 測試站仍是 NOT_RUN**，以上都是本機。
