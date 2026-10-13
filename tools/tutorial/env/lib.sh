# 教學影片本機環境的共用設定（up.sh／reset.sh／down.sh 會 source 這支）。
#
# 多實例：INSTANCE=0～4（沒設＝0），讓幾個人同時錄、各自 reset 不互相干擾。實例 n 的
#   資料庫 fju_tutorial（0）或 fju_tutorial_<n>、網站 http://localhost:<3300+n>、
#   檔案 ~/work/tutorial-files/<n>、pid 與 log ~/work/tutorial-run/<n>、帳號設定 ~/work/tutorial-secrets/accounts[-<n>].json。
#   建置產物（web/.next、web/dist）各實例共用。
#
# 秘密（BETTER_AUTH_SECRET、帳號密碼）只放 $SECRETS_DIR，不進 repo。
# 會刪庫、清目錄、送訊號，所以每個入口一開始先跑 safety_check（safety.mjs），目標不對就在任何副作用之前停下：
#   - 資料庫名只能是 fju_tutorial／fju_tutorial_1～4 中這個實例的那一個、只連 127.0.0.1:55432
#   - FILES_ROOT 正規化後只能是 ~/work/tutorial-files/<n> 或它底下
#   - Docker 只經本機 unix socket（DOCKER_HOST 設成遠端就拒絕）
#   - 停程序前核對 pid 檔記的啟動時間、工作目錄、種類、PGID，不符就只清 pid 檔

log() { printf '[tutorial-env%s] %s\n' "${INSTANCE:+ #$INSTANCE}" "$*"; }
die() { printf '[tutorial-env%s] 錯誤：%s\n' "${INSTANCE:+ #$INSTANCE}" "$*" >&2; exit 1; }

INSTANCE="${INSTANCE:-0}"
[[ "$INSTANCE" =~ ^[0-4]$ ]] || die "INSTANCE 只能是 0～4（收到「$INSTANCE」）"
export INSTANCE

ENV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${TUTORIAL_REPO:-$(cd "$ENV_DIR/../../.." && pwd)}"
WEB_DIR="$(cd "$REPO_ROOT/web" && pwd -P)"

PORT=$((3300 + INSTANCE))
BASE_URL="http://localhost:$PORT"
# 同一個 postgres cluster 上還有各票的 e2e／測試庫，教學環境只碰這五個名字之一（safety.mjs、assert_tutorial_db 都核對）。
if [[ "$INSTANCE" == 0 ]]; then DB_NAME=fju_tutorial; else DB_NAME="fju_tutorial_$INSTANCE"; fi
PG_HOSTPORT=127.0.0.1:55432
PG_CONTAINER=fju-postgres
# 本機 Compose 的 postgres 預設值（docker-compose.yml）；fju_app 的密碼整個 cluster 共用，沿用整合測試的預設，不去 ALTER ROLE。
PG_OWNER_PASSWORD=fju_local_dev
PG_APP_PASSWORD=fju_app_local_test

FILES_DIR="${TUTORIAL_FILES_DIR:-$HOME/work/tutorial-files/$INSTANCE}"
SECRETS_DIR="${TUTORIAL_SECRETS_DIR:-$HOME/work/tutorial-secrets}"
RUN_ROOT="${TUTORIAL_RUN_DIR:-$HOME/work/tutorial-run}"
RUN_DIR="$RUN_ROOT/$INSTANCE"
BUILD_MARK="$RUN_ROOT/build-commit"
SECRET_ENV_FILE="$SECRETS_DIR/env"

APP_PID_FILE="$RUN_DIR/app.pid"
WORKER_PID_FILE="$RUN_DIR/worker.pid"
APP_LOG="$RUN_DIR/app.log"
WORKER_LOG="$RUN_DIR/worker.log"

DOCKER_ENDPOINT=""

