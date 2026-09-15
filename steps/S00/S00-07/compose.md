# S00-07 證據：六個服務的 Compose、Caddyfile 與 .env.example

執行時間：2026-09-15 16:15:01 CST

## docker compose ps（六個服務都在）
```
NAME           IMAGE                           COMMAND                  SERVICE    CREATED          STATUS                    PORTS
fju-app        ghcr.io/roy4222/fju-web:local   "docker-entrypoint.s…"   app        51 seconds ago   Up 47 seconds (healthy)   3000/tcp
fju-backup     postgres:16.10-alpine           "sh -c 'echo '[backu…"   backup     3 minutes ago    Up 3 minutes              5432/tcp
fju-caddy      caddy:2.10-alpine               "caddy run --config …"   caddy      3 minutes ago    Up 3 minutes              0.0.0.0:8080->80/tcp, [::]:8080->80/tcp
fju-postgres   postgres:16.10-alpine           "docker-entrypoint.s…"   postgres   3 minutes ago    Up 3 minutes (healthy)    0.0.0.0:55432->5432/tcp, [::]:55432->5432/tcp
fju-worker     ghcr.io/roy4222/fju-web:local   "docker-entrypoint.s…"   worker     51 seconds ago   Up 47 seconds             3000/tcp
```

## 服務清單
```
app
backup
caddy
migrate
postgres
worker
```

## migrate 用 owner 連線、跑完就結束
```
migration 完成；schema_meta.schema_version = 0001_s00_roles_and_immutability
migrate 結束碼：0
```

## 憑證分三組（定義上的 env_file）
```
migrate   -> .env.migrate
app       -> .env
worker    -> .env
backup    -> .env.backup
```

## .env.example 只有變數名，沒有任何值
```
變數行數：26
帶值的行數：0
--- 檔案內容 ---
# 本機 .env 範本（契約 05 §6：憑證分三組，分檔存放，互不可見）。
#
# 這個檔案只有變數名稱，**不放任何值**。複製成三個檔案再由維運填：
#   .env          app 組——app 與 worker 讀
#   .env.migrate  owner 組——只有 migrate 與 reset 讀
#   .env.backup   backup 組——只有 backup 服務讀
# VM 上三個檔案都是 600。私鑰只在 Roy 的密碼管理器，不進 repo、不進映像。

# ─────────────────────────────────────────
# app 組 → .env
# ─────────────────────────────────────────
DATABASE_URL=
BETTER_AUTH_SECRET=
BETTER_AUTH_URL=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
TURNSTILE_SITE_KEY=
TURNSTILE_SECRET_KEY=
FILES_ROOT=
FILE_MAX_BYTES=
BUSINESS_CLOCK_OVERRIDE_ENABLED=

# ─────────────────────────────────────────
# owner 組 → .env.migrate
# ─────────────────────────────────────────
DATABASE_URL_OWNER=

# ─────────────────────────────────────────
# backup 組 → .env.backup
# ─────────────────────────────────────────
DATABASE_URL_BACKUP=
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=
AGE_RECIPIENTS=
ALERT_WEBHOOK_URL=

# ─────────────────────────────────────────
# Compose 本身（非憑證，可留空用預設值）
# ─────────────────────────────────────────
APP_IMAGE=
GIT_COMMIT=
APP_VERSION=
POSTGRES_USER=
POSTGRES_PASSWORD=
POSTGRES_DB=
POSTGRES_PORT=
HTTP_PORT=
```

## Caddy 上傳上限
```
	request_body {
		max_size 50MB
	}

```

## 經 Caddy 打到 app
```
GET http://localhost:8080/           -> 200
GET http://localhost:8080/api/health -> 200
```

## 注入測試：migrate 失敗時 app 不啟動
```

 RUN  v3.2.4 /Users/lubaiyu/fju-project/.claude/worktrees/ssh-connection-4ed37a/web

 ✓ |integration| test/compose/compose.integration.test.ts (7 tests) 4986ms
   ✓ 注入：migrate 失敗時 app 不啟動 > migrate 非 0 結束，app 不會被啟動  4211ms

 Test Files  1 passed (1)
      Tests  7 passed (7)
   Start at  16:15:04
   Duration  5.35s (transform 34ms, setup 0ms, collect 55ms, tests 4.99s, environment 0ms, prepare 92ms)

```
