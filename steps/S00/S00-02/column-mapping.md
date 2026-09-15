# S00-02 證據：釘版、產生器輸出與欄名對照表

## 釘死的版本（`web/package.json`，lockfile 為準）

| 套件 | 版本 |
|---|---|
| `better-auth` | 1.7.5 |
| `drizzle-orm` | 0.45.2 |
| `drizzle-kit` | 0.31.10（dev） |
| `pg` | 8.23.0 |
| `uuidv7` | 1.2.1 |
| `@better-auth/cli` | 1.5.0-beta.13（dev，只用來產 schema） |

`@better-auth/cli` 的 stable 線（1.4.21）鎖 `better-call@1.1.8`，與 `better-auth@1.7.5` 需要的
`better-call@1.4.0` 衝突，載入設定時會 `SyntaxError: does not provide an export named 'kAPIErrorHeaderSymbol'`。
1.5.0-beta.13 可正常產出，且與用 `pnpm dlx` 隔離執行的輸出逐字相同。這是**開發期工具**，
不進 runtime 相依。

## 產生器怎麼跑

```bash
pnpm -C web auth:generate
```

`scripts/auth-generate.mjs` 會暫時拿掉設定檔鏈上的 `import 'server-only'`（CLI 載不動帶這行的設定），
跑完再放回去，並在產物檔頭補上 server-only。輸出固定在
`web/src/infrastructure/db/schema/auth.generated.ts`，可重跑、輸出穩定。

## 欄名對照：套件產出 vs 契約 01 §4.1

### admin plugin 的三個套件欄（本票要回答的問題）

| 契約 01 §4.1 寫的 | 安裝後產生器實際產出（SQL 欄名） | 結果 |
|---|---|---|
| `banned` | `banned`（`boolean`，default false） | **已核對，一致** |
| `ban_reason` | `ban_reason`（`text`，NULL） | **已核對，一致** |
| `ban_expires` | `ban_expires`（`timestamp`，NULL） | **已核對，一致** |

三個欄名與契約相同，不需要回 Vault 改 spec。

### 業務擴充欄

| 契約 01 §4.1 | 產生器輸出 | 結果 |
|---|---|---|
| `users.status`（NOT NULL default `'pending'`） | `status`，NOT NULL，default `'pending'` | 一致 |
| `users.must_change_password`（NOT NULL default false） | `must_change_password`，NOT NULL，default false | 一致 |
| `users.deidentified_at`（NULL） | `deidentified_at`，NULL | 一致 |
| `sessions.login_method`（NOT NULL） | `login_method`，NOT NULL | 一致 |

CHECK 白名單（`status IN ('pending','active','disabled')`、`login_method IN ('google','password')`）
產生器不會產，依契約 01 §12 寫在第一支 migration 的純 SQL 裡（S00-04）。

### 契約沒有寫、但套件會多產的欄

| 表 | 欄 | 來源 | 處置 |
|---|---|---|---|
| `users` | `role`（text，NULL） | admin plugin | 保留欄位，但**業務角色不看它**（角色由模組 01 的業務表決定）。S01 的 auth 包裝器要確保不把它當授權依據。 |
| `sessions` | `impersonated_by`（text，NULL） | admin plugin 的 impersonation 功能 | 保留欄位；契約 03 §2 已封鎖全部 `admin/*` HTTP 路由，功能不開放。 |

這兩欄是套件欄不是業務擴充，處置與 `banned` 同一條規則。建議在模組 01 §12 補一行記錄，**不改**契約 01 §4.1 的業務擴充表。

## 型別差異：產生器給不出契約 01 §1 要的型別

產生器輸出（`auth.generated.ts`）與契約 01 §1 有三處系統性差異，**不是欄名問題**：

| 項目 | 產生器 | 契約 01 §1 | 本票處置 |
|---|---|---|---|
| 主鍵與 user FK | `text` | `uuid`（應用產生 uuidv7） | repo 實際使用的 `auth.ts` 改成 `uuid`；`advanced.database.generateId` 已設成 `uuidv7()` |
| 時間欄 | `timestamp`（無時區） | `timestamptz`（UTC） | `auth.ts` 全部加 `withTimezone: true` |
| user FK 刪除動作 | `ON DELETE CASCADE` | 預設 `RESTRICT`；使用者列永不硬刪，改去識別化 | `auth.ts` 改成 `onDelete: 'restrict'`、`onUpdate: 'restrict'` |

因此 schema 分成兩個檔：

- `auth.generated.ts`：產生器原樣輸出，只作核對基準，不要手改。
- `auth.ts`：實際使用的 schema，**欄名逐欄等於產生器輸出**，型別依契約 01 §1 調整。

`auth-schema.test.ts` 同時斷言「兩邊表名與欄名完全一致」與「型別差異確實照契約套上去」，
所以改壞任何一邊都會紅。

## 測試輸出

執行時間：2026-09-15 15:41:24 CST  Node：v22.23.2

```
$ vitest run --project unit

 RUN  v3.2.4 /Users/lubaiyu/fju-project/.claude/worktrees/ssh-connection-4ed37a/web

 ✓ |unit| src/shared/errors.test.ts (8 tests) 4ms
 ✓ |unit| src/shared/result.test.ts (4 tests) 4ms
 ✓ |unit| src/shared/time/time.test.ts (20 tests) 7ms
 ✓ |unit| src/infrastructure/db/schema/auth-schema.test.ts (17 tests) 5ms

 Test Files  4 passed (4)
      Tests  49 passed (49)
   Start at  15:41:25
   Duration  759ms (transform 149ms, setup 0ms, collect 556ms, tests 20ms, environment 1ms, prepare 428ms)

```