# 任何副作用之前跑：驗資料庫目標、FILES_ROOT、Docker endpoint；用驗過、正規化後的值覆寫變數。
safety_check() {
  [[ -z "${TUTORIAL_DB:-}" || "$TUTORIAL_DB" == "$DB_NAME" ]] || die "實例 $INSTANCE 的資料庫只能是 $DB_NAME（不接受改名）"
  assert_tutorial_db
  export DATABASE_URL_OWNER="postgres://fju_owner:$PG_OWNER_PASSWORD@$PG_HOSTPORT/$DB_NAME"
  export DATABASE_URL="postgres://fju_app:$PG_APP_PASSWORD@$PG_HOSTPORT/$DB_NAME"
  local out
  out="$(FILES_ROOT="$FILES_DIR" TUTORIAL_CHECK_DOCKER=1 node "$ENV_DIR/safety.mjs" check-env)" || exit 1
  FILES_DIR="$(printf '%s\n' "$out" | sed -n 's/^FILES_ROOT=//p')"
  DOCKER_ENDPOINT="$(printf '%s\n' "$out" | sed -n 's/^DOCKER_ENDPOINT=//p')"
  [[ -n "$FILES_DIR" && -n "$DOCKER_ENDPOINT" ]] || die "safety.mjs 沒有回傳驗證後的目標"
  [[ "$(printf '%s\n' "$out" | sed -n 's/^DB_NAME=//p')" == "$DB_NAME" && "$(printf '%s\n' "$out" | sed -n 's/^PORT=//p')" == "$PORT" ]] \
    || die "safety.mjs 算出的資料庫或 port 跟 lib.sh 不一致"
}

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

# app、worker、migration、seed 共用的環境變數。必須在 safety_check 之後呼叫。
load_env() {
  ensure_secrets
  set -a
  # shellcheck disable=SC1090
  source "$SECRET_ENV_FILE"
  set +a
  export BETTER_AUTH_URL="$BASE_URL"
  export FILES_ROOT="$FILES_DIR"
  export FILE_MAX_BYTES="${FILE_MAX_BYTES:-104857600}"
  # Google 登入在本機不能用；給假值只是讓按鈕組得出網址（同 CI 的 e2e-smoke）。
  export GOOGLE_CLIENT_ID="${GOOGLE_CLIENT_ID:-local-only-client-id.apps.googleusercontent.com}"
  export GOOGLE_CLIENT_SECRET="${GOOGLE_CLIENT_SECRET:-local-only-client-secret}"
  # 本機實例照測試站的樣子跑（分鏡要錄模擬業務鐘與「發一則測試通知」）：app 認的是
  # BUSINESS_CLOCK_OVERRIDE_ENABLED=true；FJU_SITE=test 一併設（seed-demo 也只認它）。只影響本機這幾個實例。
  export FJU_SITE=test
  export BUSINESS_CLOCK_OVERRIDE_ENABLED=true
  # 開放註冊（錄「新註冊」那段要用）。
  export REGISTRATION_OPEN="${REGISTRATION_OPEN:-true}"
  export NODE_ENV=production
  export GIT_COMMIT="${GIT_COMMIT:-$(git -C "$REPO_ROOT" rev-parse HEAD)}"
  export APP_VERSION="${APP_VERSION:-$GIT_COMMIT}"
}

