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
