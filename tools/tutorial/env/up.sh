#!/usr/bin/env bash
# 在本機起教學影片用的網站：http://localhost:3300（next build + next start + 背景 worker），資料庫 fju_tutorial。
#
#   tools/tutorial/env/up.sh              建置 → 資料庫（沒有就建）→ migration → seed-demo → 教學帳號 → 起 app 與 worker
#   tools/tutorial/env/up.sh --no-build   跳過 next build（web/.next 已是這個版本時用，省 1～2 分鐘）
#
# 資料庫已經在就沿用（seed-demo、accounts 都是冪等的）；要回到乾淨狀態用 reset.sh。
set -euo pipefail
source "$(dirname "$0")/lib.sh"

BUILD=1
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    *) die "不認得的參數：$arg（用法：up.sh [--no-build]）" ;;
  esac
done

started=$SECONDS
load_env
ensure_postgres

[[ -d "$WEB_DIR/node_modules" ]] || (cd "$REPO_ROOT" && pnpm install --frozen-lockfile --filter @fju/web...)

if [[ $BUILD == 1 || ! -f "$WEB_DIR/.next/BUILD_ID" || ! -f "$WEB_DIR/dist/worker.mjs" ]]; then
  log "建置（pnpm -C web build）"
  (cd "$REPO_ROOT" && pnpm -C web build >"$RUN_DIR/build.log" 2>&1) || die "建置失敗，看 $RUN_DIR/build.log"
fi

if db_exists; then
  log "資料庫 $DB_NAME 已存在，沿用"
else
  log "建資料庫 $DB_NAME"
  create_db
fi
prepare_data

start_app
start_worker
wait_healthy

log "完成，用時 $((SECONDS - started)) 秒。帳號對照："
node "$ENV_DIR/accounts.mjs" list
