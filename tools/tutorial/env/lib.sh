# 教學影片本機環境的共用設定（up.sh／reset.sh／down.sh 會 source 這支）。
#
# 所有值都可以用同名環境變數蓋掉；秘密（BETTER_AUTH_SECRET、帳號密碼）只放 $TUTORIAL_SECRETS_DIR，不進 repo。

ENV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${TUTORIAL_REPO:-$(cd "$ENV_DIR/../../.." && pwd)}"
WEB_DIR="$REPO_ROOT/web"

PORT="${TUTORIAL_PORT:-3300}"
BASE_URL="http://localhost:$PORT"
DB_NAME="${TUTORIAL_DB:-fju_tutorial}"
PG_CONTAINER="${TUTORIAL_PG_CONTAINER:-fju-postgres}"
PG_HOSTPORT="${TUTORIAL_PG_HOSTPORT:-127.0.0.1:55432}"
# 本機 Compose 的 postgres 預設值（docker-compose.yml）；fju_app 的密碼整個 cluster 共用，沿用整合測試的預設，不去 ALTER ROLE。
PG_OWNER_PASSWORD="${TUTORIAL_PG_OWNER_PASSWORD:-fju_local_dev}"
PG_APP_PASSWORD="${TUTORIAL_PG_APP_PASSWORD:-fju_app_local_test}"

FILES_DIR="${TUTORIAL_FILES_DIR:-$HOME/work/tutorial-files}"
SECRETS_DIR="${TUTORIAL_SECRETS_DIR:-$HOME/work/tutorial-secrets}"
RUN_DIR="${TUTORIAL_RUN_DIR:-$HOME/work/tutorial-run}"
ACCOUNTS_FILE="${TUTORIAL_ACCOUNTS_FILE:-$SECRETS_DIR/accounts.json}"
SECRET_ENV_FILE="$SECRETS_DIR/env"

APP_PID_FILE="$RUN_DIR/app.pid"
WORKER_PID_FILE="$RUN_DIR/worker.pid"
APP_LOG="$RUN_DIR/app.log"
WORKER_LOG="$RUN_DIR/worker.log"

log() { printf '[tutorial-env] %s\n' "$*"; }
die() { printf '[tutorial-env] 錯誤：%s\n' "$*" >&2; exit 1; }

# 第一次跑時產生本機隨機 secret（權限 600），之後沿用，session cookie 才不會每次重起就失效。
ensure_secrets() {
  mkdir -p "$SECRETS_DIR" "$RUN_DIR" "$FILES_DIR"
  chmod 700 "$SECRETS_DIR"
  if [[ ! -f "$SECRET_ENV_FILE" ]]; then
    (umask 077; printf 'BETTER_AUTH_SECRET=%s\n' "$(openssl rand -hex 32)" > "$SECRET_ENV_FILE")
    log "產生本機 BETTER_AUTH_SECRET：$SECRET_ENV_FILE"
  fi
  chmod 600 "$SECRET_ENV_FILE"
}

# app、worker、migration、seed 共用的環境變數。
load_env() {
  ensure_secrets
  set -a
  # shellcheck disable=SC1090
  source "$SECRET_ENV_FILE"
  set +a
  export DATABASE_URL_OWNER="postgres://fju_owner:$PG_OWNER_PASSWORD@$PG_HOSTPORT/$DB_NAME"
  export DATABASE_URL="postgres://fju_app:$PG_APP_PASSWORD@$PG_HOSTPORT/$DB_NAME"
  export BETTER_AUTH_URL="$BASE_URL"
  export FILES_ROOT="$FILES_DIR"
  export FILE_MAX_BYTES="${FILE_MAX_BYTES:-104857600}"
  # Google 登入在本機不能用；給假值只是讓按鈕組得出網址（同 CI 的 e2e-smoke）。
  export GOOGLE_CLIENT_ID="${GOOGLE_CLIENT_ID:-local-only-client-id.apps.googleusercontent.com}"
  export GOOGLE_CLIENT_SECRET="${GOOGLE_CLIENT_SECRET:-local-only-client-secret}"
  # 開放註冊（錄「新註冊」那段要用）；模擬業務鐘預設關（畫面跟正式站一樣，沒有「模擬業務鐘」頁）。
  export REGISTRATION_OPEN="${REGISTRATION_OPEN:-true}"
  export BUSINESS_CLOCK_OVERRIDE_ENABLED="${BUSINESS_CLOCK_OVERRIDE_ENABLED:-false}"
  export NODE_ENV=production
  export GIT_COMMIT="${GIT_COMMIT:-$(git -C "$REPO_ROOT" rev-parse HEAD)}"
  export APP_VERSION="${APP_VERSION:-$GIT_COMMIT}"
}

