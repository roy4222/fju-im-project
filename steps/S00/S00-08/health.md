# S00-08 證據：/api/health 與空殼首頁

執行時間：2026-09-15 16:15:24 CST

## 正常：200
```
$ curl -i http://localhost:8080/api/health
HTTP/1.1 200 OK
Cache-Control: no-store
Content-Type: application/json
Date: Tue, 15 Sep 2026 08:15:24 GMT
Vary: rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch
Via: 1.1 Caddy
Transfer-Encoding: chunked

{"ok":true,"version":"0.1.0","commit":"393c1c41f0c9c1196f7f0085336b9455b8642469","imageDigest":null,"schemaVersion":"0001_s00_roles_and_immutability","worker":{"version":null,"lastTickAt":null}}```

欄位名與契約 05 §1／§3 逐字一致：`ok`、`version`、`commit`、`imageDigest`、`schemaVersion`、`worker.version`、`worker.lastTickAt`。
`imageDigest` 在本機 build 沒有 registry digest 所以是 null；CI 推 GHCR 後由 build 參數帶入（S00-09）。
`worker` 兩欄照票固定 null，S02-06 換真值。

## 空殼首頁
```
||輔仁大學資訊管理學系專題管理平台||工程骨架空殼（切片 S00）。業務功能從 S01 開始，這一頁還沒有任何內容。||健康檢查：|/api/health|||
```

## 資料庫不可用：503，回應裡沒有任何連線設定
```
$ docker compose stop postgres
$ curl -i http://localhost:8080/api/health
HTTP/1.1 503 Service Unavailable
Cache-Control: no-store
Content-Type: application/json
Date: Tue, 15 Sep 2026 08:15:25 GMT
Vary: rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch
Via: 1.1 Caddy
Transfer-Encoding: chunked

{"ok":false,"version":"0.1.0","commit":"393c1c41f0c9c1196f7f0085336b9455b8642469","imageDigest":null,"schemaVersion":null,"worker":{"version":null,"lastTickAt":null}}```

回應內沒有主機、埠、使用者、密碼。真正的原因只寫在伺服器 log，不進回應：

```
[health] 讀不到資料庫狀態 Error: getaddrinfo ENOTFOUND postgres
```

（`pnpm test:integration` 裡的 `health.integration.test.ts` 另外逐字斷言回應中
不含 `postgres://`、主機、埠、使用者與密碼。）

## 自動測試
```
 RUN  v3.2.4 /Users/lubaiyu/fju-project/.claude/worktrees/ssh-connection-4ed37a/web
[90m    at processTicksAndRejections (node:internal/process/task_queues:103:5)[39m
[90m    at processTicksAndRejections (node:internal/process/task_queues:103:5)[39m
[90m    at processTicksAndRejections (node:internal/process/task_queues:103:5)[39m
 ✓ |integration| src/infrastructure/health/health.integration.test.ts (5 tests) 69ms
 Test Files  1 passed (1)
      Tests  5 passed (5)
   Start at  16:15:41
   Duration  691ms (transform 58ms, setup 0ms, collect 328ms, tests 69ms, environment 0ms, prepare 66ms)
```
