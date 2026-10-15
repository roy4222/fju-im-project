#!/usr/bin/env bash
# 在本機起教學影片用的網站（next start + 背景 worker）。INSTANCE=0～4 各自獨立（沒設＝0）：
#   實例 n → http://localhost:<3300+n>、資料庫 fju_tutorial（0）或 fju_tutorial_<n>。
#
#   [INSTANCE=n] tools/tutorial/env/up.sh              不建置：沿用既有建置（沒有就零副作用退出）→ 資料庫（沒有就建）
#                                                      → migration → seed-demo → 教學帳號 → 起 app 與 worker
#   [INSTANCE=n] tools/tutorial/env/up.sh --build      先建置再起（第一次用、或建置壞了）；0～4 全部 down 了才可以
#   tools/tutorial/env/up.sh --update                  網站 checkout 換到最新 origin/main 並重建；0～4 全部 down 了才可以（錄影期間不要用）
#   [INSTANCE=n] tools/tutorial/env/up.sh --dry-run    只驗目標、印出這個實例的設定（資料庫、port、目錄、網站版本），什麼都不動
#   --no-build                                         跟預設一樣（留著是為了習慣）
#
# 網站跑的是 ~/work/tutorial-site（origin/main 的固定 checkout），第一次 up.sh --build 時建；用的 commit 印出來並寫進
# ~/work/tutorial-out/env-commit.txt。
#
# 建置產物（web/.next、web/dist）各實例共用；建置與換版本只在持鎖、而且沒有任何實例在跑時做，錄影期間不會有人改寫 .next。
# 資料庫已經在就沿用（seed-demo、accounts 都是冪等的）；要回到乾淨狀態用 reset.sh。
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"

BUILD=skip
SITE=keep
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=skip ;;
    --build) BUILD=force ;;
    --update) SITE=update; BUILD=force ;;
    --dry-run) DRY_RUN=1 ;;
    *) die "不認得的參數：${arg}（用法：up.sh [--build|--update|--dry-run]）" ;;
  esac
done

started=$SECONDS
safety_check
if [[ "$DRY_RUN" == 1 ]]; then
  log "（dry-run）實例 ${INSTANCE}：網站 ${BASE_URL}、資料庫 ${DB_NAME}、檔案 ${FILES_DIR}、pid／log ${RUN_DIR}"
  log "（dry-run）網站 checkout ${SITE_DIR}：$(describe_site)"
  log "（dry-run）建置模式 ${BUILD}、checkout 模式 ${SITE}；Docker ${DOCKER_ENDPOINT}"
  exit 0
fi
# 共用鎖：從這裡到 app／worker 登記好 pid 為止（checkout 更新、安裝、建置、起程序）都在鎖裡，
# 別人這段時間不能起實例、重建或換版本；逾時（預設 15 分鐘）就退出、不動任何東西。
lock_acquire "up.sh 實例 ${INSTANCE}（build=${BUILD} site=${SITE}）"
if [[ "$BUILD" == skip ]]; then
  # 預設：只沿用既有建置。不齊（第一次用、上次建置沒完成、換版本後）就在任何副作用之前退出。
  require_built
  log "沿用既有建置：$(describe_site)"
else
  # --build／--update：持鎖後確認 0～4 全部沒在跑，才動 checkout 與共用的建置產物。
  ensure_idle
  ensure_site "$SITE"
  ensure_build
fi
load_env
ensure_postgres

if db_exists; then
  log "資料庫 $DB_NAME 已存在，沿用"
else
  log "建資料庫 $DB_NAME"
  create_db
fi
prepare_data

start_app
start_worker
lock_release
wait_healthy

log "完成，用時 $((SECONDS - started)) 秒。帳號對照："
node "$ENV_DIR/accounts.mjs" list
