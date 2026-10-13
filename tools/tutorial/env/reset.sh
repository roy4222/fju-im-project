#!/usr/bin/env bash
# 把教學環境重置成乾淨的示範資料：刪掉 fju_tutorial 重建 → migration → seed-demo → 教學帳號。
# 錄完一段、要錄下一段之前跑。上傳過的檔案（$FILES_ROOT）也清掉，seed-demo 會把示範封面與附件放回去。
#
#   tools/tutorial/env/reset.sh
#
# app 與 worker 原本在跑的話先停、資料好了再起（next start 一秒內就緒）：刪庫會強制切斷它們的連線，
# 不停的話 app 會印 uncaughtException、worker 可能在中途讀到半套資料。
# 重置後所有人的登入都失效（session 在資料庫裡），錄影瀏覽器要重新登入。
set -euo pipefail
source "$(dirname "$0")/lib.sh"

started=$SECONDS
load_env
ensure_postgres

was_running=0
if pid_alive "$APP_PID_FILE" || pid_alive "$WORKER_PID_FILE"; then
  was_running=1
  stop_pid_file "$WORKER_PID_FILE" worker
  stop_pid_file "$APP_PID_FILE" app
fi

log "重建資料庫 $DB_NAME"
drop_db
create_db
log "清空上傳檔案目錄 $FILES_DIR"
[[ -n "$FILES_DIR" && "$FILES_DIR" != "/" && "$FILES_DIR" != "$HOME" ]] || die "FILES_DIR=$FILES_DIR 不像教學專用目錄，不清"
rm -rf "$FILES_DIR"
mkdir -p "$FILES_DIR"
prepare_data

if [[ $was_running == 1 ]]; then
  start_app
  start_worker
  wait_healthy
else
  log "app 原本沒在跑（要起來用 up.sh --no-build）"
fi

log "重置完成，用時 $((SECONDS - started)) 秒"
