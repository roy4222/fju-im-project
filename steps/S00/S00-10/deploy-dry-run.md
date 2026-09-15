# S00-10 證據：dispatch-only 部署演練

執行時間：2026-09-15 16:49:04 CST

**本批沒有做任何真部署**：沒有 SSH 到校方 VM、沒有動線上原型、CD 沒有接上真部署。

## ops/deploy.sh --dry-run（契約 05 §3 的七個步驟）
```
部署 tag：0cbf302abc
映像：ghcr.io/roy4222/fju-web:0cbf302abc
健康檢查端點：http://127.0.0.1:8080/api/health（逾時 60s）
健康條件：有限四項（HTTP 200、commit、imageDigest、schemaVersion）；worker 欄必須是 null

[dry-run] 1/7 取得部署鎖（flock，拿不到就失敗，不排隊）
        $ flock --nonblock /tmp/fju-deploy-evidence/deploy.lock -c "<以下步驟>"
[dry-run] 2/7 記下目前版本到 /tmp/fju-deploy-evidence/previous_tag（映像參照＋digest）
        $ 讀目前 app 容器的映像與 digest，寫成 PREVIOUS_APP_IMAGE／PREVIOUS_IMAGE_DIGEST
[dry-run] 3/7 拉新映像
        $ docker compose pull app worker migrate
[dry-run] 4/7 用新映像跑 migration（失敗即中止，舊 app 繼續跑）
        $ docker compose run --rm migrate  # 從輸出取最後一支 migration 名稱
[dry-run] 5/7 啟動新版 app 與 worker
        $ docker compose up -d app worker
[dry-run] 6/7 健康判定（60 秒內要全部符合）
        $ curl -sf http://127.0.0.1:8080/api/health
        $ node ops/check-health.mjs  # 比對 commit=<tag>、imageDigest=<pull 到的 digest>、schemaVersion=<migrate 輸出>，且 worker 必須是 null
[dry-run] 7/7 寫 deploy_log（/tmp/fju-deploy-evidence/deploy_log）
        $ echo "<時間>	deployed	0cbf302abc	limited-no-worker" >> /tmp/fju-deploy-evidence/deploy_log

這是演練，什麼都沒有執行。要真的部署請加 --execute（S14 才在 VM 上跑）。
```

## 帶 --expect-worker（E02 出場後才用）
```
部署 tag：0cbf302abc
映像：ghcr.io/roy4222/fju-web:0cbf302abc
健康檢查端點：http://127.0.0.1:8080/api/health（逾時 60s）
健康條件：完整六項（含 worker.version 與 worker.lastTickAt）

[dry-run] 1/7 取得部署鎖（flock，拿不到就失敗，不排隊）
        $ flock --nonblock /tmp/fju-deploy-evidence/deploy.lock -c "<以下步驟>"
```

## 健康判定會擋下不符的版本
```
# commit 不是這次部署的：
健康判定不符：
  - commit 是 old999，不是這次部署的 abc123

# digest 不符：
健康判定不符：
  - imageDigest 是 sha256:old，不是這次部署的 sha256:new

# schemaVersion 不等於 migrate 輸出的：
健康判定不符：
  - schemaVersion 是 0000_old，不是 migrate 輸出的 0001_s00_roles_and_immutability

# 沒帶 --expect-worker 但 worker 已經有值（旗標與階段不符）：
健康判定不符：
  - 沒有帶 --expect-worker，但 worker 欄不是 null（{"version":"abc123","lastTickAt":"2026-09-15T08:00:00Z"}）——worker 已經交付的話請加上旗標

# 四項都符合、worker 是 null：
健康判定通過
```

## cd.yml 只能手動觸發、預設演練
```yaml
on:
  workflow_dispatch:
    inputs:
      tag:
        description: '要部署的 tag（commit SHA）'
        required: true
        type: string
      mode:
        description: 'dry-run 只印步驟；execute 才真的部署（S00 階段只准 dry-run）'
        required: true
        default: dry-run
        type: choice
        options: [dry-run, execute]
      expect_worker:
        description: 'E02 出場後才勾：健康判定加上 worker.version 與 lastTickAt'
        required: false
        default: false
        type: boolean

permissions:
```

選 `execute` 會在第一步直接失敗：
```yaml
      - name: S00 階段只准演練
        if: inputs.mode == 'execute'
        run: |
          echo "::error::S00 只啟用 CI。真正的部署要等第一次 staging 部署階段接上 Secrets、environment 與 VM（S14）。"
          exit 1
```

## Codex 對 PR #199 的四個 P1 已修

| 問題 | 修法 |
|---|---|
| `<tag>` 只拿去比對，沒有真的決定部署哪個映像 | `APP_IMAGE=$IMAGE_REPO:$TAG` 並 export，Compose 的 app／worker／migrate 都吃它 |
| 回滾只是原地 `up -d`，沒有換回舊映像 | `previous_tag` 改存 `PREVIOUS_APP_IMAGE` 與 `PREVIOUS_IMAGE_DIGEST`；回滾時換回再 `up -d`，並重跑健康判定、分別記 healthy／unhealthy |
| 只傳 `EXPECT_TAG`，四項門檻悄悄退化成一項 | pull 後讀 registry digest、從 migrate 輸出取 `SCHEMA_VERSION`，四個期望值一起傳給 `check-health.mjs`；migrate 沒印 `SCHEMA_VERSION` 就中止 |
| 容器永遠回 `imageDigest: null` | digest 在 build 時烤不進去，改由 `deploy.sh` export `IMAGE_DIGEST`，Compose 的 app 與 worker 帶進容器 |

## 自動測試
```

 RUN  v3.2.6 /Users/lubaiyu/fju-project/.claude/worktrees/ssh-connection-4ed37a/web

 ✓ |integration| test/ops/deploy.integration.test.ts (29 tests) 358ms

 Test Files  1 passed (1)
      Tests  29 passed (29)
   Start at  16:49:04
   Duration  674ms (transform 62ms, setup 0ms, collect 106ms, tests 358ms, environment 0ms, prepare 55ms)

```
