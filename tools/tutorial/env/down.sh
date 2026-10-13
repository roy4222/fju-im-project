#!/usr/bin/env bash
# 停掉 up.sh 起的 app 與 worker。只停 $RUN_DIR 裡 pid 檔記的那兩組程序，不按名稱比對（別的票也在這台跑 worker）；
# 啟動時間、工作目錄、種類、PGID 對不上（pid 被重用、pid 檔殘留）就只清 pid 檔、不送訊號。
# 資料庫、上傳檔案、帳號密碼都留著；下次 up.sh --no-build 直接接著用。
#
#   [INSTANCE=n] tools/tutorial/env/down.sh     只停實例 n（沒設＝0）
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"

stop_proc worker "$WORKER_PID_FILE"
stop_proc app "$APP_PID_FILE"
