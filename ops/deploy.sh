#!/usr/bin/env bash
# 部署腳本（契約 05 §3）。S00 只做 dry-run：預設就是 --dry-run，要真的跑必須明確帶 --execute。
#
#   ops/deploy.sh <tag> [--execute] [--expect-worker]
#
# 步驟（契約 05 §3）：
#   1. flock 部署鎖，拿不到就失敗（不排隊）
#   2. 記下目前版本到 .deploy/previous_tag（含 digest），失敗時回滾用
#   3. docker compose pull app worker migrate
#   4. docker compose run --rm migrate  ← 新映像；失敗即中止，舊 app 繼續跑
#   5. docker compose up -d app worker
#   6. 健康判定
#   7. 寫 deploy_log
#
# 健康判定分階段（契約 05 §3，v2.4／E-19）：
#   - 不帶 --expect-worker（E02 出場前）：只判 /api/health 200、commit、imageDigest、
#     schemaVersion 四項，而且 worker 欄必須是 null；deploy_log 記「有限健康條件」。
#   - 帶 --expect-worker（E02 出場後）：再加 worker.version 與 worker.lastTickAt 在 60 秒內，共六項。
#   旗標與階段不符即失敗。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_DIR="${DEPLOY_DIR:-$REPO_ROOT/.deploy}"
LOCK_FILE="$DEPLOY_DIR/deploy.lock"
PREVIOUS_TAG_FILE="$DEPLOY_DIR/previous_tag"
DEPLOY_LOG="$DEPLOY_DIR/deploy_log"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8080/api/health}"
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-60}"
COMPOSE="${COMPOSE:-docker compose}"

TAG=""
DRY_RUN=1
EXPECT_WORKER=0

usage() {
  sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
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

log() { printf '%s\n' "$*"; }
step() { printf '[%s] %s\n' "$([ "$DRY_RUN" = 1 ] && echo 'dry-run' || echo 'execute')" "$*"; }

# dry-run 時只印出會跑什麼，不真的執行。
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '        $ %s\n' "$*"
  else
    "$@"
  fi
}

log "部署 tag：$TAG"
log "健康檢查端點：$HEALTH_URL（逾時 ${HEALTH_TIMEOUT_SECONDS}s）"
if [ "$EXPECT_WORKER" = 1 ]; then
  log "健康條件：完整六項（含 worker.version 與 worker.lastTickAt）"
else
  log "健康條件：有限四項（commit、imageDigest、schemaVersion、HTTP 200）；worker 欄必須是 null"
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
step "2/7 記下目前版本到 $PREVIOUS_TAG_FILE（含 digest）"
if [ "$DRY_RUN" = 1 ]; then
  printf '        $ %s images app --format json > %s\n' "$COMPOSE" "$PREVIOUS_TAG_FILE"
else
  $COMPOSE images app --format json > "$PREVIOUS_TAG_FILE"
fi

# ── 3. 拉新映像 ────────────────────────────────────────────
step '3/7 拉新映像'
run $COMPOSE pull app worker migrate

# ── 4. 先跑 migration ──────────────────────────────────────
step '4/7 用新映像跑 migration（失敗即中止，舊 app 繼續跑）'
run $COMPOSE run --rm migrate

# ── 5. 換上新版 ────────────────────────────────────────────
step '5/7 啟動新版 app 與 worker'
run $COMPOSE up -d app worker

# ── 6. 健康判定 ────────────────────────────────────────────
step "6/7 健康判定（${HEALTH_TIMEOUT_SECONDS} 秒內要全部符合）"
if [ "$DRY_RUN" = 1 ]; then
  printf '        $ curl -sf %s  # 比對 commit／imageDigest／schemaVersion%s\n' \
    "$HEALTH_URL" "$([ "$EXPECT_WORKER" = 1 ] && echo '／worker.version／worker.lastTickAt' || echo '，且 worker 必須是 null')"
else
  deadline=$(( $(date +%s) + HEALTH_TIMEOUT_SECONDS ))
  healthy=0
  while [ "$(date +%s)" -lt "$deadline" ]; do
    body="$(curl -sf --max-time 5 "$HEALTH_URL" || true)"
    if [ -n "$body" ] && HEALTH_JSON="$body" EXPECT_TAG="$TAG" EXPECT_WORKER="$EXPECT_WORKER" \
      node "$REPO_ROOT/ops/check-health.mjs"; then
      healthy=1
      break
    fi
    sleep 2
  done
  if [ "$healthy" != 1 ]; then
    echo "健康判定失敗，回滾到 $PREVIOUS_TAG_FILE 記的版本。" >&2
    printf '%s\trollback-start\t%s\n' "$(date -u +%FT%TZ)" "$TAG" >> "$DEPLOY_LOG"
    $COMPOSE up -d app worker || true
    printf '%s\trollback-done\t%s\n' "$(date -u +%FT%TZ)" "$TAG" >> "$DEPLOY_LOG"
    exit 1
  fi
fi

# ── 7. 記錄 ────────────────────────────────────────────────
step "7/7 寫 deploy_log（$DEPLOY_LOG）"
condition="$([ "$EXPECT_WORKER" = 1 ] && echo 'full' || echo 'limited-no-worker')"
if [ "$DRY_RUN" = 1 ]; then
  printf '        $ echo "<時間>\tdeployed\t%s\t%s" >> %s\n' "$TAG" "$condition" "$DEPLOY_LOG"
else
  printf '%s\tdeployed\t%s\t%s\n' "$(date -u +%FT%TZ)" "$TAG" "$condition" >> "$DEPLOY_LOG"
fi

log ""
if [ "$DRY_RUN" = 1 ]; then
  log "這是演練，什麼都沒有執行。要真的部署請加 --execute（S14 才在 VM 上跑）。"
else
  log "部署完成：$TAG（健康條件：$condition）"
fi
