# R4／R5 重現與修正對照

執行時間：2026-09-15 17:34:50 CST

方法：把 `docker`、`flock`、`curl` 換成假的可執行檔放在 PATH 前面，讓 `deploy.sh --execute` 的每一步都可控。**沒有碰 Docker daemon、沒有真部署**。情境：pull 與 migrate 都成功，`compose up app worker` 回 42（模擬 app 換好了但 worker 起不來）。

## 修正前（固定 head `602a006` 的 ops/deploy.sh）

```
exit=42

呼叫紀錄：
  compose ps --format {{.Image}} app
  image inspect --format {{if .RepoDigests}}{{index .RepoDigests 0}}{{end}} ghcr.io/roy4222/fju-web:oldtag
  compose pull app worker migrate
  image inspect --format {{if .RepoDigests}}{{index .RepoDigests 0}}{{end}} ghcr.io/roy4222/fju-web:newtag
  compose run --rm migrate
  compose up -d app worker

deploy_log：不存在
stderr 最後一行：worker 起不來
```

腳本被 `set -e` 直接帶走：沒有回滾、沒有任何部署紀錄，而現場可能已經是「app 換成新版、worker 還是舊的」的半套狀態。

## 修正後

```
exit=1

呼叫紀錄：
  compose ps --format {{.Image}} app
  image inspect --format {{if .RepoDigests}}{{index .RepoDigests 0}}{{end}} ghcr.io/roy4222/fju-web:oldtag
  compose pull app worker migrate
  image inspect --format {{if .RepoDigests}}{{index .RepoDigests 0}}{{end}} ghcr.io/roy4222/fju-web:newtag
  compose run --rm migrate
  compose up -d postgres
  compose up -d --no-deps app worker
  compose up -d --no-deps app worker

deploy_log：
  2026-09-15T09:34:26Z	rollback-start	newtag	start-failed
  2026-09-15T09:34:26Z	rollback-done	ghcr.io/roy4222/fju-web:oldtag	healthy	start-failed

stderr：
  worker 起不來
  部署失敗（start-failed），回滾到 /private/tmp/claude-501/-Users-lubaiyu-fju-project--claude-worktrees-ssh-connection-4ed37a/d70a4214-1ae5-4e86-b7ed-4a479588a173/scratchpad/repro/deploy-new/previous_tag 記的版本。
  已回滾到 ghcr.io/roy4222/fju-web:oldtag 且健康判定通過。
```

差別：

1. `up` 失敗被 `if !` 攔下來，走與健康失敗**同一條**補償流程（R4）。
2. 回滾把 `APP_IMAGE` 換回 `previous_tag` 記的舊映像再啟動，並重跑健康判定，通過才記 `healthy`。
3. 兩次 `up` 都帶 `--no-deps`，整個流程只在第 4 步執行過一次 migrator——舊映像的 migrator 不會被 compose 依賴帶起來把 `schema_meta` 寫回舊版本（R5）。
4. 多了一次 `compose up -d postgres`：因為 app／worker 改用 `--no-deps`，要自己確保資料庫在跑。

## 自動化

同一套假命令做成 `web/test/ops/deploy-execute.integration.test.ts`（11 項），涵蓋：

- 順利部署：七步走完、`deploy_log` 記 `deployed`、`up` 一律帶 `--no-deps`
- `up` 失敗 → 補償流程、換回舊映像、`deploy_log` 記 `start-failed` 與 `rollback-done`
- 沒有前一版可回滾 → 記 `rollback-skipped no-previous` 並明講需要人介入
- `postgres` 起不來 → 同一條補償流程
- 健康失敗 → 回滾、重跑健康判定、schema 維持新的
- 整個回滾過程沒有再執行過 migrator，任何 `up` 都不含 migrate
- migrate 失敗或 pull 失敗 → 直接中止，完全不動 app
