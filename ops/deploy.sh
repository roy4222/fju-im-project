#!/usr/bin/env bash
# 部署腳本（契約 05 §3）。S00 只做 dry-run：預設就是 --dry-run，要真的跑必須明確帶 --execute。
#
#   ops/deploy.sh <tag> [--execute] [--expect-worker]
#
# 步驟（契約 05 §3）：
#   1. flock 部署鎖，拿不到就失敗（不排隊）
#   2. 記下目前版本到 .deploy/previous_tag（映像參照＋digest），失敗時回滾用
#   3. docker compose pull app worker migrate（用 <tag> 組出的 APP_IMAGE）
#   4. docker compose run --rm migrate  ← 新映像；失敗即中止，舊 app 繼續跑
#   5. docker compose up -d app worker
#   6. 健康判定
#   7. 寫 deploy_log
#
# 健康判定分階段（契約 05 §3，v2.4／E-19）：
#   - 不帶 --expect-worker（E02 出場前）：判 /api/health 200、commit、imageDigest、
#     schemaVersion 四項，而且 worker 欄必須是 null；deploy_log 記「有限健康條件」。
#   - 帶 --expect-worker（E02 出場後）：再加 worker.version 與 worker.lastTickAt 在 60 秒內，共六項。
#   旗標與階段不符即失敗。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_DIR="${DEPLOY_DIR:-$REPO_ROOT/.deploy}"
LOCK_FILE="$DEPLOY_DIR/deploy.lock"
PREVIOUS_FILE="$DEPLOY_DIR/previous_tag"
DEPLOY_LOG="$DEPLOY_DIR/deploy_log"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8080/api/health}"
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-60}"
IMAGE_REPO="${IMAGE_REPO:-ghcr.io/roy4222/fju-web}"
COMPOSE="${COMPOSE:-docker compose}"

TAG=""
DRY_RUN=1
EXPECT_WORKER=0

usage() {
  sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --execute) DRY_RUN=0 ;;
    --dry-run) DRY_RUN=1 ;;
    --expect-worker) EXPECT_WORKER=1 ;;
    -h|--help) usage 0 ;;
    -*) echo "不認得的選項：$1" >&2; usage 1 ;;
    *)
      if [ -n "$TAG" ]; then echo "只能給一個 tag（已經有 $TAG）" >&2; exit 1; fi
      TAG="$1"
      ;;
  esac
  shift
done

if [ -z "$TAG" ]; then
  echo "缺少 tag。用法：ops/deploy.sh <tag> [--execute] [--expect-worker]" >&2
  exit 1
fi

mkdir -p "$DEPLOY_DIR"

# 這一次要部署的映像。Compose 的 app、worker、migrate 都吃這個變數，
# 所以 <tag> 真的會決定跑起來的是哪一版——不是只拿去比對健康狀態。
APP_IMAGE="$IMAGE_REPO:$TAG"
export APP_IMAGE

log() { printf '%s\n' "$*"; }
step() { printf '[%s] %s\n' "$([ "$DRY_RUN" = 1 ] && echo 'dry-run' || echo 'execute')" "$*"; }
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '        $ %s\n' "$*"
  else
    "$@"
  fi
}

# 從本機映像讀出 registry digest。/api/health 的 imageDigest 是執行期由環境變數帶進容器的
# （digest 要 push 之後才知道，沒辦法在 build 時烤進映像）。
image_digest() {
  docker image inspect --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}' "$1" 2>/dev/null || true
}

log "部署 tag：$TAG"
log "映像：$APP_IMAGE"
log "健康檢查端點：$HEALTH_URL（逾時 ${HEALTH_TIMEOUT_SECONDS}s）"
if [ "$EXPECT_WORKER" = 1 ]; then
  log "健康條件：完整六項（含 worker.version 與 worker.lastTickAt）"
else
  log "健康條件：有限四項（HTTP 200、commit、imageDigest、schemaVersion）；worker 欄必須是 null"
fi
log ""

# ── 1. 部署鎖 ──────────────────────────────────────────────
step '1/7 取得部署鎖（flock，拿不到就失敗，不排隊）'
if [ "$DRY_RUN" = 1 ]; then
  printf '        $ flock --nonblock %s -c "<以下步驟>"\n' "$LOCK_FILE"
else
  exec 9>"$LOCK_FILE"
  if ! flock --nonblock 9; then
    echo "拿不到部署鎖 $LOCK_FILE，可能有另一次部署正在跑。" >&2
    exit 1
  fi
fi

# ── 2. 記下目前版本 ────────────────────────────────────────
step "2/7 記下目前版本到 $PREVIOUS_FILE（映像參照＋digest）"
if [ "$DRY_RUN" = 1 ]; then
  printf '        $ 讀目前 app 容器的映像與 digest，寫成 PREVIOUS_APP_IMAGE／PREVIOUS_IMAGE_DIGEST\n'
else
  previous_image="$($COMPOSE ps --format '{{.Image}}' app 2>/dev/null | head -1)"
  if [ -n "$previous_image" ]; then
    {
      printf 'PREVIOUS_APP_IMAGE=%s\n' "$previous_image"
      printf 'PREVIOUS_IMAGE_DIGEST=%s\n' "$(image_digest "$previous_image")"
    } > "$PREVIOUS_FILE"
    log "        目前版本：$previous_image"
  else
    # 第一次部署，沒有前一版可以回滾。
    : > "$PREVIOUS_FILE"
    log "        目前沒有在跑的 app，這是第一次部署（失敗時沒有可回滾的版本）"
  fi
fi

# ── 3. 拉新映像 ────────────────────────────────────────────
step '3/7 拉新映像'
run $COMPOSE pull app worker migrate

