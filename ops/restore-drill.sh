#!/usr/bin/env bash
# 還原演練（票 27，2026-09-24）：把某一站的備份還原到 VM 內獨立的演練副本，抽查後寫一筆紀錄。
#
#   sudo -u deploy /srv/fju/app/ops/restore-drill.sh --site test --backup latest
#   sudo -u deploy /srv/fju/app/ops/restore-drill.sh --site prod --backup fju-prod-20260924T120000Z.dump --keep --with-app
#   sudo -u deploy /srv/fju/app/ops/restore-drill.sh --remove        # 移除保留下來的演練副本
#
#   --backup <檔名|latest>  /srv/fju/<站>/backups/ 裡的備份檔（只接受該目錄裡的檔案）
#   --keep                  演練完保留副本（預設：抽查完就整個刪掉，包括 volume）
#   --with-app              也起一個 app 看畫面（用來源站目前的映像）；看法見 ops/README.md
#
# 副本是獨立的 Compose project `fju-drill`（docker-compose.drill.yml）：自己的 volume 與網路、
# 不發布 port、不接 Caddy、沒有 worker。來源站的資料庫與 volume 不會被寫入——只有在備份檔沒有
# 對應紀錄時，才會對來源站跑一次唯讀的筆數查詢當比對基準。不需要 Doppler。
#
# 紀錄寫在 /srv/fju/<站>/backups/records.jsonl（kind=drill），成功或失敗都寫。
set -euo pipefail

APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_ROOT"
# shellcheck source-path=SCRIPTDIR source=lib/site.sh
. "$APP_ROOT/ops/lib/site.sh"
# shellcheck source-path=SCRIPTDIR source=lib/backup-common.sh
. "$APP_ROOT/ops/lib/backup-common.sh"

SITE=""
BACKUP_ARG=""
KEEP=0
WITH_APP=0
REMOVE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --site) SITE="${2:-}"; shift ;;
    --site=*) SITE="${1#--site=}" ;;
    --backup) BACKUP_ARG="${2:-}"; shift ;;
    --backup=*) BACKUP_ARG="${1#--backup=}" ;;
    --keep) KEEP=1 ;;
    --with-app) WITH_APP=1 ;;
    --remove) REMOVE=1 ;;
    -h|--help) sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "不認得的參數：$1" >&2; exit 1 ;;
  esac
  shift
done

DRILL_PROJECT=fju-drill
DRILL_VOLUME=fju-drill-pgdata
DRILL_NETWORK=fju-drill
DRILL_DB=fju_drill
DRILL_SUPERUSER=fju_drill_owner
FORWARD_PORT=3999

# 絕不沿用站台的 Compose 設定：site.sh 會 export COMPOSE_FILE／COMPOSE_PROJECT_NAME，
# 那兩個一旦漏進來，下面的 docker compose 就會指到真的站。這裡全部清掉，每次都明寫 -p 與 -f。
unset COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_PROFILES FJU_SITE
drill_compose() {
  docker compose -p "$DRILL_PROJECT" -f "$APP_ROOT/docker-compose.drill.yml" "$@"
}

rand_hex() { od -An -N24 -tx1 /dev/urandom | tr -d ' \n'; }
# compose 檔裡每個變數都用 :? 擋空值；沒用到的先給佔位值，真的要用時才換成隨機值。
export DRILL_PG_PASSWORD DRILL_APP_DB_PASSWORD DRILL_AUTH_SECRET DRILL_APP_IMAGE DRILL_CLOCK_OVERRIDE
DRILL_PG_PASSWORD="$(rand_hex)"
DRILL_APP_DB_PASSWORD="$(rand_hex)"
DRILL_AUTH_SECRET="$(rand_hex)"
# 本機測試或來源站 app 沒在跑時，可用 DRILL_APP_IMAGE_OVERRIDE 指定映像。
DRILL_APP_IMAGE="${DRILL_APP_IMAGE_OVERRIDE:-unused}"
DRILL_CLOCK_OVERRIDE=false

drill_exists() {
  [ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$DRILL_PROJECT")" ] \
    || docker volume inspect "$DRILL_VOLUME" >/dev/null 2>&1
}

drill_down() {
  drill_compose --profile with-app down -v --remove-orphans >/dev/null 2>&1 || true
  # compose 找不到容器時不會刪 volume；保險起見直接刪名字寫死的那一顆（只會是 fju-drill-*）。
  docker volume rm "$DRILL_VOLUME" >/dev/null 2>&1 || true
}

if [ "$REMOVE" = 1 ]; then
  if drill_exists; then
    drill_down
    echo "✓ 已移除演練副本（$DRILL_PROJECT 的容器、網路與 volume $DRILL_VOLUME）。"
  else
    echo "沒有演練副本，不用移除。"
  fi
  exit 0
fi

