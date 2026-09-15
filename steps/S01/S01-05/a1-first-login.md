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

## 6. 自動測試

| 檔案 | 條數 | 內容 |
|---|---|---|
| `src/shared/rate-limit.test.ts` | 8 | 固定視窗與契約門檻 |
| `src/application/accounts/self-account.test.ts` | 4 | 新密碼規則（長度、不能跟舊的一樣、中文以字元計） |
| `src/infrastructure/auth/a1-login.integration.test.ts` | 15 | seed（含冪等與缺值）、六步整條路、改密規則、限速三條 |
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
- **Better Auth 內建的全域限速**（預設 10 次／60 秒／IP，涵蓋整個 `/api/auth/*`）**還在**，
  沒有調整。它對正式環境太緊——全系在同一個對外 IP 後面，一分鐘只有 10 次就會擋到正常登入。
  本票實作的是契約 03 §6 的**逐路由**限速；兩者疊加。建議在 S01-15（Turnstile）那張票
  一併把套件的預設值調成與契約一致，本票不自行改動。
