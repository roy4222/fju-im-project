# web｜正式程式碼

輔仁大學資訊管理學系專題管理平台的正式實作。`prototype/` 是評選用的前端原型，不是這裡的上游。

## 需要的環境

- Node 22 LTS（`.nvmrc` 已釘 22；`nvm use` 即可）
- pnpm 11
- Docker（整合測試與本機 Compose 用，S00-03／S00-07）

## 常用指令

從 repo 根執行，或 `cd web` 後拿掉 `-C web`：

```bash
pnpm -C web dev         # 本機開發伺服器（http://localhost:3000）
pnpm -C web typecheck   # tsc --noEmit
pnpm -C web test:unit   # 不需要資料庫的單元測試
pnpm -C web build       # production build
```

## 六層目錄（母 spec §4.3）

```
web/src/
  domain/<module>/         純 TypeScript：實體、值物件、不變規則、領域錯誤
  application/<module>/    用例、port 介面、DTO、授權政策
  infrastructure/          Drizzle schema／repository、Better Auth 設定、檔案儲存、worker、Clock
  app/                     Next App Router：routes、actions.ts、Route Handlers、UI
  composition/             組裝根（server-only）：注入 infrastructure 到 application
  shared/                  純型別與工具：Result、錯誤碼、臺灣時間演算
```

路徑別名在 `tsconfig.json`：`@/domain/*`、`@/application/*`、`@/infrastructure/*`、`@/app/*`、`@/composition/*`、`@/shared/*`，以及總括的 `@/*`。

各層可以引用什麼、不可以引用什麼，看各層目錄下的 `README.md`；規則由 lint 強制（S00-06 補上規則清單）。

## 共用工具

- `@/shared/time`：`RealClock`／`BusinessClock`、臺灣日界與截止分鐘的換算（母 spec §4.11）。截止是「`receivedBusinessAt < 截止分鐘起點 + 1 分鐘`」，階段結束日含當天。
- `@/shared/result`：契約 02 §1 的 `Result<R>`＝`Ok`（一定帶 `requestId`、`serverTime`）或 `Err`。
- `@/shared/errors`：契約 02 §1 的錯誤碼與預設下一步。

## 分層 lint 規則（S00-06）

`pnpm -C web lint` 對正式程式跑；`pnpm -C web lint:boundaries-test` 對 `lint-fixtures/` 的七個反例與三個合法例逐檔斷言，規則被改壞時它會先紅。

| 規則 | 擋什麼 | 來源 |
|---|---|---|
| `boundaries/dependencies` | 跨層引用超出 §4.3 矩陣（例如 domain 引用 infrastructure、application 引用 infrastructure、app 直接引用 infrastructure） | 母 spec §4.3 |
| `fju/external-packages` | domain 引用 `decimal.js` 以外的外部套件；application 與 shared 引用 Next、React、Drizzle、Better Auth、pg | 母 spec §4.3 |
| `fju/client-server-boundary` | `'use client'` 檔案引用 `composition`、`infrastructure` 或 `server-only` | 契約 02 §7 |
| `fju/actions-file-contract` | `actions.ts` 沒有檔頭 `'use server'`、匯出非 async 的東西、或多加了 `import 'server-only'` | 契約 02 §7 |
| `fju/server-only-header` | `composition/`、`infrastructure/` 的檔案沒有 `import 'server-only'` | 母 spec §4.3 |
| `no-restricted-imports` | 直接引用 Better Auth 原生 API（只有 `infrastructure/auth/wrapper` 可以）；四層以上的相對路徑 | 契約 03、S01-03 |
| `import/no-cycle` | 循環引用 | 母 spec §4.3 |

Client Component 匯入同目錄 `actions.ts` 是明確例外（compiler 會把匯出轉成 Server Action 參照），`lint-fixtures` 的合法例 1 就是這個情形。

尚未納入：`boundaries/entry-point`（domain／application 對外只露 `index.ts`）。plugin v7 的 `entry-point` 已標記 deprecated 且與現有設定衝突，等 S01 有真正的模組時改用 `boundaries/dependencies` 的 selector 補上。

### fixtures 對照

| fixture | 預期 |
|---|---|
| `domain/demo/invalid-domain-imports-framework.ts` | 被 `fju/external-packages` 擋 |
| `domain/demo/invalid-domain-imports-infrastructure.ts` | 被 `boundaries/dependencies` 擋 |
| `application/demo/invalid-application-imports-infrastructure.ts` | 被 `boundaries/dependencies` 擋 |
| `app/demo/invalid-page-imports-infrastructure.tsx` | 被 `boundaries/dependencies` 擋 |
| `app/demo/invalid-client-imports-composition.tsx` | 被 `fju/client-server-boundary` 擋 |
| `app/demo/invalid-actions/actions.ts` | 被 `fju/actions-file-contract` 擋 |
| `application/demo/invalid-direct-auth-api.ts` | 被 `no-restricted-imports` 擋 |
| `app/demo/valid-actions/form.tsx` | 放行（Client 呼叫同目錄 Server Action） |
| `application/demo/valid-application-uses-domain.ts` | 放行（application 用本模組 domain 公開入口與 `@/shared`） |
| `app/demo/valid-page-uses-composition.tsx` | 放行（Server Component 經 composition 取用例） |

fixtures 之間刻意用相對路徑而不是 `@/` 別名：`@/` 指向 `src/`，fixtures 在 `lint-fixtures/src/`，用別名會解析不到、邊界規則也就看不出違規。