NEW_DIGEST=""
if [ "$DRY_RUN" = 0 ]; then
  NEW_DIGEST="$(image_digest "$APP_IMAGE")"
  log "        digest：${NEW_DIGEST:-（本機建的映像沒有 registry digest）}"
fi
# app 與 worker 靠這個環境變數回報 imageDigest（契約 05 §1）。
export IMAGE_DIGEST="$NEW_DIGEST"

# ── 4. 先跑 migration ──────────────────────────────────────
step '4/7 用新映像跑 migration（失敗即中止，舊 app 繼續跑）'
NEW_SCHEMA=""
if [ "$DRY_RUN" = 1 ]; then
  printf '        $ %s run --rm migrate  # 從輸出取最後一支 migration 名稱\n' "$COMPOSE"
else
  migrate_output="$($COMPOSE run --rm migrate)"
  printf '%s\n' "$migrate_output"
  # migrate.mjs 會印一行 `SCHEMA_VERSION=<最後一支 migration>`，健康判定用它比對。
  NEW_SCHEMA="$(printf '%s\n' "$migrate_output" | sed -n 's/^SCHEMA_VERSION=//p' | tail -1)"
  if [ -z "$NEW_SCHEMA" ]; then
    echo "migrate 沒有輸出 SCHEMA_VERSION，無法比對 schemaVersion，中止。" >&2
    exit 1
  fi
  log "        schema：$NEW_SCHEMA"
fi

# ── 5. 換上新版 ────────────────────────────────────────────
step '5/7 啟動新版 app 與 worker'
run $COMPOSE up -d app worker

# ── 6. 健康判定 ────────────────────────────────────────────
step "6/7 健康判定（${HEALTH_TIMEOUT_SECONDS} 秒內要全部符合）"

# 跑一輪健康判定；符合回 0。呼叫時帶要比對的期望值。
await_health() {
  local expect_tag="$1" expect_digest="$2" expect_schema="$3" expect_worker="$4"
  local deadline body
  deadline=$(( $(date +%s) + HEALTH_TIMEOUT_SECONDS ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    body="$(curl -sf --max-time 5 "$HEALTH_URL" || true)"
    if [ -n "$body" ] && HEALTH_JSON="$body" \
      EXPECT_TAG="$expect_tag" EXPECT_DIGEST="$expect_digest" \
      EXPECT_SCHEMA="$expect_schema" EXPECT_WORKER="$expect_worker" \
      node "$REPO_ROOT/ops/check-health.mjs"; then
      return 0
    fi
    sleep 2
  done
  return 1
}

if [ "$DRY_RUN" = 1 ]; then
  printf '        $ curl -sf %s\n' "$HEALTH_URL"
  printf '        $ node ops/check-health.mjs  # 比對 commit=<tag>、imageDigest=<pull 到的 digest>、schemaVersion=<migrate 輸出>%s\n' \
    "$([ "$EXPECT_WORKER" = 1 ] && echo '、worker.version、worker.lastTickAt' || echo '，且 worker 必須是 null')"
else
  if ! await_health "$TAG" "$NEW_DIGEST" "$NEW_SCHEMA" "$EXPECT_WORKER"; then
    echo "健康判定失敗，回滾到 $PREVIOUS_FILE 記的版本。" >&2
    printf '%s\trollback-start\t%s\n' "$(date -u +%FT%TZ)" "$TAG" >> "$DEPLOY_LOG"

    if [ -s "$PREVIOUS_FILE" ]; then
      # shellcheck disable=SC1090
      . "$PREVIOUS_FILE"
      APP_IMAGE="$PREVIOUS_APP_IMAGE"
      IMAGE_DIGEST="$PREVIOUS_IMAGE_DIGEST"
      export APP_IMAGE IMAGE_DIGEST
      log "回滾到 $APP_IMAGE"
      $COMPOSE up -d app worker || true
      # DB 不回滾（expand／contract），所以 schema 仍是新的；舊映像要能在新 schema 上跑。
      if await_health "" "$PREVIOUS_IMAGE_DIGEST" "$NEW_SCHEMA" "$EXPECT_WORKER"; then
        printf '%s\trollback-done\t%s\thealthy\n' "$(date -u +%FT%TZ)" "$APP_IMAGE" >> "$DEPLOY_LOG"
        echo "已回滾到 $APP_IMAGE 且健康判定通過。" >&2
      else
        printf '%s\trollback-done\t%s\tunhealthy\n' "$(date -u +%FT%TZ)" "$APP_IMAGE" >> "$DEPLOY_LOG"
        echo "回滾後健康判定仍不通過——需要人介入。" >&2
      fi
    else
      printf '%s\trollback-skipped\tno-previous\n' "$(date -u +%FT%TZ)" >> "$DEPLOY_LOG"
      echo "沒有可回滾的版本（第一次部署）。" >&2
    fi
    exit 1
  fi
fi

# ── 7. 記錄 ────────────────────────────────────────────────
step "7/7 寫 deploy_log（$DEPLOY_LOG）"
condition="$([ "$EXPECT_WORKER" = 1 ] && echo 'full' || echo 'limited-no-worker')"
if [ "$DRY_RUN" = 1 ]; then
  printf '        $ echo "<時間>\tdeployed\t%s\t%s" >> %s\n' "$TAG" "$condition" "$DEPLOY_LOG"
else
  printf '%s\tdeployed\t%s\t%s\t%s\t%s\n' \
    "$(date -u +%FT%TZ)" "$TAG" "$condition" "${NEW_DIGEST:-none}" "$NEW_SCHEMA" >> "$DEPLOY_LOG"
fi

log ""
if [ "$DRY_RUN" = 1 ]; then
  log "這是演練，什麼都沒有執行。要真的部署請加 --execute（S14 才在 VM 上跑）。"
else
  log "部署完成：$TAG（健康條件：$condition）"
fi
