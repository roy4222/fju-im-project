# S00-06 證據：分層 lint 正反例

執行時間：2026-09-15 19:00:41 CST  Node：v22.23.2

S00 卡列的七反例三合法例全部保留；其餘六反例三合法例覆蓋母 spec §4.3 的跨模組規則（公開入口、type-only），那兩條只看 layer 判斷不出來（review R2、R2a、R2b）。

## pnpm lint（正式程式，應無錯）
```
$ eslint src test e2e eslint-rules scripts
exit=0
```

## pnpm lint:boundaries-test
```
$ node scripts/lint-boundaries-test.mjs
分層 lint fixtures：13 個反例、6 個合法例
  ok    lint-fixtures/src/domain/demo/invalid-domain-imports-framework.ts  ← fju/external-packages（1 error）
  ok    lint-fixtures/src/domain/demo/invalid-domain-imports-infrastructure.ts  ← boundaries/dependencies（1 error）
  ok    lint-fixtures/src/application/demo/invalid-application-imports-infrastructure.ts  ← boundaries/dependencies（1 error）
  ok    lint-fixtures/src/app/demo/invalid-page-imports-infrastructure.tsx  ← boundaries/dependencies（1 error）
  ok    lint-fixtures/src/app/demo/invalid-client-imports-composition.tsx  ← fju/client-server-boundary（1 error）
  ok    lint-fixtures/src/app/demo/invalid-actions/actions.ts  ← fju/actions-file-contract（2 error）
  ok    lint-fixtures/src/application/demo/invalid-direct-auth-api.ts  ← no-restricted-imports（2 error）
  ok    lint-fixtures/src/application/other/invalid-cross-module-runtime.ts  ← fju/module-boundary（1 error）
  ok    lint-fixtures/src/app/demo/invalid-imports-module-private.tsx  ← fju/module-boundary（2 error）
  ok    lint-fixtures/src/domain/demo/invalid-cross-module-domain-runtime.ts  ← fju/module-boundary（1 error）
  ok    lint-fixtures/src/application/other/invalid-reexport-cross-module-runtime.ts  ← fju/module-boundary（1 error）
  ok    lint-fixtures/src/app/demo/invalid-reexport-module-private.tsx  ← fju/module-boundary（2 error）
  ok    lint-fixtures/src/infrastructure/invalid-imports-module-private.ts  ← fju/module-boundary（1 error）
  ok    lint-fixtures/src/app/demo/valid-actions/form.tsx  ← 放行
  ok    lint-fixtures/src/application/demo/valid-application-uses-domain.ts  ← 放行
  ok    lint-fixtures/src/app/demo/valid-page-uses-composition.tsx  ← 放行
  ok    lint-fixtures/src/application/other/valid-cross-module-type-only.ts  ← 放行
  ok    lint-fixtures/src/application/other/valid-reexport-type-only.ts  ← 放行
  ok    lint-fixtures/src/infrastructure/valid-uses-module-entry.ts  ← 放行

全部符合預期。
exit=0
```