[ -n "$SITE" ] || { echo "缺少 --site test|prod" >&2; exit 1; }
[ -n "$BACKUP_ARG" ] || { echo "缺少 --backup <檔名|latest>（檔案在 /srv/fju/<站>/backups/）" >&2; exit 1; }
site_setup "$SITE" "$APP_ROOT"
unset COMPOSE_FILE COMPOSE_PROJECT_NAME FJU_SITE

BACKUP_DIR="$SITE_ROOT/backups"
RECORDS="$(backup_records_file "$BACKUP_DIR")"
RECORD_TOOL="$APP_ROOT/ops/lib/backup-record.mjs"
SOURCE_PG="fju-$SITE-postgres"
SOURCE_APP="fju-$SITE-app"
# 業務時鐘覆寫沿用來源站（Doppler 的值：stg true、prd false；README 第 7 步）。
[ "$SITE" = test ] && DRILL_CLOCK_OVERRIDE=true

# ---- 找備份檔：只接受該站備份目錄裡、名字是 fju-<站>-*.dump 的檔案 ----
if [ "$BACKUP_ARG" = latest ]; then
  # 檔名帶 UTC 時間，字典序就是時間序。
  BACKUP_FILE="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name "fju-$SITE-*.dump" | sort | tail -n 1)"
  [ -n "$BACKUP_FILE" ] || { echo "$BACKUP_DIR 裡沒有 $SITE 站的備份，先跑 ops/backup.sh --site $SITE。" >&2; exit 1; }
