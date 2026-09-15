# S00-10 證據：dispatch-only 部署演練

執行時間：2026-09-15 16:35:17 CST

**本批沒有做任何真部署**：沒有 SSH 到校方 VM、沒有動線上原型、CD 沒有接上真部署。

## ops/deploy.sh --dry-run（契約 05 §3 的七個步驟）
```
部署 tag：0cbf302abc
健康檢查端點：http://127.0.0.1:8080/api/health（逾時 60s）
健康條件：有限四項（commit、imageDigest、schemaVersion、HTTP 200）；worker 欄必須是 null

[dry-run] 1/7 取得部署鎖（flock，拿不到就失敗，不排隊）
        $ flock --nonblock /tmp/fju-deploy-evidence/deploy.lock -c "<以下步驟>"
[dry-run] 2/7 記下目前版本到 /tmp/fju-deploy-evidence/previous_tag（含 digest）
        $ docker compose images app --format json > /tmp/fju-deploy-evidence/previous_tag
[dry-run] 3/7 拉新映像
        $ docker compose pull app worker migrate
[dry-run] 4/7 用新映像跑 migration（失敗即中止，舊 app 繼續跑）
        $ docker compose run --rm migrate
[dry-run] 5/7 啟動新版 app 與 worker
        $ docker compose up -d app worker
[dry-run] 6/7 健康判定（60 秒內要全部符合）
        $ curl -sf http://127.0.0.1:8080/api/health  # 比對 commit／imageDigest／schemaVersion，且 worker 必須是 null
[dry-run] 7/7 寫 deploy_log（/tmp/fju-deploy-evidence/deploy_log）
        $ echo "<時間>	deployed	0cbf302abc	limited-no-worker" >> /tmp/fju-deploy-evidence/deploy_log

這是演練，什麼都沒有執行。要真的部署請加 --execute（S14 才在 VM 上跑）。
```

## 帶 --expect-worker（E02 出場後才用）
```
部署 tag：0cbf302abc
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

## 自動測試
```

 RUN  v3.2.6 /Users/lubaiyu/fju-project/.claude/worktrees/ssh-connection-4ed37a/web

 ✓ |integration| test/ops/deploy.integration.test.ts (19 tests) 337ms

 Test Files  1 passed (1)
      Tests  19 passed (19)
   Start at  16:35:18
   Duration  765ms (transform 45ms, setup 0ms, collect 73ms, tests 337ms, environment 0ms, prepare 95ms)

```
