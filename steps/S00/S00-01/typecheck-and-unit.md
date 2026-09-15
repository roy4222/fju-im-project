# S00-01 證據：typecheck 與單元測試

執行時間：2026-09-15 15:27:07 CST
Node：v22.23.2  pnpm：11.0.9

## pnpm typecheck
```
$ tsc --noEmit
exit=0
```

## pnpm test:unit
```
$ vitest run --project unit

 RUN  v3.2.4 /Users/lubaiyu/fju-project/.claude/worktrees/ssh-connection-4ed37a/web

 ✓ |unit| src/shared/result.test.ts (4 tests) 3ms
 ✓ |unit| src/shared/errors.test.ts (8 tests) 6ms
 ✓ |unit| src/shared/time/time.test.ts (20 tests) 5ms

 Test Files  3 passed (3)
      Tests  32 passed (32)
   Start at  15:27:09
   Duration  372ms (transform 104ms, setup 0ms, collect 129ms, tests 15ms, environment 0ms, prepare 253ms)

```
