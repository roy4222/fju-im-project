#!/usr/bin/env bash
# 開發者後台：拉新映像、起服務、補建 PgHero 的監控角色（設計方案 §3.6；S-4）。
#
#   ops/status-up.sh [--dry-run]                         補建 fju_monitor、pull＋up -d、再補建一次
#   ops/status-up.sh --ensure-db-role-only [--dry-run]   只補建 fju_monitor
#
#   --dry-run   只印要做的事，不碰 docker
#
# 在 VM 上用 deploy 身分跑：fju-status-update.timer 每輪結束後 8 分鐘再跑（ops/status/systemd/，
# 確保測試站重置後 10 分鐘內補回角色）；
# 安裝腳本 ops/status-install.sh 第 5、9 步也呼叫它。
#
# 為什麼每輪都補建角色：fju-test-reset reset 會刪掉整個測試站資料庫 volume，fju_monitor 跟著消失。
# 做法照 ops/deploy.sh 的 sync_app_db_password：SQL 從 stdin 餵給 fju-test-postgres 容器裡的 psql，
# `sh -c '…'` 整段單引號，POSTGRES_USER／POSTGRES_DB 在容器裡展開（容器本來就有）；
# 這支腳本不經主網站的秘密流程、也不碰那些秘密的值。密碼從 secrets/pghero.env 的
# FJU_MONITOR_PASSWORD 讀，不出現在任何指令列、也不印出來。
# 測試站 postgres 不在（重置中）就印「跳過」、結束碼 0，下一輪再補。
set -euo pipefail

APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${APP_ROOT}/docker-compose.status.yml"
SECRETS_DIR="${FJU_STATUS_SECRETS:-/srv/fju/status/secrets}"
PG_CONTAINER="fju-test-postgres"
ROLE="fju_monitor"
# 單引號是刻意的：POSTGRES_USER 與 POSTGRES_DB 要在 postgres 容器裡展開，外層 shell 不能碰。
# shellcheck disable=SC2016
PSQL_IN_CONTAINER='psql -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
# shellcheck disable=SC2016
PSQL_QUERY_IN_CONTAINER='psql -q -tA -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'

DRY_RUN=0
ROLE_ONLY=0

usage() {
  sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --ensure-db-role-only) ROLE_ONLY=1 ;;
    -h | --help) usage 0 ;;
    *)
      printf '不認得的參數：%s\n' "$1" >&2
      usage 2 >&2
      ;;
  esac
  shift
done

# `sudo -u deploy` 會沿用呼叫者的目錄，先換到自己的目錄。
cd "$APP_ROOT"

log() { printf '%s\n' "$*"; }
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '  $ %s\n' "$*"
  else
    "$@"
  fi
}

# pghero.env 的 FJU_MONITOR_PASSWORD（只取值，不 source 整個檔）。
read_monitor_password() {
  local file="${SECRETS_DIR}/pghero.env"
  [ -r "$file" ] || return 1
  sed -n 's/^FJU_MONITOR_PASSWORD=//p' "$file" | head -n 1
}

monitor_sql() {
  local pw="$1"
  # 單引號雙寫（同 ops/deploy.sh）。
  local q="'"
  local escaped="${pw//$q/$q$q}"
  cat <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fju_monitor') THEN
    CREATE ROLE fju_monitor;
  END IF;
END
$$;
SQL
  printf "ALTER ROLE fju_monitor LOGIN PASSWORD '%s';\n" "$escaped"
  cat <<'SQL'
GRANT pg_monitor TO fju_monitor;
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO fju_monitor', current_database());
END
$$;
SQL
}

