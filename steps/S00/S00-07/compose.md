# S00-07 證據：六個服務的 Compose、Caddyfile 與 .env.example

執行時間：2026-09-15 17:47:59 CST

## docker compose ps（六個服務都在）
```
NAME           IMAGE                           COMMAND                  SERVICE    CREATED          STATUS                    PORTS
fju-app        ghcr.io/roy4222/fju-web:local   "docker-entrypoint.s…"   app        40 seconds ago   Up 37 seconds (healthy)   3000/tcp
fju-backup     postgres:16.10-alpine           "sh -c 'echo '[backu…"   backup     40 seconds ago   Up 38 seconds             5432/tcp
fju-caddy      caddy:2.10-alpine               "caddy run --config …"   caddy      39 seconds ago   Up 37 seconds             0.0.0.0:8080->80/tcp, [::]:8080->80/tcp
fju-postgres   postgres:16.10-alpine           "docker-entrypoint.s…"   postgres   4 minutes ago    Up 4 minutes (healthy)    127.0.0.1:55432->5432/tcp
fju-worker     ghcr.io/roy4222/fju-web:local   "docker-entrypoint.s…"   worker     40 seconds ago   Up 37 seconds             3000/tcp
```

## 對宿主機發布的 port（review R3）

基礎 `docker-compose.yml` 是 VM 上的樣子：**只有 caddy 對外**，postgres 完全不發布。
SOP 01 §4 的 ufw 只開 22/80/443，多發布一個 5432 等於在防火牆之外開一個帶已知 superuser 憑證的入口。

```
$ docker compose config  # 基礎
app       （不發布）
backup    （不發布）
caddy     0.0.0.0:8080->80
migrate   （不發布）
postgres  （不發布）
worker    （不發布）

$ docker compose -f docker-compose.yml -f docker-compose.local.yml config  # 加本機覆蓋
postgres  127.0.0.1:55432->5432
```

本機覆蓋只綁 `127.0.0.1`。實測：`docker port fju-postgres` 顯示 `5432/tcp -> 127.0.0.1:55432`，
127.0.0.1 連得到、LAN 位址（192.168.0.144:55432）連不到。

## migrate 用 owner 連線、跑完就結束
```
migration 完成；schema_meta.schema_version = 0001_s00_roles_and_immutability
SCHEMA_VERSION=0001_s00_roles_and_immutability
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
```

## Caddy 上傳上限（review R6）
```
# 反向代理（契約 03 §5：上傳上限在這裡，不是在 Server Action 的 bodySizeLimit）。
#
# 本機用 http://localhost；staging／production 的 host 與憑證由 SOP 04／S14 帶入。

{
	admin off
	# 本機不要自動申請憑證。
--
	# 上傳上限（契約 02 §6）：單檔上限 100MiB，外加 multipart 邊界與其他欄位的餘裕，
	# 所以 proxy 這一層設 105MB。超過的請求在這裡就被擋掉，不會進到 app。
	# Server Action 的 bodySizeLimit 維持預設 1MB——檔案永遠不走 Server Action。
	# 預設值就是契約值；只有測試會用 UPLOAD_MAX_SIZE 壓成很小來驗證真的擋得住。
	request_body {
		max_size {$UPLOAD_MAX_SIZE:105MB}
	}
```

契約 02 §6 指定 105MB。預設值就是契約值；`UPLOAD_MAX_SIZE` 只給測試把上限壓小用，
`web/test/proxy/upload-limit.integration.test.ts` 用同一份設定檔證明超過就 413、沒超過就到得了 upstream。

## 經 Caddy 打到 app
```
GET http://localhost:8080/           -> 200
GET http://localhost:8080/api/health -> 200
```

## 自動測試
```
 ✓ |integration| test/compose/compose.integration.test.ts (11 tests) 5787ms
   ✓ 注入：migrate 失敗時 app 不啟動 > migrate 非 0 結束，app 不會被啟動  4591ms

 Test Files  2 passed (2)
      Tests  16 passed (16)
   Start at  17:48:00
   Duration  6.18s (transform 48ms, setup 0ms, collect 103ms, tests 8.03s, environment 0ms, prepare 137ms)

```
