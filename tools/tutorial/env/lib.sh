# shellcheck shell=bash
# 教學影片本機環境的共用設定（up.sh／reset.sh／down.sh／clock-reset.sh 會 source 這支）。
# 要能在 macOS 內建的 Bash 3.2 跑：變數後面緊接中文或全形標點一律寫 ${VAR}（3.2 在 UTF-8 locale 會把那些字讀進變數名，
# set -u 就直接退出）；safety.test.mjs 有掃這件事。
#
# 多實例：INSTANCE=0～4（沒設＝0），讓幾個人同時錄、各自 reset 不互相干擾。實例 n 的
#   資料庫 fju_tutorial（0）或 fju_tutorial_<n>、網站 http://localhost:<3300+n>、
#   檔案 ~/work/tutorial-files/<n>、pid 與 log ~/work/tutorial-run/<n>、帳號設定 ~/work/tutorial-secrets/accounts[-<n>].json。
#   建置產物（web/.next、web/dist）各實例共用。
#
# 網站版本：不是用這支腳本所在的 checkout，而是固定在 ~/work/tutorial-site（origin/main 的 detached worktree）。
#   第一次 up.sh --build 從當時最新的 origin/main 建；之後 up.sh 預設不建置、不換 commit，要換只能 up.sh --update。
#   建置與換版本只在 0～4 全部沒在跑時做（持鎖後查），錄影期間不會有人改寫共用的 .next。
#   用的 commit 寫在 ~/work/tutorial-out/env-commit.txt。
#
# 秘密（BETTER_AUTH_SECRET、帳號密碼）只放 $SECRETS_DIR，不進 repo。
# 會刪庫、清目錄、送訊號，所以每個入口一開始先跑 safety_check（safety.mjs），目標不對就在任何副作用之前停下：
#   - 資料庫名只能是 fju_tutorial／fju_tutorial_1～4 中這個實例的那一個、只連 127.0.0.1:55432
#   - FILES_ROOT 正規化後只能是 ~/work/tutorial-files/<n> 或它底下；work、tutorial-files、<n> 這三層本身不能是符號連結
#   - Docker 只經本機 unix socket（DOCKER_HOST 設成遠端就拒絕）
#   - 停程序前核對 pid 檔記的啟動時間、工作目錄、種類、PGID，不符就只清 pid 檔
# 多實例共用一把鎖（$RUN_ROOT/lock，lock_acquire／lock_release）：checkout 更新、安裝、建置、起程序與登記 pid，
#   以及 reset 的「停→重灌→再起」整段都在鎖裡做；「有沒有實例在跑」要持鎖後才檢查（別人要起或重起實例也得先拿到鎖，
#   檢查結果才不會過時）。殘留的鎖不自動收回：等到逾時就零副作用退出，請人確認後手動刪。down.sh 只會讓實例變少，不用鎖。

log() { printf '[tutorial-env%s] %s\n' "${INSTANCE:+ #$INSTANCE}" "$*"; }
die() { printf '[tutorial-env%s] 錯誤：%s\n' "${INSTANCE:+ #$INSTANCE}" "$*" >&2; exit 1; }

INSTANCE="${INSTANCE:-0}"
[[ "$INSTANCE" =~ ^[0-4]$ ]] || die "INSTANCE 只能是 0～4（收到「${INSTANCE}」）"
export INSTANCE

ENV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# 這支腳本所在的 repo：只用來 fetch origin、建 site worktree。網站本身跑 SITE_DIR 那一份。
REPO_ROOT="$(cd "$ENV_DIR/../../.." && pwd)"
SITE_DIR="${TUTORIAL_SITE_DIR:-$HOME/work/tutorial-site}"
if [[ -d "$SITE_DIR/web" ]]; then WEB_DIR="$(cd "$SITE_DIR/web" && pwd -P)"; else WEB_DIR="$SITE_DIR/web"; fi
OUT_DIR="$HOME/work/tutorial-out"
COMMIT_FILE="$OUT_DIR/env-commit.txt"
# accounts.mjs、safety.mjs 從這裡找 web 的依賴（pg、better-auth）。
export TUTORIAL_REPO="$SITE_DIR"

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
LOCK_DIR="$RUN_ROOT/lock"
LOCK_HELD=0
BUILD_PGID=""