# 所有 docker 呼叫都走 safety_check 驗過的本機 socket（-H 蓋過 DOCKER_HOST 與 docker context）。
dock() {
  [[ "$DOCKER_ENDPOINT" == unix://* ]] || die "Docker endpoint 還沒驗證"
  env -u DOCKER_HOST -u DOCKER_CONTEXT docker -H "$DOCKER_ENDPOINT" "$@"
}

psql_admin() {
  dock exec -i "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -q -U fju_owner -d postgres "$@"
}

ensure_postgres() {
  if [[ "$(dock inspect -f '{{.State.Running}}' "$PG_CONTAINER" 2>/dev/null)" != "true" ]]; then
    log "啟動 postgres 容器 $PG_CONTAINER"
    dock start "$PG_CONTAINER" >/dev/null || die "起不來 $PG_CONTAINER（先在 repo 根跑 pnpm -C web db:up 建一次）"
  fi
  for _ in $(seq 1 30); do
    dock exec "$PG_CONTAINER" pg_isready -U fju_owner -d postgres >/dev/null 2>&1 && return 0
    sleep 1
  done
  die "postgres 30 秒內沒有就緒"
}

# 資料庫名只能是五個固定名字之一，而且是這個實例的那一個；建庫、刪庫前都再核對一次。
assert_tutorial_db() {
  case "$DB_NAME" in
    fju_tutorial | fju_tutorial_1 | fju_tutorial_2 | fju_tutorial_3 | fju_tutorial_4) ;;
    *) die "資料庫名「$DB_NAME」不是 fju_tutorial／fju_tutorial_1～4，拒絕操作" ;;
  esac
  local expected=fju_tutorial
  [[ "$INSTANCE" == 0 ]] || expected="fju_tutorial_$INSTANCE"
  [[ "$DB_NAME" == "$expected" ]] || die "實例 $INSTANCE 的資料庫是 $expected，不是 $DB_NAME"
}

db_exists() {
  assert_tutorial_db
  [[ "$(psql_admin -Atc "select 1 from pg_database where datname = '$DB_NAME'")" == "1" ]]
}

create_db() {
  assert_tutorial_db
  psql_admin -c "create database \"$DB_NAME\""
}

drop_db() {
  assert_tutorial_db
  # WITH (FORCE)：萬一還有別的連線也刪得掉（reset 會先停自己的 app／worker）。
  psql_admin -c "drop database if exists \"$DB_NAME\" with (force)"
}

# 套 migration → 示範資料 → 教學帳號。seed-demo 只認 FJU_SITE=test（load_env 已設；連的是本機這個實例的教學庫）。
prepare_data() {
  log "套 migration"
  (cd "$WEB_DIR" && node scripts/migrate.mjs | grep -v '^SCHEMA_VERSION=')
  log "灌示範資料（seed-demo）"
  (cd "$WEB_DIR" && FJU_SITE=test node scripts/seed-demo.mjs)
  log "設定教學帳號"
  node "$ENV_DIR/accounts.mjs" apply
}

# pid 檔記的程序還在，而且啟動時間、工作目錄、種類、PGID 都跟啟動時記的一樣，才算是我們的。
proc_ours() {
  local kind="$1" file="$2"
  [[ -f "$file" ]] || return 1
  node "$ENV_DIR/safety.mjs" proc-check "$kind" "$file"
}

# 在 web 目錄直接起 node（不經子 shell，$! 就是那個程序、工作目錄在 fork 當下就是 web）。
# set -m：背景程序自成一個 process group，停的時候整組停（next start 的子程序也一起），不波及別人。
spawn() {
  local kind="$1" file="$2" logfile="$3" mode="$4"; shift 4
  local pid
  pushd "$WEB_DIR" >/dev/null
  set -m
  if [[ "$mode" == append ]]; then "$@" >>"$logfile" 2>&1 & else "$@" >"$logfile" 2>&1 & fi
  pid=$!
  set +m
  popd >/dev/null
  node "$ENV_DIR/safety.mjs" proc-record "$kind" "$pid" "$file" "$WEB_DIR" || die "$kind 起來了但記不到它的身分（pid $pid）"
}

start_app() {
  if proc_ours app "$APP_PID_FILE"; then log "app 已在跑"; return 0; fi
  lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && die "port $PORT 已被別的程序佔用"
  log "起 app：$BASE_URL（log：$APP_LOG）"
  spawn app "$APP_PID_FILE" "$APP_LOG" truncate node node_modules/next/dist/bin/next start --port "$PORT"
}

