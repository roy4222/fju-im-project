#!/usr/bin/env bash
# 在本機起教學影片用的網站（next start + 背景 worker）。INSTANCE=0～4 各自獨立（沒設＝0）：
#   實例 n → http://localhost:<3300+n>、資料庫 fju_tutorial（0）或 fju_tutorial_<n>。
#
#   [INSTANCE=n] tools/tutorial/env/up.sh              建置（沒有、或 web/ 有變才建）→ 資料庫（沒有就建）
#                                                      → migration → seed-demo → 教學帳號 → 起 app 與 worker
#   [INSTANCE=n] tools/tutorial/env/up.sh --no-build   沿用既有建置
#   [INSTANCE=n] tools/tutorial/env/up.sh --build      一定重建（所有實例都 down 了才可以）
#
# 建置產物（web/.next、web/dist）各實例共用；有實例在跑時不會重建。
# 資料庫已經在就沿用（seed-demo、accounts 都是冪等的）；要回到乾淨狀態用 reset.sh。
set -euo pipefail
source "$(dirname "$0")/lib.sh"

BUILD=auto
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=skip ;;
    --build) BUILD=force ;;
    *) die "不認得的參數：$arg（用法：up.sh [--no-build|--build]）" ;;
  esac
done

started=$SECONDS
safety_check
load_env
ensure_postgres

[[ -d "$WEB_DIR/node_modules" ]] || (cd "$REPO_ROOT" && pnpm install --frozen-lockfile --filter @fju/web...)

ensure_build "$BUILD"

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
