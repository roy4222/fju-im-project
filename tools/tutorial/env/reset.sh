#!/usr/bin/env bash
# 把教學環境重置成乾淨的示範資料：刪掉這個實例的資料庫（fju_tutorial 或 fju_tutorial_<n>）重建 → migration → seed-demo → 教學帳號。
# 錄完一段、要錄下一段之前跑。上傳過的檔案（${FILES_ROOT}）也清掉，seed-demo 會把示範封面與附件放回去。
#
#   [INSTANCE=n] tools/tutorial/env/reset.sh     只重置實例 n（沒設＝0），別的實例不受影響
#
# app 與 worker 原本在跑的話先停、資料好了再起（next start 一秒內就緒）：刪庫會強制切斷它們的連線，
# 不停的話 app 會印 uncaughtException、worker 可能在中途讀到半套資料。
# 重置後所有人的登入都失效（session 在資料庫裡），錄影瀏覽器要重新登入。
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"

started=$SECONDS
# 先把所有檢查做完（資料庫名、連線、FILES_ROOT 與它的邊界、Docker、網站 checkout 與建置產物），任何一項不過就在停程序、刪庫、刪檔之前退出。
safety_check
require_built
# 共用鎖：「停→重灌→再起」整段都在鎖裡，別人這段時間不能重建或換版本（重建前「有沒有實例在跑」的檢查，才不會因為我們正好停著而失準）。
lock_acquire "reset.sh 實例 ${INSTANCE}"
# 等鎖期間別人可能換了版本或把建置弄壞：拿到鎖之後、動手之前再檢查一次，不過就放鎖（EXIT trap）、零副作用退出。
safety_check
require_built
load_env
ensure_postgres

was_running=0
if proc_ours app "$APP_PID_FILE" || proc_ours worker "$WORKER_PID_FILE"; then
  was_running=1
  stop_proc worker "$WORKER_PID_FILE"
  stop_proc app "$APP_PID_FILE"
fi

log "重建資料庫 ${DB_NAME}"
drop_db
create_db
log "清空上傳檔案目錄 ${FILES_DIR}"
# safety_check 已驗過 FILES_DIR（正規化、邊界沒有符號連結）；rm -rf 之前再擋一次最壞的情況。
assert_files_dir
rm -rf "$FILES_DIR"
mkdir -p "$FILES_DIR"
prepare_data
"$ENV_DIR/clock-reset.sh"

if [[ $was_running == 1 ]]; then
  start_app
  start_worker
  lock_release
  wait_healthy
else
  lock_release
  log "app 原本沒在跑（要起來用 up.sh --no-build）"
fi

log "重置完成，用時 $((SECONDS - started)) 秒"