start_worker() {
  if proc_ours worker "$WORKER_PID_FILE"; then log "worker 已在跑"; return 0; fi
  log "起背景工作 worker（log：$WORKER_LOG）"
  spawn worker "$WORKER_PID_FILE" "$WORKER_LOG" append node dist/worker.mjs
}

# 只停 pid 檔裡記、而且身分核對得上的那一組（process group）；核對不上就只清 pid 檔、不送任何訊號。
stop_proc() {
  local kind="$1" file="$2" pid
  if [[ ! -f "$file" ]]; then log "$kind 沒在跑"; return 0; fi
  if ! TUTORIAL_VERBOSE=1 proc_ours "$kind" "$file"; then
    rm -f "$file"
    log "$kind 的 pid 檔對不上現在的程序，只清掉 pid 檔、不送訊號"
    return 0
  fi
  pid="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).pgid)' "$file")"
  kill -TERM -- "-$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  # 還沒停：再核對一次身分才補 KILL。
  if kill -0 "$pid" 2>/dev/null && proc_ours "$kind" "$file"; then kill -KILL -- "-$pid" 2>/dev/null || true; fi
  rm -f "$file"
  log "已停 $kind（pid $pid）"
}

wait_healthy() {
  for _ in $(seq 1 90); do
    curl -sf "$BASE_URL/api/health" >/dev/null 2>&1 && { log "網站就緒：$BASE_URL"; return 0; }
    proc_ours app "$APP_PID_FILE" || die "app 結束了，看 $APP_LOG"
    sleep 1
  done
  die "app 90 秒內沒有通過 /api/health，看 $APP_LOG"
}

# 有沒有任何一個實例的 app／worker 在用這份建置（重建會把它們跑到一半的 .next 換掉）。
running_instances() {
  local n list=""
  for n in 0 1 2 3 4; do
    if proc_ours app "$RUN_ROOT/$n/app.pid" || proc_ours worker "$RUN_ROOT/$n/worker.pid"; then list="$list $n"; fi
  done
  printf '%s' "${list# }"
}

# 建置產物各實例共用：沒有、或 web/ 的內容（HEAD 的 web tree）跟上次建置時不同才建（mode=auto）；
# 只改 tools/ 之類的 commit 不會觸發重建。force 一定建；skip 不建。
# 要建時若有實例在跑就拒絕，並用目錄鎖擋住兩個人同時建。
ensure_build() {
  local mode="$1" head built="" running
  head="$(git -C "$REPO_ROOT" rev-parse HEAD:web)"
  [[ -f "$BUILD_MARK" ]] && built="$(cat "$BUILD_MARK")"
  if [[ "$mode" == skip ]]; then
    [[ -f "$WEB_DIR/.next/BUILD_ID" && -f "$WEB_DIR/dist/worker.mjs" ]] || die "還沒有建置產物，不能 --no-build"
    return 0
  fi
  if [[ "$mode" == auto && -f "$WEB_DIR/.next/BUILD_ID" && -f "$WEB_DIR/dist/worker.mjs" && "$built" == "$head" ]]; then
    log "沿用既有建置（web tree $head）"
    return 0
  fi
  running="$(running_instances)"
  [[ -z "$running" ]] || die "實例 $running 正在用目前的建置；要重建先把它們 down，或用 --no-build 沿用舊建置"
  mkdir -p "$RUN_ROOT"
  mkdir "$RUN_ROOT/build.lock" 2>/dev/null || die "另一個 up.sh 正在建置（$RUN_ROOT/build.lock）；等它完成再跑"
  trap 'rmdir "$RUN_ROOT/build.lock" 2>/dev/null' EXIT
  log "建置（pnpm -C web build，各實例共用）"
  (cd "$REPO_ROOT" && pnpm -C web build >"$RUN_ROOT/build.log" 2>&1) || die "建置失敗，看 $RUN_ROOT/build.log"
  printf '%s\n' "$head" >"$BUILD_MARK"
  rmdir "$RUN_ROOT/build.lock"
  trap - EXIT
}
