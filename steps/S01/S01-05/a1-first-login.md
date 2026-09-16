# S01-05 證據：A1 一次性密碼登入 → 強制改密 → 登出重登

票：[#48](https://github.com/roy4222/fju-im-project/issues/48)｜執行時間：2026-09-15 21:30 CST
｜Next 16.3.3｜better-auth 1.7.5｜PostgreSQL 16.10

## 1. `pnpm seed:a1`

值只從環境變數來，**不寫進任何檔案、不印在終端機**：

```
$ A1_EMAIL=… A1_INITIAL_PASSWORD=… DATABASE_URL_OWNER=… pnpm -C web seed:a1
A1 已建立：status=active、must_change_password=true、角色 admin。
第一次登入會被帶到改密頁；改完密碼之後這組一次性密碼就失效。

$ psql -c "select u.email, u.status, u.must_change_password, u.role, r.role as business_role
           from users u left join role_assignments r on r.user_id=u.id and r.revoked_real_at is null
           where u.email='a1-evidence@example.com'"
          email          | status | must_change_password | role  | business_role
-------------------------+--------+----------------------+-------+---------------
 a1-evidence@example.com | active | t                    | admin | admin
```

重跑是安全的（冪等）：

```
$ pnpm -C web seed:a1        # 第二次，而且刻意帶了不同的密碼
A1 已存在（status=active、must_change_password=true），不做任何事。
要重發一次性密碼請走系辦的「臨時密碼」功能（S01-12），不要重跑 seed。
```

有一條測試證明「重跑不會偷偷換掉密碼」：重跑之後原本的一次性密碼**仍然**登得進去。
另外缺少 `A1_INITIAL_PASSWORD`、或密碼短於 12 字元時腳本直接失敗——
不會建出一個沒有密碼的管理員。

> **為什麼不用 `auth.api.createUser`**：admin plugin 的每個 `/admin/*` 端點都要求呼叫端帶著
> 一個 role 是 admin 的 session（S01-03 發現、已回寫契約 03 §2）。系統上線時一個管理員都
> 沒有，這是先有雞還是先有蛋。所以 A1 直接寫資料庫，密碼用 Better Auth 自己的
> `hashPassword` 產生，格式與套件一致（登入時 `verifyPassword` 驗得過——有測試證明）。

## 2. Roy 的六步，逐步的實際結果

| 步驟 | 預期 | 實際 | 截圖 |
|---|---|---|---|
| 1 | 打開 `/login` | 登入表單（Email／密碼）；Google 登入標「還沒接」 | `1-login.png` |
| 2 | 用 A1 一次性密碼登入 | **不進後台**，直接被帶到 `/account/change-password` | `2-forced-change-password.png` |
| 3 | 改密前直接開 `/dashboard/admin/cohorts` | 被導回改密頁 | `3-blocked-before-change.png` |
| 4 | 設定新密碼並送出 | 進得了管理員首頁，側欄正常 | `4-admin-home.png` |
| 5 | 登出，用**舊的**一次性密碼登入 | 「Email 或密碼不正確。」 | `5-old-password-rejected.png` |
| 6 | 用新密碼登入 | **直接進管理員首頁**，不再被要求改密 | `6-relogin-admin-home.png` |

改密後的資料庫（票第 4 節點名的 `SELECT status, must_change_password`）：

```
$ psql -c "select email, status, must_change_password from users where email='a1-evidence@example.com'"
          email          | status | must_change_password
-------------------------+--------+----------------------
 a1-evidence@example.com | active | f                      ← 旗標被清掉了

$ psql -c "select action, actor_kind, payload from audit_events where …"
          action          | actor_kind |            payload
--------------------------+------------+--------------------------------
 account.seed_first_admin | system     | {"source": "seed:a1"}
 account.change_password  | user       | {"revokedOtherSessions": true}   ← 稽核不含密碼
```

## 3. 「改密會撤掉其他裝置」是真的撤掉

整合測試裡兩個「裝置」各自用一次性密碼登入（`sessions` 兩列），在裝置 A 改密之後：

```
expect(after!.must_change_password).toBe(false)          // 旗標清掉
expect(await sessionCount(userId)).toBe(1)               // 只剩改密的那一台
```

用的是 Better Auth 的 `changePassword({ revokeOtherSessions: true })`（模組 01 §3、契約 03 §2）。
**目前這一台留著**——不然使用者剛改完密碼就被踢出去，得再登一次。

## 4. 「必須改密」擋掉所有業務動作

不是只有頁面導向：`ActorResolver` 解出來的身分套上狀態閘門，`business` 能力直接回
`PASSWORD_CHANGE_REQUIRED`：

```
expect(statusGate(actor, 'business')).toBe('PASSWORD_CHANGE_REQUIRED')
expect(statusGate(actor, 'self.changePassword')).toBeNull()
expect(statusGate(actor, 'self.session')).toBeNull()
```

所以就算有人繞過畫面直接打用例，也一樣被擋（契約 03 §1：授權在用例層，頁面只做導向）。

## 5. 登入限速（契約 03 §6：同一 IP 對同一帳號 10 分鐘 10 次）

| 情境 | 結果 |
|---|---|
| 連錯 10 次，第 11 次**用正確的密碼** | `RATE_LIMITED`——**正確的密碼也先被擋** |
| 同一個帳號換一個 IP | 不受影響（鍵是 IP＋帳號） |
| 中途登入成功 | 計數歸零，之後又有完整 10 次額度 |

**為什麼鍵是 IP＋帳號而不是只看 IP**：系上都在同一個對外 IP 後面，只看 IP 會擋到無辜的人；
只看帳號則擋不住從很多 IP 打同一個帳號。**為什麼達到上限之後連正確的密碼也擋**：
不然「有沒有被擋」就變成密碼對不對的訊號。

限速本身有 6 條純邏輯單元測試（固定視窗、剩餘次數、過期重來、鍵互不影響、reset），
門檻值也有一條測試釘住契約 03 §6 的三組數字。

## 5.5 2026-09-16 review 修正：規則搬進 hook，直接打 HTTP 也繞不過（Spec 3、4／P1、P2）

review 用隔離 PostgreSQL 重現了兩個缺口，根因一樣：**規則只寫在 `SelfAccountCommand` 與
Server Action 門面上**，`/api/auth/*` 是白名單路由，直接打就整組繞過去。

### Spec 3：直接打 `/api/auth/change-password`

| 情況 | 修正前（review 重現） | 修正後（本機實測） |
|---|---|---|
| 送 8 個字元的新密碼 | HTTP 200，密碼被改掉 | **HTTP 400**「新密碼至少要 12 個字元。」 |
| 不傳 `revokeOtherSessions` | 另一台裝置的登入還在 | **另一台的 cookie 讀不到 session 了** |
| 稽核 | `account.change_password` 0 筆 | **1 筆** |

實際輸出：

```
  -- 送 8 字元新密碼、不傳 revokeOtherSessions --
{"code":"VALIDATION_FAILED","message":"新密碼至少要 12 個字元。"}
  HTTP 400
  -- 送合法新密碼、仍不傳 revokeOtherSessions --
  HTTP 200
  -- 裝置 B 的 cookie 還能讀到 session 嗎 --
null
 change_password_audit
-----------------------
                     1
```

修法：長度、不可與舊密碼相同、限速、**強制覆寫 `revokeOtherSessions: true`** 放進
`hooks.before`；清 must-change 旗標與寫稽核放進 `hooks.after`（`change-password-rules.ts`）。
`SelfAccountCommand` 只剩「確認有 session、把錯誤翻成 Result」，不再有第二份規則。

> 一個實作細節值得記下來：`hooks.after` **不能**用 `getAuthoritativeSessionFromCtx` 取使用者。
> `revokeOtherSessions` 會把這個人**全部**的 session 刪掉再建一個新的（套件的 `update-user.mjs`），
> 所以那一刻請求裡的 cookie 指向的列已經不存在了。改成從改密的回應本身取 `user.id`。

### Spec 4：直接打 `/api/auth/sign-in/email` 的限速

限速從 composition 門面搬進 `hooks.before`（`sign-in-rate-limit.ts`），兩條路共用同一個桶。
本機實測（同一 IP＋帳號）：

```
  第  1–10 次（錯密碼）：HTTP 401
  第 11 次（**正確**密碼）：HTTP 429   ← review 當時是 200
  換一個 IP（正確密碼）：HTTP 200      ← 不該被連累
```

### 一併修掉兩個會在正式環境炸掉的設定

重驗時發現本機 curl 在第 4 次就 429、而且換 IP 也 429 —— 那不是我們的限速，是**套件自己的**：

1. **Better Auth 在 Caddy 後面解析不到用戶端 IP**，它的限速會退回「全站共用一個桶」
   （套件自己會 warn），`sessions.ip_address` 也會全部記成 proxy 位址。
   已設 `advanced.ipAddress.ipAddressHeaders = ['x-real-ip', 'x-forwarded-for']`，
   Caddyfile 帶的就是 `X-Real-IP`。
2. **套件內建規則是 `/sign-in*`、`/sign-up*`、`/change-password*` 3 次／10 秒／IP**，
   與契約 03 §6 的「10 次／10 分鐘／IP＋帳號」衝突，而且先撞到的是它——
   等於契約門檻永遠測不到，而且全系在同一個對外 IP 後面時，10 秒 3 次連正常上課時段的
   登入都擋。已把契約管的三條路徑放寬到不會蓋掉契約門檻，其餘留一個寬鬆的全域上限當粗略的
   DoS 防護；**精確門檻由 hook 裡的 limiter 負責**（那一份看得到帳號）。

這兩項是這次修正時才發現的，不在 review 的四項裡，但會直接影響上線第一天。

## 6. 自動測試

| 檔案 | 條數 | 內容 |
|---|---|---|
| `src/shared/rate-limit.test.ts` | 8 | 固定視窗與契約門檻 |
| `src/infrastructure/auth/change-password-rules.test.ts` | 4 | 新密碼規則（長度、不能跟舊的一樣、中文以字元計） |
| `src/infrastructure/auth/a1-login.integration.test.ts` | 20 | seed（含冪等與缺值）、六步整條路、改密規則、限速三條，**外加 review 那兩項的回歸測試 5 條** |
| `e2e/a1-first-login.spec.ts` | 4 | 同一條路**用真的表單**走一遍 |

e2e 那四條跑的是使用者看得到的東西：填表單、按按鈕、看錯誤訊息，不是打 API。

## 7. 本機跑出來的結果

```
$ pnpm -C web typecheck                 ✅
$ pnpm -C web lint                      ✅
$ pnpm -C web lint:boundaries-test      ✅ 14 反例 7 合法例
$ pnpm -C web db:grants --check         ✅
$ pnpm -C web build                     ✅
$ pnpm -C web test:unit                 ✅ 11 檔 153 條
$ pnpm -C web vitest run --project integration src/
                                        ✅ 9 檔 325 條
$ pnpm -C web test:e2e                  ✅ 37 條
```

## 8. 設計上值得一提的三件事

1. **表單是 Server Action，沒有 JavaScript 也能用**。登入與改密都是原生 `<form action={…}>`；
   `useActionState` 只是拿來顯示錯誤訊息與「處理中」。cookie 由 Better Auth 的
   `nextCookies()` 外掛帶進回應（它必須是最後一個 plugin，官方要求）。
2. **登入後去哪是伺服器決定的**：被要求改密的人一律先去改密頁，`next` 參數不能把他帶去別的
   地方；其他人進自己的後台（角色來自 `role_assignments`）。`next` 只接受站內路徑，
   不會變成開放轉址。
3. **改密的順序**：先呼叫 Better Auth 改密，成功了才清 `must_change_password`。反過來的話，
   萬一改密失敗就會變成「密碼沒換卻放行」。現在最壞的情況是「密碼換了但旗標還在」，
   使用者被要求再改一次——這個方向是安全的。

## 9. NOT_RUN／沒做什麼

- CI 七道在本 PR 的最新 commit：**待 PR 開出後回填**。
- **VM 測試站：NOT_RUN。** 上面全部是**本機**跑的。VM 目前連 Docker 都還沒裝（#187），
  所以本批的「Roy 在測試站上親自走一遍」還不能做。不把本機的結果說成 VM 驗收完成。
- Turnstile（S01-15）、Google 登入（S01-14）、忘記密碼／系辦臨時密碼（S01-12）：不在本票。
- `/register` 的註冊表單（S01-09）、帳號管理的各種動作（S01-10～S01-12）：不在本票。
- **套件內建限速的處理見下方第 10 節**（上一版這裡寫「還在，沒有調整」，已不是現況）。

## 10. 2026-09-16 複核：跨帳號誤擋（Spec 3）

複核指出上一輪留下的 `rateLimit.customRules['/sign-in/email'] = { window: 600, max: 60 }`
仍然會誤擋，而且**放寬門檻解決不了**：套件的鍵是
`createRateLimitKey(ip, path)`（`node_modules/better-auth/dist/api/rate-limiter/index.mjs`），
結構上就不含帳號，所以它本質是一個**跨帳號共用的桶**。同一個對外 IP 後面，
60 個不同帳號各錯一次就把它用完，第 61 個人拿正確密碼也會被擋——全系共用一個校園出口，
這條等於隨時可以被任何人（或任何人的手滑）癱瘓掉登入。

改法：`/sign-in/email` 與 `/change-password` 兩條**關掉**套件那一層（`customRules` 給 `false`，
`resolveRateLimitConfig` 會回 `null`），門檻一律由 app 記憶體那一份做——登入以 IP＋帳號為鍵，
改密以 userId 為鍵。契約 03 §6 本來就把粗粒度那層寫成「app 記憶體＋**Caddy**」，
跨帳號的 DoS 防護屬於反向代理那一層。`/change-password` 同樣不能用 IP 桶：
系辦發臨時密碼後一整批人在同一個出口改密是正常流程。

`/sign-up/email` 維持套件的 IP 桶、門檻仍是 30 而不是契約寫的 5——註冊流程是 S01-09 的票，
這一批沒有做。已記進契約 03 §6 的待決。

回歸測試（`a1-login.integration.test.ts`）：同一個 IP 上 60 個不同帳號各失敗一次，
接著這個帳號的第一次登入仍回 **200**。修正前這一項是 **429**。

關掉套件那層之後，`/change-password` 這條路上**只剩** hook 裡以 userId 為鍵的限速，
所以補一項證明它真的會擋：同一個人連續 5 次（都因新密碼太短被擋在驗證，但一樣算配額）之後，
第 6 次即使新密碼合法也回 **429**，且密碼沒有被改掉。
