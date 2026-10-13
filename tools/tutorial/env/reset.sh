#!/usr/bin/env bash
# 把教學環境重置成乾淨的示範資料：刪掉這個實例的資料庫（fju_tutorial 或 fju_tutorial_<n>）重建 → migration → seed-demo → 教學帳號。
# 錄完一段、要錄下一段之前跑。上傳過的檔案（$FILES_ROOT）也清掉，seed-demo 會把示範封面與附件放回去。
#
#   [INSTANCE=n] tools/tutorial/env/reset.sh     只重置實例 n（沒設＝0），別的實例不受影響
#
# app 與 worker 原本在跑的話先停、資料好了再起（next start 一秒內就緒）：刪庫會強制切斷它們的連線，
# 不停的話 app 會印 uncaughtException、worker 可能在中途讀到半套資料。
# 重置後所有人的登入都失效（session 在資料庫裡），錄影瀏覽器要重新登入。
set -euo pipefail
source "$(dirname "$0")/lib.sh"

started=$SECONDS
# 先驗目標（資料庫、FILES_ROOT、Docker），不對就在停程序、刪庫之前停下。
safety_check
load_env
require_site
ensure_postgres

was_running=0
if proc_ours app "$APP_PID_FILE" || proc_ours worker "$WORKER_PID_FILE"; then
  was_running=1
  stop_proc worker "$WORKER_PID_FILE"
  stop_proc app "$APP_PID_FILE"
fi

log "重建資料庫 $DB_NAME"
drop_db
create_db
log "清空上傳檔案目錄 $FILES_DIR"
# FILES_DIR 已由 safety_check 正規化並確認在 ~/work/tutorial-files 底下；這裡再擋一次最壞的情況。
files_root="$(cd "$HOME" && pwd -P)/work/tutorial-files/$INSTANCE"
[[ "$FILES_DIR" == "$files_root" || "$FILES_DIR" == "$files_root"/* ]] || die "FILES_DIR=$FILES_DIR 不是教學專用目錄，不清"
rm -rf "$FILES_DIR"
mkdir -p "$FILES_DIR"
prepare_data
"$ENV_DIR/clock-reset.sh"

if [[ $was_running == 1 ]]; then
  start_app
  start_worker
  wait_healthy
else
  log "app 原本沒在跑（要起來用 up.sh --no-build）"
fi

log "重置完成，用時 $((SECONDS - started)) 秒"
