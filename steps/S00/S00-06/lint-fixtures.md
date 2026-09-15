# S00-06 證據：分層 lint 正反例

執行時間：2026-09-15 15:35:03 CST
Node：v22.23.2

## pnpm lint（正式程式，應無錯）
```
$ eslint src eslint-rules scripts
exit=0
```

## pnpm lint:boundaries-test（七反例三合法例）
```
$ node scripts/lint-boundaries-test.mjs
分層 lint fixtures：7 個反例、3 個合法例
  ok    lint-fixtures/src/domain/demo/invalid-domain-imports-framework.ts  ← fju/external-packages（1 error）
  ok    lint-fixtures/src/domain/demo/invalid-domain-imports-infrastructure.ts  ← boundaries/dependencies（1 error）
  ok    lint-fixtures/src/application/demo/invalid-application-imports-infrastructure.ts  ← boundaries/dependencies（1 error）
  ok    lint-fixtures/src/app/demo/invalid-page-imports-infrastructure.tsx  ← boundaries/dependencies（1 error）
  ok    lint-fixtures/src/app/demo/invalid-client-imports-composition.tsx  ← fju/client-server-boundary（1 error）
  ok    lint-fixtures/src/app/demo/invalid-actions/actions.ts  ← fju/actions-file-contract（2 error）
  ok    lint-fixtures/src/application/demo/invalid-direct-auth-api.ts  ← no-restricted-imports（2 error）
  ok    lint-fixtures/src/app/demo/valid-actions/form.tsx  ← 放行
  ok    lint-fixtures/src/application/demo/valid-application-uses-domain.ts  ← 放行
  ok    lint-fixtures/src/app/demo/valid-page-uses-composition.tsx  ← 放行

全部符合預期。
exit=0
```

## 反例原始 lint 輸出（每個反例各報一個錯）
```

/Users/lubaiyu/fju-project/.claude/worktrees/ssh-connection-4ed37a/web/lint-fixtures/src/app/demo/invalid-actions/actions.ts
  4:14  error  actions.ts 只能匯出 async 函式，`DEMO_LIMIT` 不是（契約 02 §7）。  fju/actions-file-contract
  6:8   error  actions.ts 只能匯出 async 函式，`submitDemo` 不是（契約 02 §7）。  fju/actions-file-contract

/Users/lubaiyu/fju-project/.claude/worktrees/ssh-connection-4ed37a/web/lint-fixtures/src/app/demo/invalid-client-imports-composition.tsx
  4:1  error  Client Component（'use client'）不可引用 ../../composition/demo；改成呼叫同目錄 actions.ts 的 Server Function（契約 02 §7）。  fju/client-server-boundary

/Users/lubaiyu/fju-project/.claude/worktrees/ssh-connection-4ed37a/web/lint-fixtures/src/app/demo/invalid-page-imports-infrastructure.tsx
  3:20  error  There is no policy allowing dependencies from elements of type "app" to elements of type "infrastructure"  boundaries/dependencies

/Users/lubaiyu/fju-project/.claude/worktrees/ssh-connection-4ed37a/web/lint-fixtures/src/application/demo/invalid-application-imports-infrastructure.ts
  3:20  error  There is no policy allowing dependencies from elements of type "application" and captured values: module="demo" to elements of type "infrastructure"  boundaries/dependencies

/Users/lubaiyu/fju-project/.claude/worktrees/ssh-connection-4ed37a/web/lint-fixtures/src/application/demo/invalid-direct-auth-api.ts
  3:1  error  'better-auth/api' import is restricted from being used by a pattern. Better Auth 的 auth.api 只能由 infrastructure/auth/wrapper 呼叫（契約 03、S01-03）。  no-restricted-imports
  3:1  error  application 與 shared 不可引用 Next、React、Drizzle 或 Better Auth（母 spec §4.3）。（被擋的是 `better-auth/api`）                                               fju/external-packages

/Users/lubaiyu/fju-project/.claude/worktrees/ssh-connection-4ed37a/web/lint-fixtures/src/domain/demo/invalid-domain-imports-framework.ts
  3:1  error  domain 是純 TypeScript，唯一允許的外部套件是 decimal.js（母 spec §4.3）。（被擋的是 `next/server`）  fju/external-packages

/Users/lubaiyu/fju-project/.claude/worktrees/ssh-connection-4ed37a/web/lint-fixtures/src/domain/demo/invalid-domain-imports-infrastructure.ts
  3:20  error  There is no policy allowing dependencies from elements of type "domain" and captured values: module="demo" to elements of type "infrastructure"  boundaries/dependencies

✖ 9 problems (9 errors, 0 warnings)

```