ensure_db_role() {
  log "補建 PgHero 監控角色 ${ROLE}（測試站）"
  if [ "$DRY_RUN" = 1 ]; then
    log "  （dry-run：不檢查 ${PG_CONTAINER} 在不在、不讀密碼）"
    printf "  \$ docker exec -i %s sh -c '%s'   # SQL 從 stdin 餵：\n" "$PG_CONTAINER" "$PSQL_IN_CONTAINER"
    monitor_sql '********' | sed 's/^/      /'
    return 0
  fi

  if [ "$(docker inspect -f '{{.State.Running}}' "$PG_CONTAINER" 2>/dev/null || true)" != true ]; then
    log "  跳過：測試站 postgres 不在（${PG_CONTAINER} 沒在跑，可能正在重置），下一輪再補"
    return 0
  fi

  local pw
  if ! pw="$(read_monitor_password)" || [ -z "$pw" ]; then
    log "  ✗ ${SECRETS_DIR}/pghero.env 沒有 FJU_MONITOR_PASSWORD（安裝腳本第 5 步會產生）" >&2
    return 1
  fi

  local exists
  if ! exists="$(printf "SELECT 1 FROM pg_roles WHERE rolname = '%s';\n" "$ROLE" \
    | docker exec -i "$PG_CONTAINER" sh -c "$PSQL_QUERY_IN_CONTAINER" 2>/dev/null)"; then
    # 容器在跑但資料庫還沒接受連線（重置剛起來）：當成還沒好，下一輪再補。
    log "  跳過：測試站 postgres 還沒準備好（連不上），下一輪再補"
    return 0
  fi
  if [ "$exists" = 1 ]; then
    log "  ${ROLE} 已在，同步密碼與權限"
  else
    log "  補建 ${ROLE}（測試站重置過或第一次安裝）"
  fi
  monitor_sql "$pw" | docker exec -i "$PG_CONTAINER" sh -c "$PSQL_IN_CONTAINER" >/dev/null
  log "  ✓ ${ROLE} 只有 pg_monitor 與 CONNECT"
}

if [ "$ROLE_ONLY" = 1 ]; then
  ensure_db_role
  exit 0
fi

# 掛載來源先確認都在：不在的話 docker 會把它建成 root 擁有的空目錄
# （例如 tunnel.json 變成目錄，之後安裝腳本寫不進去），所以缺一項就整輪不起。
check_mount_sources() {
  local missing=0 f d
  for f in "${APP_ROOT}/ops/status/cloudflared.yml" "${APP_ROOT}/ops/status/gatus.yml" \
    "${SECRETS_DIR}/tunnel.json" "${SECRETS_DIR}/status.env" "${SECRETS_DIR}/pghero.env"; do
    if [ ! -f "$f" ]; then
      log "✗ 找不到檔案 ${f}" >&2
      missing=1
    fi
  done
  for d in /srv/fju/status/data /srv/fju/status/inbox /srv/fju/status/envcheck /srv/fju/status/diskprobe; do
    if [ ! -d "$d" ]; then
      log "✗ 找不到目錄 ${d}" >&2
      missing=1
    fi
  done
  if [ "$missing" = 1 ]; then
    log "  cloudflared.yml 由 ops/status-render-cloudflared.sh 產生；其餘由安裝腳本 ops/status-install.sh 建立" >&2
    return 1
  fi
  # 主網站的目錄只唯讀掛給 collector；某站還沒有（例如正式站還沒部署過）只提醒、不擋。
  for d in /srv/fju/test/deploy /srv/fju/prod/deploy /srv/fju/test/backups /srv/fju/prod/backups /srv/fju/offsite; do
    [ -d "$d" ] || log "  提醒：${d} 不存在，docker 會建成空目錄（collector 會當成沒有紀錄）"
  done
}

# 順序：先補建角色、再更新、更新後再補一次。
# 先補建是為了「測試站剛重置完、但這輪拉映像失敗（GHCR 暫時連不上）」時角色照樣補回；
# 更新後再補一次，涵蓋拉映像那幾分鐘裡資料庫才起來的情況。更新失敗時仍回傳原本的錯誤碼。
role_rc=0
ensure_db_role || role_rc=$?

log "更新開發者後台（compose project fju-status）"
update_rc=0
# 只拉自己的映像（:main 會變）。第三方映像都是固定版本，up -d 第一次會自己拉；
# 每 10 分鐘全部重拉會撞 Docker Hub 的匿名拉取次數上限（VM 只登入 GHCR）。
run docker compose -p fju-status -f "$COMPOSE_FILE" pull status-web collector docker-proxy || update_rc=$?
if [ "$update_rc" = 0 ] && [ "$DRY_RUN" = 0 ]; then
  check_mount_sources || update_rc=$?
fi
if [ "$update_rc" = 0 ]; then
  run docker compose -p fju-status -f "$COMPOSE_FILE" up -d --remove-orphans || update_rc=$?
else
  log "✗ 更新沒完成（結束碼 ${update_rc}），服務維持原狀" >&2
fi

ensure_db_role || role_rc=$?

if [ "$update_rc" != 0 ]; then
  exit "$update_rc"
fi
exit "$role_rc"