## 反例原始 lint 輸出
```

/Users/lubaiyu/fju-project/.claude/worktrees/ssh-connection-4ed37a/web/lint-fixtures/src/app/demo/invalid-actions/actions.ts
  4:14  error  actions.ts 只能匯出 async 函式，`DEMO_LIMIT` 不是（契約 02 §7）。  fju/actions-file-contract
  6:8   error  actions.ts 只能匯出 async 函式，`submitDemo` 不是（契約 02 §7）。  fju/actions-file-contract

/Users/lubaiyu/fju-project/.claude/worktrees/ssh-connection-4ed37a/web/lint-fixtures/src/app/demo/invalid-client-imports-composition.tsx
  4:1  error  Client Component（'use client'）不可引用 ../../composition/demo；改成呼叫同目錄 actions.ts 的 Server Function（契約 02 §7）。  fju/client-server-boundary

/Users/lubaiyu/fju-project/.claude/worktrees/ssh-connection-4ed37a/web/lint-fixtures/src/app/demo/invalid-imports-module-private.tsx
  3:1  error  跨模組只能引用 `application/demo` 的公開入口（index.ts），不可以直接指到內部檔案 `../../application/demo/valid-application-uses-domain`（母 spec §4.3）。  fju/module-boundary
  3:1  error  app 對 application 只能帶型別（`import type`）；要執行用例請經 composition（母 spec §4.3）。                                                     fju/module-boundary

/Users/lubaiyu/fju-project/.claude/worktrees/ssh-connection-4ed37a/web/lint-fixtures/src/app/demo/invalid-page-imports-infrastructure.tsx
  3:20  error  There is no policy allowing dependencies from elements of type "app" to elements of type "infrastructure"  boundaries/dependencies

/Users/lubaiyu/fju-project/.claude/worktrees/ssh-connection-4ed37a/web/lint-fixtures/src/app/demo/invalid-reexport-module-private.tsx
  3:1  error  跨模組只能引用 `application/demo` 的公開入口（index.ts），不可以直接指到內部檔案 `../../application/demo/valid-application-uses-domain`（母 spec §4.3）。  fju/module-boundary
  3:1  error  app 對 application 只能帶型別（`export type`）；要執行用例請經 composition（母 spec §4.3）。                                                     fju/module-boundary

/Users/lubaiyu/fju-project/.claude/worktrees/ssh-connection-4ed37a/web/lint-fixtures/src/application/demo/invalid-application-imports-infrastructure.ts
  3:20  error  There is no policy allowing dependencies from elements of type "application" and captured values: module="demo" to elements of type "infrastructure"  boundaries/dependencies

/Users/lubaiyu/fju-project/.claude/worktrees/ssh-connection-4ed37a/web/lint-fixtures/src/application/demo/invalid-direct-auth-api.ts
  3:1  error  'better-auth/api' import is restricted from being used by a pattern. Better Auth 的 auth.api 只能由 infrastructure/auth/wrapper 呼叫（契約 03、S01-03）。  no-restricted-imports
  3:1  error  application 與 shared 不可引用 Next、React、Drizzle 或 Better Auth（母 spec §4.3）。（被擋的是 `better-auth/api`）                                               fju/external-packages

/Users/lubaiyu/fju-project/.claude/worktrees/ssh-connection-4ed37a/web/lint-fixtures/src/application/other/invalid-cross-module-runtime.ts
  3:1  error  跨模組的引用只能帶型別：請用 `import type`。執行期呼叫一律走 composition 注入的 port 實例（母 spec §4.3）。  fju/module-boundary

/Users/lubaiyu/fju-project/.claude/worktrees/ssh-connection-4ed37a/web/lint-fixtures/src/application/other/invalid-reexport-cross-module-runtime.ts
  4:1  error  跨模組的re-export只能帶型別：請用 `export type`。執行期呼叫一律走 composition 注入的 port 實例（母 spec §4.3）。  fju/module-boundary

/Users/lubaiyu/fju-project/.claude/worktrees/ssh-connection-4ed37a/web/lint-fixtures/src/domain/demo/invalid-cross-module-domain-runtime.ts
  3:1  error  跨模組的引用只能帶型別：請用 `import type`。執行期呼叫一律走 composition 注入的 port 實例（母 spec §4.3）。  fju/module-boundary

/Users/lubaiyu/fju-project/.claude/worktrees/ssh-connection-4ed37a/web/lint-fixtures/src/domain/demo/invalid-domain-imports-framework.ts
  3:1  error  domain 是純 TypeScript，唯一允許的外部套件是 decimal.js（母 spec §4.3）。（被擋的是 `next/server`）  fju/external-packages

/Users/lubaiyu/fju-project/.claude/worktrees/ssh-connection-4ed37a/web/lint-fixtures/src/domain/demo/invalid-domain-imports-infrastructure.ts
  3:20  error  There is no policy allowing dependencies from elements of type "domain" and captured values: module="demo" to elements of type "infrastructure"  boundaries/dependencies

/Users/lubaiyu/fju-project/.claude/worktrees/ssh-connection-4ed37a/web/lint-fixtures/src/infrastructure/invalid-imports-module-private.ts
  5:1  error  跨模組只能引用 `application/demo` 的公開入口（index.ts），不可以直接指到內部檔案 `../application/demo/valid-application-uses-domain`（母 spec §4.3）。  fju/module-boundary

✖ 17 problems (17 errors, 0 warnings)

```