psql_admin() {
  docker exec -i "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -q -U fju_owner -d postgres "$@"
}

ensure_postgres() {
  if [[ "$(docker inspect -f '{{.State.Running}}' "$PG_CONTAINER" 2>/dev/null)" != "true" ]]; then
    log "啟動 postgres 容器 $PG_CONTAINER"
    docker start "$PG_CONTAINER" >/dev/null || die "起不來 $PG_CONTAINER（先在 repo 根跑 pnpm -C web db:up 建一次）"
  fi
  for _ in $(seq 1 30); do
    docker exec "$PG_CONTAINER" pg_isready -U fju_owner -d postgres >/dev/null 2>&1 && return 0
    sleep 1
  done
  die "postgres 30 秒內沒有就緒"
}

db_exists() {
  [[ "$(psql_admin -Atc "select 1 from pg_database where datname = '$DB_NAME'")" == "1" ]]
}

create_db() {
  psql_admin -c "create database \"$DB_NAME\""
}

drop_db() {
  # WITH (FORCE)：app 連線池還連著也能刪；app 之後的請求會自己重連到新庫。
  psql_admin -c "drop database if exists \"$DB_NAME\" with (force)"
}

# 套 migration → 示範資料 → 教學帳號。seed-demo 只認 FJU_SITE=test：這裡只在這一個指令上設它，連的是本機的 $DB_NAME。
prepare_data() {
  log "套 migration"
  (cd "$WEB_DIR" && node scripts/migrate.mjs | grep -v '^SCHEMA_VERSION=')
  log "灌示範資料（seed-demo）"
  (cd "$WEB_DIR" && FJU_SITE=test node scripts/seed-demo.mjs)
  log "設定教學帳號"
  node "$ENV_DIR/accounts.mjs" apply
}

# pid 檔記的程序還活著，而且指令列還是我們起的那個（避免 pid 被系統回收後停錯人），才算在跑。
pid_alive() {
  local file="$1" pid cmd
  [[ -f "$file" ]] || return 1
  pid="$(cat "$file")"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null || return 1
  cmd="$(ps -p "$pid" -o command= 2>/dev/null)"
  [[ "$cmd" == *"next start --port $PORT"* || "$cmd" == *"dist/worker.mjs"* || "$cmd" == *next-server* ]]
}

start_app() {
  if pid_alive "$APP_PID_FILE"; then log "app 已在跑（pid $(cat "$APP_PID_FILE")）"; return 0; fi
  lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && die "port $PORT 已被別的程序佔用"
  log "起 app：$BASE_URL（log：$APP_LOG）"
  # set -m：背景程序自成一個 process group，down.sh 停整組（next start 的子程序也一起），不波及別人。
  set -m
  (cd "$WEB_DIR" && exec node node_modules/next/dist/bin/next start --port "$PORT") >"$APP_LOG" 2>&1 &
  echo $! >"$APP_PID_FILE"
  set +m
}

start_worker() {
  if pid_alive "$WORKER_PID_FILE"; then log "worker 已在跑（pid $(cat "$WORKER_PID_FILE")）"; return 0; fi
  log "起背景工作 worker（log：$WORKER_LOG）"
  set -m
  (cd "$WEB_DIR" && exec node dist/worker.mjs) >>"$WORKER_LOG" 2>&1 &
  echo $! >"$WORKER_PID_FILE"
  set +m
}

# 只停 pid 檔裡記的那一組（process group），不按名稱比對。
stop_pid_file() {
  local file="$1" name="$2" pid
  if ! pid_alive "$file"; then rm -f "$file"; log "$name 沒在跑"; return 0; fi
  pid="$(cat "$file")"
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -f "$file"
  log "已停 $name（pid $pid）"
}

wait_healthy() {
  for _ in $(seq 1 90); do
    curl -sf "$BASE_URL/api/health" >/dev/null 2>&1 && { log "網站就緒：$BASE_URL"; return 0; }
    pid_alive "$APP_PID_FILE" || die "app 結束了，看 $APP_LOG"
    sleep 1
  done
  die "app 90 秒內沒有通過 /api/health，看 $APP_LOG"
}