else
  case "$BACKUP_ARG" in
    */*) BACKUP_FILE="$BACKUP_ARG" ;;
    *) BACKUP_FILE="$BACKUP_DIR/$BACKUP_ARG" ;;
  esac
fi
if [ ! -f "$BACKUP_FILE" ]; then
  echo "找不到備份檔：$BACKUP_FILE" >&2
  exit 1
fi
if [ "$(cd "$(dirname "$BACKUP_FILE")" && pwd -P)" != "$(cd "$BACKUP_DIR" && pwd -P)" ]; then
  echo "備份檔必須在 $BACKUP_DIR 裡（收到：$BACKUP_FILE）。" >&2
  exit 1
fi
BACKUP_NAME="$(basename "$BACKUP_FILE")"
case "$BACKUP_NAME" in
  "fju-$SITE-"*.dump) ;;
  *) echo "$BACKUP_NAME 不是 $SITE 站的備份檔（名字要是 fju-$SITE-<時間>.dump）。" >&2; exit 1 ;;
esac

# 上一次 --keep 的副本還在就不動它（不算一次演練，也不寫紀錄）。
if drill_exists; then
  echo "上一個演練副本還在（project $DRILL_PROJECT 或 volume $DRILL_VOLUME）。先移除：ops/restore-drill.sh --remove" >&2
  exit 1
fi

# ---- 開始：之後任何失敗都寫一筆失敗紀錄 ----
umask 077
STARTED_AT="$(utc_now)"
STEP="前置檢查"
work="$(mktemp -d "$BACKUP_DIR/.drill.XXXXXX")"
errlog="$work/stderr"
: > "$errlog"
RECORDED=0
CREATED=0
APP_STARTED=false
BASELINE=record
: > "$work/isolation.json"
: > "$work/counts.json"
: > "$work/result.json"

on_exit() {
  local code=$?
  # set -e 在「帶 2>>errlog 的函式呼叫」裡觸發時，trap 會沿用那個轉向；先換回原本的畫面輸出。
  exec 1>&4 2>&3
  if [ "$code" -ne 0 ] && [ "$RECORDED" = 0 ]; then
    local detail kept=false
    detail="$(tail -c 600 "$errlog" 2>/dev/null | tr '\n' ' ' || true)"
    if [ "$CREATED" = 1 ] && [ "$KEEP" = 1 ]; then kept=true; fi
    node "$RECORD_TOOL" append "$RECORDS" \
      kind=drill status=failed site="$SITE" file="$BACKUP_NAME" \
      started_at="$STARTED_AT" finished_at="$(utc_now)" step="$STEP" \
      baseline="$BASELINE" isolation="file:$work/isolation.json" \
      counts="file:$work/counts.json" result="file:$work/result.json" \
      kept="json:$kept" app_started="json:$APP_STARTED" \
      error="${STEP}失敗（結束碼 $code）${detail:+：$detail}" \
      || echo "（連失敗紀錄都寫不進 $RECORDS）" >&2
    echo "✗ 還原演練失敗（$STEP），已寫入失敗紀錄：$RECORDS" >&2
    [ -z "$detail" ] || echo "  錯誤：$detail" >&2
  fi
  if [ "$CREATED" = 1 ] && [ "$KEEP" = 0 ]; then
    drill_down
    [ "$code" -eq 0 ] || echo "演練副本已移除（沒帶 --keep）。" >&2
  fi
  rm -rf "$work"
}
exec 3>&2 4>&1
trap on_exit EXIT

# 換到下一步：錯誤訊息只留這一步的，失敗紀錄才看得出是哪裡壞。
step() { STEP="$1"; : > "$errlog"; }

fail() { echo "$1" | tee -a "$errlog" >&2; exit 1; }

# ---- 核對備份檔，找比對基準 ----
step "核對備份檔"
sha="$(sha256_of "$BACKUP_FILE")"
node "$RECORD_TOOL" lookup "$RECORDS" "$BACKUP_NAME" > "$work/backup-record.json"
if [ -s "$work/backup-record.json" ]; then
  node -e '
    const fs = require("fs")
    const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
    fs.writeFileSync(process.argv[2], JSON.stringify(r.counts ?? null))
    fs.writeFileSync(process.argv[3], JSON.stringify(r.counts_after ?? r.counts ?? null))
    process.stdout.write(r.sha256 ?? "")
  ' "$work/backup-record.json" "$work/base-before.json" "$work/base-after.json" > "$work/expected-sha"
  if [ "$(cat "$work/expected-sha")" != "$sha" ]; then
    fail "備份檔的 sha256 跟備份當下記的不一樣——檔案被改過或壞了，不拿它演練。"
  fi
  echo "備份檔 $BACKUP_NAME：sha256 與備份紀錄相符；比對基準＝備份當下量的筆數。"
else
  # 舊備份（這支上線前做的）沒有紀錄：退而求其次，對來源站跑一次唯讀的筆數查詢。
  # 備份之後才新增的資料會算成「對不上」，所以這種情況的結果要人看過再判斷。
  BASELINE=live
  echo "⚠️ $BACKUP_NAME 沒有備份紀錄，改用來源站「現在」的筆數當基準（唯讀查詢 $SOURCE_PG）。"
  # 單引號是刻意的：$POSTGRES_USER／$POSTGRES_DB 要在容器裡展開。
  # shellcheck disable=SC2016
  printf '%s\n' "BEGIN READ ONLY;" "$SPOT_COUNTS_SQL" "COMMIT;" \
    | docker exec -i "$SOURCE_PG" sh -c 'psql -qAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' 2>>"$errlog" \
    | grep '^{' > "$work/base-before.json"
  cp "$work/base-before.json" "$work/base-after.json"
fi

if [ "$WITH_APP" = 1 ] && [ "$DRILL_APP_IMAGE" = unused ]; then
  step "找來源站的 app 映像"
  DRILL_APP_IMAGE="$(docker inspect --format '{{.Config.Image}}' "$SOURCE_APP" 2>>"$errlog")"
  [ -n "$DRILL_APP_IMAGE" ] || fail "找不到 $SOURCE_APP 的映像；來源站的 app 要在跑才能 --with-app。"
fi

# ---- 起演練資料庫 ----
step "起演練資料庫"
CREATED=1
echo "起演練副本（project $DRILL_PROJECT，不發布 port、不接 Caddy）…"
drill_compose up -d --wait postgres >/dev/null 2>>"$errlog"

drill_psql() {
  drill_compose exec -T postgres psql -qAt -v ON_ERROR_STOP=1 -U "$DRILL_SUPERUSER" -d "$DRILL_DB" "$@"
}

# ---- 隔離核對（SOP 04 第 2 步）：還原前確認副本碰不到兩站 ----
step "隔離核對"
cid="$(drill_compose ps -q postgres)"
mounts="$(docker inspect --format '{{range .Mounts}}{{.Type}}:{{.Name}}:{{.Source}}{{"\n"}}{{end}}' "$cid")"
networks="$(docker inspect --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}' "$cid" | sed '/^$/d')"
ports="$(docker inspect --format '{{range $p, $b := .HostConfig.PortBindings}}{{$p}} {{end}}' "$cid" | tr -d ' ')"
db="$(drill_psql -c 'SELECT current_database()' 2>>"$errlog")"
mount_names=""
while IFS= read -r m; do
  [ -n "$m" ] || continue
  case "$m" in
    "volume:$DRILL_VOLUME:"*) mount_names="$mount_names $DRILL_VOLUME" ;;
    *) fail "演練副本掛到不該掛的東西：$m" ;;
  esac
done <<< "$mounts"
[ "$networks" = "$DRILL_NETWORK" ] || fail "演練副本接到其他網路：$(echo "$networks" | tr '\n' ' ')"
[ -z "$ports" ] || fail "演練副本發布了 port：$ports"
[ "$db" = "$DRILL_DB" ] || fail "連到的資料庫是 $db，不是 $DRILL_DB"
printf '{"container":"%s","volumes":"%s","networks":"%s","published_ports":"none","database":"%s"}\n' \
  "fju-drill-postgres" "${mount_names# }" "$networks" "$db" > "$work/isolation.json"
echo "✓ 隔離核對：只掛 $DRILL_VOLUME、只接網路 $DRILL_NETWORK、沒有發布 port、資料庫 $db。"

# ---- 還原 ----
step "建立備份裡用到的角色"
# pg_dump 不帶角色。先把 dump 裡出現的擁有者，以及 migration GRANT 的 fju_app／fju_backup 建好（不能登入），
# 還原出來的擁有者與權限才會跟原站一樣。
roles="$(drill_compose exec -T postgres pg_restore --list < "$BACKUP_FILE" 2>>"$errlog" \
  | awk '!/^;/ && NF > 3 { print $NF }' | grep -E '^[A-Za-z0-9_-]+$' | sort -u || true)"
{
  for role in $roles fju_app fju_backup; do
    [ "$role" = "$DRILL_SUPERUSER" ] && continue
    # 名字只可能是英數、底線、連字號（上面的 grep），放進單引號字串是安全的；%I 負責大小寫與連字號的引號。
    printf "DO \$\$BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '%s') THEN EXECUTE format('CREATE ROLE %%I NOLOGIN', '%s'); END IF; END\$\$;\n" "$role" "$role"
  done
} | drill_psql >/dev/null 2>>"$errlog"

step "pg_restore"
echo "還原 $BACKUP_NAME → 演練副本…"
drill_compose exec -T postgres pg_restore -U "$DRILL_SUPERUSER" -d "$DRILL_DB" --exit-on-error --single-transaction \
  < "$BACKUP_FILE" 2>>"$errlog"

# ---- 抽查 ----
step "抽查比對"
printf '%s\n' "$SPOT_COUNTS_SQL" | drill_psql 2>>"$errlog" | grep '^{' > "$work/counts.json"
set +e
basis_label=備份當下
[ "$BASELINE" = record ] || basis_label=來源站現在
BASELINE_LABEL="$basis_label" node "$RECORD_TOOL" compare "$work/base-before.json" "$work/counts.json" "$work/base-after.json" > "$work/result.json"
cmp_code=$?
set -e
if [ "$cmp_code" -ne 0 ]; then
  if [ "$BASELINE" = live ]; then
    fail "還原後的筆數跟來源站現在不一樣（基準是現在的資料，備份後新增的資料也會算進差異；請人工判斷）。"
  fi
  fail "還原後的筆數或回答內容跟備份當下不一樣。"
fi

# ---- 看畫面用的 app ----
if [ "$WITH_APP" = 1 ]; then
  step "起 app（看畫面用）"
  q="'"
  printf "ALTER ROLE fju_app LOGIN PASSWORD '%s';\n" "${DRILL_APP_DB_PASSWORD//$q/$q$q}" | drill_psql >/dev/null 2>>"$errlog"
  echo "起 app（映像 $DRILL_APP_IMAGE，沒有 worker）…"
  drill_compose --profile with-app up -d --wait app >/dev/null 2>>"$errlog"
  APP_STARTED=true
fi

# ---- 寫紀錄 ----
step "寫紀錄"
node "$RECORD_TOOL" append "$RECORDS" \
  kind=drill status=ok site="$SITE" file="$BACKUP_NAME" sha256="$sha" \
  started_at="$STARTED_AT" finished_at="$(utc_now)" \
  baseline="$BASELINE" isolation="file:$work/isolation.json" \
  counts="file:$work/counts.json" result="file:$work/result.json" \
  kept="json:$([ "$KEEP" = 1 ] && echo true || echo false)" app_started="json:$APP_STARTED" \
  note="只還原資料庫；附件不在備份範圍，副本裡下載附件會失敗是預期的。"
RECORDED=1
echo "✓ 還原演練成功，紀錄已寫入 $RECORDS"

if [ "$KEEP" = 1 ]; then
  echo
  echo "演練副本保留中（裡面是 $SITE 站的真實資料，看完請移除）："
  echo "  資料庫：sudo -u deploy docker exec -it fju-drill-postgres psql -U $DRILL_SUPERUSER -d $DRILL_DB"
  if [ "$APP_STARTED" = true ]; then
    ip="$(docker inspect --format "{{(index .NetworkSettings.Networks \"$DRILL_NETWORK\").IPAddress}}" fju-drill-app)"
    echo "  畫面：在自己電腦跑  ssh -N -L $FORWARD_PORT:$ip:3000 fju-vm"
    echo "        再開 http://localhost:$FORWARD_PORT/login （用帳號密碼登入；Google 登入在副本裡不能用）"
  fi
  echo "  移除：sudo -u deploy /srv/fju/app/ops/restore-drill.sh --remove"
else
  echo "演練副本已移除（要保留看畫面，下次加 --keep --with-app）。"
fi
