# S01-03 證據：操作身分、內部呼叫邊界、稽核與操作帳本

票：[#46](https://github.com/roy4222/fju-im-project/issues/46)｜執行時間：2026-09-15 20:45 CST
｜better-auth 1.7.5｜PostgreSQL 16.10

## 1. 交付了什麼

| 機制 | 檔案 | 一句話 |
|---|---|---|
| 內部呼叫 marker | `infrastructure/auth/internal-call.ts` | AsyncLocalStorage 的 symbol，外面偽造不了（不是 header） |
| 內部包裝器 | `infrastructure/auth/wrapper.ts` 的 `internalAuth` | 管理員能力**只有五個**，只能從這裡呼叫 |
| 狀態閘門（純邏輯） | `application/accounts/actor.ts` | 狀態 × 能力的矩陣，沒有資料庫、可單獨測 |
| ActorResolver | `infrastructure/auth/actor-resolver.ts` | 把 cookie 變成「現在是誰」，狀態**當下從資料庫讀** |
| AuditWriter | `infrastructure/ops/audit-writer.ts` | 只有 `append`，沒有改與刪 |
| OperationLedger | `infrastructure/ops/operation-ledger.ts` | 契約 01 §8 的 ON CONFLICT 協議 |

## 2. 三向測試（契約 03 §2）

管理員能力只能經內部包裝器呼叫。三個方向缺一不可：

| 方向 | 情境 | 結果 |
|---|---|---|
| 一 | 外部 HTTP `POST /api/auth/admin/ban-user`，**帶 role=admin 的 session** | **403**，而且 `users.banned` 沒有被改 |
| 二 | `internalAuth.banUser(adminHeaders, { userId })` | 成功，`users.banned` 變 true |
| 三 | 伺服器端直接 `auth.api.banUser(...)`（沒經包裝器） | **被擋**（「這個入口不對外開放」），而且**沒有副作用** |

五個能力（`banUser`／`unbanUser`／`setUserPassword`／`revokeUserSessions`／`createUser`）
第二向都逐一驗過，而且驗的是**實際效果**不是回傳值：

- `unbanUser` 之後 `banned` 變回 false。
- `revokeUserSessions` 之後 `sessions` 列真的被清掉。
- `setUserPassword` 之後**舊密碼登不進去、新密碼登得進去**。
- `createUser` 建出來的帳號一樣是 `pending`（`user.create.before` 對內部建立也生效）。

另外兩條容易被忽略的：

- **marker 不會外洩**：包裝器呼叫結束後（正常結束與丟例外兩種）緊接著做沒有 marker 的呼叫，仍然被擋。
- **marker 不取代權限檢查**：經包裝器但帶的是一般使用者的 session，套件自己的 middleware 照樣擋下。

### 安裝後發現：admin plugin 自己要求 admin session

1.7.5 的每個 `/admin/*` 端點前面掛著 `adminMiddleware` → `getAuthoritativeSessionFromCtx(ctx)`，
**沒有 role 是 admin 的 session 就直接 401**。所以 `internalAuth` 的五個方法第一個參數是
`headers`（發動這個動作的管理員的），不是可選的。

> **待決（已回寫契約 03 §2）**：模組 01 的 `SessionRevocationExecutor` 由 worker 週期執行時
> 沒有任何 session，這幾個呼叫要用什麼身分**尚未定案**，留給 S02 的 worker 票決定
> （選項：服務帳號的 session、或該處改用不經 admin plugin 的等價寫入）。
> 本切片的用例都是管理員親自發動，不受影響——所以這不擋本票，但也不該假裝已經解決。

### lint 規則證明包裝器是唯一入口

`lint-fixtures/` 新增一組反例與一組合法例，`pnpm -C web lint:boundaries-test` 逐檔斷言：

```
分層 lint fixtures：14 個反例、7 個合法例
  ok    lint-fixtures/src/application/demo/invalid-direct-auth-api.ts        ← no-restricted-imports（2 error）
  ok    lint-fixtures/src/application/demo/invalid-imports-auth-instance.ts  ← no-restricted-imports（2 error）
  ok    lint-fixtures/src/infrastructure/valid-uses-auth-wrapper.ts          ← 放行
全部符合預期。
```

反例 7 擋的是 `better-auth/api`；**反例 8 是本票新增的**，擋「繞過包裝器直接拿實例」——
少了它，任何人都可以 `import { getAuth }` 然後 `getAuth().api.banUser(...)`，marker 就形同虛設。

## 3. 帳本：同一個請求編號只做一次（契約 01 §8）

實際跑出來的結果：

```json
{
  "第一次送出": { "outcome": "fresh", "recordId": "01a0a51c-b152-792c-9efe-a6093d517e3f" },

  "同編號同內容重送": {
    "outcome": "replay",
    "recordId": "01a0a51c-b152-792c-9efe-a6093d517e3f",   ← 同一列，沒有做第二次
    "receipt": { "message": "已核准", "applicationId": "app-1" },
    "resultRef": { "userId": "a1744ef1-...", "revision": 3 },
    "receiptExpired": false
  },

  "同編號不同內容": { "outcome": "mismatch" },            ← 不是靜靜覆蓋

  "資料庫裡的帳本列": [
    {
      "operation_kind": "account.approve",
      "request_id": "11111111-1111-4111-8111-aaaaaaaaaaaa",
      "state": "committed",
      "receipt": { "message": "已核准", "applicationId": "app-1" },
      "result_ref": { "userId": "a1744ef1-...", "revision": 3 },
      "committed_real_at": "2026-09-15T12:00:00.000Z"
    }
  ],                                                       ← 只有一列

  "稽核紀錄": [
    {
      "action": "account.approve", "actor_kind": "user", "role": "admin",
      "verification_method": "id_document",
      "real_at": "2026-09-15T12:00:00.000Z",
      "business_at": "2026-09-15T12:00:00.000Z"
    }
  ]
}
```

### 兩條連線同時送同一個編號

用 `test/barrier.ts` 的同步屏障讓兩個交易**確實撞在一起**（不是用 sleep 賭時間）：
兩邊都先 `begin`，在屏障會合後才寫帳本。

| 情境 | 結果 |
|---|---|
| 兩邊內容相同 | 一個 `fresh`、一個 `replay`，資料庫裡**只有一列** |
| 兩邊內容不同 | 一個 `fresh`、一個 `mismatch` |

這靠的是 PostgreSQL 的一個性質：`ON CONFLICT DO NOTHING` 遇到並發時，後到的交易會
**卡著等**前者 commit 或 rollback；前者 commit 就回 0 列（本交易沒進 aborted 狀態，可以
直接 `SELECT` 讀回），前者 rollback 則後者的 INSERT 會成功。所以不需要額外的鎖或重試迴圈。
這段推理寫在 `operation-ledger.ts` 的註解裡，測試證明它成立。

### 其他帳本行為

- 用例交易**回滾**時帳本列跟著不見（不留 failed 列），同編號重送會是「第一次」。
- 欄位順序不同但內容相同 → 算同一個請求（`canonicalJson` 排序後才算 sha256），
  不會讓使用者按兩次送出就看到 `REQUEST_MISMATCH`。
- 回執被 worker 清掉後 `receiptExpired: true`，但 `result_ref` 還在（契約 01 §4.4）。
- `receipt_expires_at` = `committed_real_at` + 30 天。

## 4. 稽核紀錄

| 驗的事 | 結果 |
|---|---|
| 雙時間欄分開存 | `real_at` 與 `business_at` 各自讀回原值（業務鐘在 staging 會被推開，本來就可能不同） |
| actor 規則 | `worker`／`system` 不帶 `actor_user_id`；`user` 卻沒帶 → 資料庫 `audit_events_actor_check` 擋下 |
| 同交易 | 用例回滾時稽核也跟著不見 |
| 不可變 | 寫進去之後 UPDATE／DELETE 都撞 trigger（「不可變表」） |
| 以 `fju_app` 身分 | INSERT 成功、UPDATE 被 `permission denied` 擋下（契約 01 §5 的正向用例） |

## 5. ActorResolver 的狀態矩陣

**狀態是當下從資料庫讀的，不是登入當時 cookie 裡的快照**——這是停用能不能立刻生效的關鍵。
測試直接寫 `users.status`（票 #46 明寫可以這樣造資料），然後用同一個 cookie 重新解析：

| 情境 | 結果 |
|---|---|
| 沒有 cookie／亂編的 cookie／session 被刪掉 | `anonymous` |
| `status` 改成 pending／active／disabled | 同一個 cookie 立刻反映新狀態 |
| `deidentified_at` 有值 | 一律當作 `deidentified`（即使 `status` 還沒改） |
| `must_change_password` 改成 true | 立刻反映 |

閘門結果（`application/accounts/actor.ts`，另有 43 條純邏輯單元測試把矩陣跑滿）：

| 狀態 | 可以做 | 其餘回 |
|---|---|---|
| 未登入 | — | `UNAUTHENTICATED` |
| pending | 讀 session、改密、看與改自己的申請 | `ACCOUNT_PENDING` |
| must-change | 讀 session、改密 | `PASSWORD_CHANGE_REQUIRED` |
| active | 全部（狀態層面） | — |
| disabled／deidentified | — | `UNAUTHENTICATED` |

三個容易寫錯的組合也各有一條測試：停用優先於 must-change；must-change 優先於 pending
（A1 首次登入就是這一格）；停用**不回** `ACCOUNT_DISABLED`，免得變成探測帳號狀態的側通道。

### 2026-09-16 review 的連帶調整：停用＝未登入

S01-02 補上帳號狀態矩陣之後，`/get-session` 本身就會擋掉停用與去識別化的人。
`ActorResolver` 因此把那個拒絕翻譯成 `ANONYMOUS` 而不是「身分是 disabled 的登入者」——
這才是契約 03 §2 寫的「disabled 一律當作未登入」。三條測試跟著改成斷言 `kind === 'anonymous'`，
`statusGate` 對每一種能力仍然回 `UNAUTHENTICATED`，對呼叫端的結果沒有變。

### 角色來自 `role_assignments`，不是套件的 `users.role`

有一條測試把 `users.role` 設成 `admin` 但不建任何 `role_assignments`，斷言 `actor.roles` 是空的
——套件欄不是業務角色。撤銷（`revoked_real_at`）之後角色也會消失。

## 6. 本機跑出來的結果

```
$ pnpm -C web typecheck                 ✅
$ pnpm -C web lint                      ✅
$ pnpm -C web lint:boundaries-test      ✅ 14 個反例、7 個合法例，全部符合預期
$ pnpm -C web build                     ✅
$ pnpm -C web test:unit                 ✅ 9 檔 141 條（actor 43 條、records 10 條為本票新增）
$ pnpm -C web vitest run --project integration src/
                                        ✅ 8 檔 310 條（三向 12 條、帳本與稽核 16 條、ActorResolver 17 條為本票新增）
```

## 7. 順手修掉的一條測試

S01-02 的 gate (b) 測試原本斷言「伺服器端呼叫被封鎖端點**不會**被路由封鎖擋下」——
那是當時的事實，也是本票要補的缺口。本票把 marker 加上去之後，那條斷言必須反過來寫，
已改成：白名單端點在伺服器端仍可呼叫（證明 hook 分得出有沒有 request），
被封鎖的端點沒有 marker 就擋。

## 8. NOT_RUN／沒做什麼

- CI 七道在本 PR 的最新 commit：**待 PR 開出後回填**。
- `receipt_purge` 到期清理工作：**S12**（本票只驗「清掉之後 `result_ref` 還在」）。
- 各模組自己的授權規則（角色、關係、屆別）：**各切片自己的票**；本票只做帳號狀態閘門。
- `SessionRevocationExecutor`（每人序列化執行器、收斂核對）：**S01-09／S02**；
  本票只交付它會用到的 `internalAuth`。worker 身分的待決事項見第 2 節。
- 任何頁面：**#47**。
- VM 部署：**NOT_RUN**（#187–#189）。