# 任何副作用之前跑：驗資料庫目標、FILES_ROOT、Docker endpoint；用驗過、正規化後的值覆寫變數。
safety_check() {
  [[ -z "${TUTORIAL_DB:-}" || "$TUTORIAL_DB" == "$DB_NAME" ]] || die "實例 $INSTANCE 的資料庫只能是 ${DB_NAME}（不接受改名）"
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
  assert_files_dir
}

# FILES_DIR（safety.mjs 正規化後的值）在 shell 這邊再比對一次：只能是 $HOME（realpath）/work/tutorial-files/<n> 或它底下。
# safety_check 跑一次；reset.sh 在 rm -rf 之前再跑一次。
assert_files_dir() {
  local root
  root="$(cd "$HOME" && pwd -P)/work/tutorial-files/$INSTANCE"
  [[ "$FILES_DIR" == "$root" || "$FILES_DIR" == "$root"/* ]] || die "FILES_DIR=${FILES_DIR} 不是這個實例的教學檔案目錄 ${root}，不動它"
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
  GIT_COMMIT="$(git -C "$SITE_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
  export GIT_COMMIT APP_VERSION="$GIT_COMMIT"
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
    dock start "$PG_CONTAINER" >/dev/null || die "起不來 ${PG_CONTAINER}（先在 repo 根跑 pnpm -C web db:up 建一次）"
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
    *) die "資料庫名「${DB_NAME}」不是 fju_tutorial／fju_tutorial_1～4，拒絕操作" ;;
  esac
  local expected=fju_tutorial
  [[ "$INSTANCE" == 0 ]] || expected="fju_tutorial_$INSTANCE"
  [[ "$DB_NAME" == "$expected" ]] || die "實例 $INSTANCE 的資料庫是 ${expected}，不是 $DB_NAME"
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
  (cd "$WEB_DIR" && FJU_SITE='test' node scripts/seed-demo.mjs)
  log "設定教學帳號"
  node "$ENV_DIR/accounts.mjs" apply
  set_demo_cohort_flags
}

# 建置產物齊全而且是目前網站版本的：checkout、node_modules、.next/BUILD_ID、dist/worker.mjs、build mark＝HEAD 的 web tree。
# up.sh（預設不建置）與 reset.sh 都靠它；不齊就零副作用退出，請人先把所有實例 down 再 up.sh --build。
require_built() {
  local head hint="先把所有實例 down，再跑 up.sh --build（第一次用、或換版本後）"
  [[ -f "$WEB_DIR/package.json" ]] || die "還沒有網站 checkout（${SITE_DIR}）；${hint}"
  [[ -d "$WEB_DIR/node_modules" ]] || die "網站 checkout 還沒裝依賴（${WEB_DIR}）；${hint}"
  [[ -f "$WEB_DIR/.next/BUILD_ID" && -f "$WEB_DIR/dist/worker.mjs" ]] || die "還沒有建置產物（${WEB_DIR}/.next、dist）；${hint}"
  head="$(git -C "$SITE_DIR" rev-parse HEAD:web 2>/dev/null || true)"
  [[ -n "$head" && "$(cat "$BUILD_MARK" 2>/dev/null)" == "$head" ]] || die "建置產物不是目前網站版本的（或上次建置沒完成）；${hint}"
}

# 建置、換版本之前（持鎖後）：0～4 全部都沒在跑才行——重建會把跑到一半的 .next 換掉。
ensure_idle() {
  local running
  lock_assert ensure_idle
  running="$(running_instances)"
  [[ -z "$running" ]] || die "實例 ${running} 在跑；建置或換網站版本前要先把所有實例 down（每個實例跑 down.sh）"
}

# 示範 114 屆設成「後台預設查看的屆別」與「新註冊加入的屆別」（seed-demo 刻意不動這兩個全系旗標；
# 本機教學環境要讓老師首頁、註冊頁有屆別可用）。跟網站的設定用例一樣：先清掉原本持有旗標的屆別再設（兩欄各有「只能一個 true」的唯一索引）。
set_demo_cohort_flags() {
  assert_tutorial_db
  local out
  out="$(dock exec -i "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -qAt -U fju_owner -d "$DB_NAME" <<'SQL'
begin;
create temp table t on commit drop as
  select c.id, (select user_id from role_assignments where role = 'admin' and revoked_real_at is null order by granted_real_at limit 1) as office
    from cohorts c where c.code = 'DEMO-114' and c.status <> 'archived';
update cohorts set is_default_working = false, revision = revision + 1, updated_at = now(), updated_by_user_id = (select office from t)
 where is_default_working and id not in (select id from t);
update cohorts set is_registration_open = false, revision = revision + 1, updated_at = now(), updated_by_user_id = (select office from t)
 where is_registration_open and id not in (select id from t);
update cohorts set is_default_working = true, is_registration_open = true, revision = revision + 1, updated_at = now(), updated_by_user_id = t.office
  from t where cohorts.id = t.id and not (is_default_working and is_registration_open);
select count(*) from t;
commit;
SQL
)"
  [[ "$out" == "1" ]] || die "找不到示範 114 屆（DEMO-114），設不了預設屆別"
  log "示範 114 屆已設為後台預設查看的屆別與新註冊加入的屆別"
}

running_any() { [[ -n "$(running_instances)" ]]; }

# 網站 checkout：沒有就從最新 origin/main 建；有就沿用（錄影期間不換 commit）。mode=update 才移到最新 origin/main。
# 會動 checkout 與 node_modules，必須持鎖（有沒有實例在跑也是持鎖後才查得準）。
ensure_site() {
  local mode="$1" commit
  lock_assert ensure_site
  mkdir -p "$RUN_ROOT"
  if [[ ! -d "$SITE_DIR" ]]; then
    log "建網站 checkout：$SITE_DIR ← 最新 origin/main"
    git -C "$REPO_ROOT" fetch -q origin main
    git -C "$REPO_ROOT" worktree add -q --detach "$SITE_DIR" origin/main
  elif [[ "$mode" == update ]]; then
    running_any && die "實例 $(running_instances) 在跑；要換網站版本先把所有實例 down"
    [[ -z "$(git -C "$SITE_DIR" status --porcelain --untracked-files=no)" ]] || die "$SITE_DIR 有未提交的修改，不換版本"
    git -C "$SITE_DIR" fetch -q origin main
    log "網站 checkout 換到最新 origin/main"
    git -C "$SITE_DIR" checkout -q --detach origin/main
  fi
  WEB_DIR="$(cd "$SITE_DIR/web" && pwd -P)"
  commit="$(git -C "$SITE_DIR" rev-parse HEAD)"
  if [[ ! -d "$WEB_DIR/node_modules" || "$(cat "$SITE_DIR/.tutorial-installed" 2>/dev/null)" != "$commit" ]]; then
    log "安裝依賴（pnpm install）"
    (cd "$SITE_DIR" && pnpm install -s --frozen-lockfile --filter @fju/web...) >"$RUN_ROOT/install.log" 2>&1 || die "pnpm install 失敗，看 $RUN_ROOT/install.log"
    printf '%s\n' "$commit" >"$SITE_DIR/.tutorial-installed"
  fi
  mkdir -p "$OUT_DIR"
  printf '%s %s\n' "$commit" "$(git -C "$SITE_DIR" log -1 --format='%cI %s' "$commit")" >"$COMMIT_FILE"
  export GIT_COMMIT="$commit" APP_VERSION="$commit"
  log "網站版本：$(git -C "$SITE_DIR" log -1 --format='%h %s' "$commit")（寫在 ${COMMIT_FILE}）"
}

# pid 檔記的程序還在，而且啟動時間、工作目錄、種類、PGID 都跟啟動時記的一樣，才算是我們的。
proc_ours() {
  local kind="$1" file="$2"
  [[ -f "$file" ]] || return 1
  node "$ENV_DIR/safety.mjs" proc-check "$kind" "$file"
}

# 在 web 目錄直接起 node（不經子 shell，$! 就是那個程序、工作目錄在 fork 當下就是 web）。
# set -m：背景程序自成一個 process group，停的時候整組停（next start 的子程序也一起），不波及別人。
# 起程序＋登記 pid 都要持鎖：建置前「有沒有實例在跑」的檢查才不會被剛起來的實例繞過。
# 鎖是 mkdir 目錄，不是檔案描述符，所以長駐的 app／worker 不會繼承任何鎖相關的 fd（它們只拿到 log 檔的 stdout／stderr）。
spawn() {
  local kind="$1" file="$2" logfile="$3" mode="$4"; shift 4
  local pid
  lock_assert spawn
  pushd "$WEB_DIR" >/dev/null || die "進不了 ${WEB_DIR}"
  set -m
  if [[ "$mode" == append ]]; then "$@" >>"$logfile" 2>&1 & else "$@" >"$logfile" 2>&1 & fi
  pid=$!
  set +m
  popd >/dev/null || true
  node "$ENV_DIR/safety.mjs" proc-record "$kind" "$pid" "$file" "$WEB_DIR" || die "$kind 起來了但記不到它的身分（pid ${pid}）"
}

start_app() {
  if proc_ours app "$APP_PID_FILE"; then log "app 已在跑"; return 0; fi
  lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && die "port $PORT 已被別的程序佔用"
  log "起 app：${BASE_URL}（log：${APP_LOG}）"
  spawn app "$APP_PID_FILE" "$APP_LOG" truncate node node_modules/next/dist/bin/next start --port "$PORT"
}

start_worker() {
  if proc_ours worker "$WORKER_PID_FILE"; then log "worker 已在跑"; return 0; fi
  log "起背景工作 worker（log：${WORKER_LOG}）"
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
  log "已停 ${kind}（pid ${pid}）"
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

# 建置（各實例共用）。只在持鎖、而且 0～4 全部沒在跑時做（up.sh 先 ensure_idle）。
# 建置前先清掉 build mark，成功才寫回：被中斷或失敗的建置不會被當成可用的產物（require_built 會擋）。
ensure_build() {
  local head
  lock_assert ensure_build
  head="$(git -C "$SITE_DIR" rev-parse HEAD:web)"
  rm -f "$BUILD_MARK"
  log "建置（pnpm -C web build，各實例共用）"
  run_build || die "建置失敗，看 ${RUN_ROOT}/build.log"
  printf '%s\n' "$head" >"$BUILD_MARK"
}

# 建置跑在自己的 process group，PGID 記在 BUILD_PGID 與鎖的 owner 檔（build-pgid 行）。
# leader（pnpm）結束——正常、失敗、或被 kill -9——都不代表整組結束：next build 的子程序可能還在改寫 .next，
# 所以一定等整組都退出（等不到就 TERM、再 KILL）才算建置結束；up.sh 被中斷時 lock_release 也走同一條路，整組停了才放鎖。
run_build() {
  local rc=0
  set -m
  (cd "$SITE_DIR" && exec pnpm -C web build >"$RUN_ROOT/build.log" 2>&1) &
  BUILD_PGID=$!
  set +m
  printf 'build-pgid %s\n' "$BUILD_PGID" >>"$LOCK_DIR/owner"
  wait "$BUILD_PGID" || rc=$?
  build_group_done || die "建置的 process group ${BUILD_PGID} 停不下來；先 pgrep -g ${BUILD_PGID} 看是誰、kill -KILL -- -${BUILD_PGID}，再重跑"
  return "$rc"
}

# 等建置的 process group 整組退出：先等 5 秒讓它自己收尾，還在就 TERM 等 10 秒、再 KILL 等 10 秒。
# 確認整組都不在了才清追蹤資訊（BUILD_PGID、owner 檔的 build-pgid 行）並回傳 0；停不下來回傳 1（呼叫端不放鎖）。
build_group_done() {
  local pgid="$BUILD_PGID" sig n
  [[ -n "$pgid" ]] || return 0
  for sig in "" TERM KILL; do
    [[ -z "$sig" ]] || kill "-$sig" -- "-$pgid" 2>/dev/null || true
    n=10; [[ -z "$sig" ]] || n=20
    for _ in $(seq 1 "$n"); do
      if ! kill -0 -- "-$pgid" 2>/dev/null; then
        BUILD_PGID=""
        if [[ -f "$LOCK_DIR/owner" ]]; then
          grep -v '^build-pgid ' "$LOCK_DIR/owner" >"$LOCK_DIR/owner.tmp" || true
          mv "$LOCK_DIR/owner.tmp" "$LOCK_DIR/owner"
        fi
        return 0
      fi
      sleep 0.5
    done
  done
  return 1
}

# ── 多實例共用鎖 ─────────────────────────────────────────────────────────────
# mkdir 原子建立 $LOCK_DIR；owner 檔第一行「pid 在做什麼」、建置中多一行「build-pgid <PGID>」，只拿來寫錯誤訊息。
# 拿不到就等，等到 TUTORIAL_LOCK_TIMEOUT 秒（預設 900，建置要幾分鐘）就零副作用退出，訊息寫鎖在哪、持有者 pid 還在不在、
# 建置的 PGID 要怎麼確認，請人確認沒有 up.sh／reset.sh 在跑之後手動刪掉鎖目錄。刻意不自動收回殘留鎖：不要為了罕見的殘留去冒兩個人同時拿到鎖的險。

lock_acquire() {
  local what="$1" waited=0 timeout="${TUTORIAL_LOCK_TIMEOUT:-900}" owner pid who build_pgid
  [[ "$LOCK_HELD" == 0 ]] || return 0
  [[ "$timeout" =~ ^[0-9]+$ ]] || die "TUTORIAL_LOCK_TIMEOUT 要是秒數（收到「${timeout}」）"
  mkdir -p "$RUN_ROOT"
  until mkdir "$LOCK_DIR" 2>/dev/null; do
    if [[ "$waited" -ge "$timeout" ]]; then
      owner="$(sed -n 1p "$LOCK_DIR/owner" 2>/dev/null || true)"
      build_pgid="$(sed -n 's/^build-pgid //p' "$LOCK_DIR/owner" 2>/dev/null || true)"
      pid="${owner%% *}"
      if [[ "$pid" =~ ^[0-9]+$ ]]; then
        if kill -0 "$pid" 2>/dev/null; then who="持有者 pid ${pid}（仍在）"; else who="持有者 pid ${pid}（已不在）"; fi
        who="${who}，它在做：${owner#* }"
      else
        who="沒有 owner 檔，持有者不明"
      fi
      [[ -z "$build_pgid" ]] || who="${who}；它的建置 process group PGID ${build_pgid}：刪鎖前先確認 pgrep -g ${build_pgid} 沒有任何程序，有的話先 kill -TERM -- -${build_pgid}"
      die "等了 ${waited} 秒還拿不到鎖。鎖在 ${LOCK_DIR}，${who}。確認沒有任何 up.sh／reset.sh 在跑之後，手動刪除這個目錄再重跑"
    fi
    [[ "$waited" -gt 0 ]] || log "等另一個 up.sh／reset.sh 完成（鎖在 ${LOCK_DIR}）…"
    sleep 1
    waited=$((waited + 1))
  done
  printf '%s %s\n' "$$" "$what" >"$LOCK_DIR/owner"
  LOCK_HELD=1
  trap lock_release EXIT
}

# 只放自己拿的鎖（owner 第一行的 pid 是自己）；die／Ctrl-C／kill 也會經 EXIT trap 走到這裡。
lock_release() {
  [[ "$LOCK_HELD" == 1 ]] || return 0
  # 建置還在跑（up.sh 被中斷）：整組停掉、確認都退出了才放鎖；停不下來就不放鎖，owner 檔留著 PGID 給下一個人看。
  if [[ -n "$BUILD_PGID" ]]; then
    kill -TERM -- "-$BUILD_PGID" 2>/dev/null || true
    build_group_done || { log "建置的 process group ${BUILD_PGID} 停不下來，鎖先不放（PGID 記在 ${LOCK_DIR}/owner）"; return 0; }
  fi
  LOCK_HELD=0
  [[ "$(sed -n 1p "$LOCK_DIR/owner" 2>/dev/null | cut -d' ' -f1)" == "$$" ]] || return 0
  rm -f "$LOCK_DIR/owner"
  rmdir "$LOCK_DIR" 2>/dev/null || true
}

lock_assert() { [[ "$LOCK_HELD" == 1 ]] || die "程式錯誤：${1} 要在 lock_acquire 之後才能呼叫"; }

# 網站 checkout 目前的狀態（給 up.sh --dry-run 印）：還沒建、或 commit 與有沒有建置產物。
describe_site() {
  if [[ ! -d "$SITE_DIR" ]]; then
    printf '%s' "還沒建（up.sh 會從最新 origin/main 建）"
    return 0
  fi
  local commit built="沒有建置產物"
  commit="$(git -C "$SITE_DIR" log -1 --format='%h %s' 2>/dev/null || echo "讀不到 commit")"
  [[ -f "$WEB_DIR/.next/BUILD_ID" && -f "$WEB_DIR/dist/worker.mjs" ]] && built="有建置產物（web tree $(cat "$BUILD_MARK" 2>/dev/null || echo '?')）"
  printf '%s；%s' "$commit" "$built"
}
