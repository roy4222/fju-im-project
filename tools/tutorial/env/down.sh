#!/usr/bin/env bash
# 停掉 up.sh 起的 app 與 worker。只停 $RUN_DIR 裡 pid 檔記的那兩組程序，不按名稱比對（別的票也在這台跑 worker）。
# 資料庫、上傳檔案、帳號密碼都留著；下次 up.sh --no-build 直接接著用。
#
#   tools/tutorial/env/down.sh
set -euo pipefail
source "$(dirname "$0")/lib.sh"

stop_pid_file "$WORKER_PID_FILE" worker
stop_pid_file "$APP_PID_FILE" app
