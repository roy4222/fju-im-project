#!/usr/bin/env bash
# 部署腳本（契約 05 §3；2026-09-24 兩站版）。預設就是 --dry-run，要真的跑必須明確帶 --execute。
#
#   ops/deploy.sh --site <test|prod> <tag> [--execute] [--rollback] [--allow-no-worker]
#
#   <tag>          GHCR 映像 tag＝完整 commit SHA（.github/workflows/image.yml 推的）
#   --site         部署到哪一站：test＝fju-test（test.fju.roy422.dev）、prod＝fju-prod（fju.roy422.dev）
#   --rollback     回滾到指定的舊 tag：跳過 migration（DB 不回滾），只換 app 與 worker
#   --execute      真的執行；沒帶就只印步驟
#   健康判定預設是完整六項（票 28）：HTTP 200、commit、imageDigest、schemaVersion、worker.version、
#   worker.lastTickAt（60 秒內）。`--expect-worker` 仍然收（舊的寫法，現在就是預設）。
#   --allow-no-worker  只判前四項、worker 兩欄必須是 null：只有回滾到票 12 之前（還沒有 worker）的
#                      舊映像才用；映像其實有 worker 心跳會判失敗
#
# 在 VM 上要用 deploy 身分跑：sudo -u deploy /srv/fju/app/ops/deploy.sh --site test <tag> --execute
# 秘密由這一站的 Doppler token 放進程序環境（ops/lib/site.sh），不寫檔、不印。
# ops/auto-deploy.sh（systemd timer）也是呼叫這支，只會帶 --site test。
#
# 步驟（契約 05 §3）：
#   1. flock 部署鎖（每站一把），拿不到就失敗（不排隊）
#   2. 記下目前版本到 previous_tag（映像參照＋digest），失敗時回滾用
#   3. docker compose pull app worker migrate（用 <tag> 組出的 APP_IMAGE）
#   4. docker compose run --rm migrate  ← 新映像；失敗即中止，舊 app 繼續跑
#      接著把 fju_app 的密碼同步成 Doppler 的 APP_DB_PASSWORD（冪等；第一次部署靠這步）
#      只有測試站：Doppler stg 有 E2E_ADMIN_EMAIL／E2E_ADMIN_PASSWORD 就建 E2E 測試管理員（冪等）
#   5. docker compose up -d --no-deps app worker
#   6. 健康判定
#   7. 寫 deploy_log
set -euo pipefail

ORIG_ARGS=("$@")
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# `sudo -u deploy` 會沿用呼叫者的目錄（例如 Roy 的家目錄，deploy 讀不到），先換到自己的目錄。
cd "$REPO_ROOT"
# shellcheck source-path=SCRIPTDIR source=lib/site.sh
. "$REPO_ROOT/ops/lib/site.sh"

HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-60}"
IMAGE_REPO="${IMAGE_REPO:-ghcr.io/roy4222/fju-web}"
COMPOSE="${COMPOSE:-docker compose}"

TAG=""
SITE=""
DRY_RUN=1
# 1＝完整六項（預設）；none＝--allow-no-worker（見 ops/check-health.mjs）。
EXPECT_WORKER=1
ROLLBACK=0

usage() {
  sed -n '2,28p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --execute) DRY_RUN=0 ;;
    --dry-run) DRY_RUN=1 ;;
    --expect-worker) ;; # 票 28 起就是預設；ops/auto-deploy.sh 的 AUTO_DEPLOY_EXPECT_WORKER=1 仍會帶它
    --allow-no-worker) EXPECT_WORKER=none ;;
    --rollback) ROLLBACK=1 ;;
    --site)
      [ $# -ge 2 ] || { echo "--site 後面要接 test 或 prod" >&2; exit 1; }
      SITE="$2"
      shift
      ;;
    --site=*) SITE="${1#--site=}" ;;
    -h|--help) usage 0 ;;
    -*) echo "不認得的選項：$1" >&2; usage 1 ;;
    *)
      if [ -n "$TAG" ]; then echo "只能給一個 tag（已經有 ${TAG}）" >&2; exit 1; fi
      TAG="$1"
      ;;
  esac
  shift
done

if [ -z "$SITE" ]; then
  echo "缺少 --site。用法：ops/deploy.sh --site <test|prod> <tag> [--execute]" >&2
  exit 1
fi
if [ -z "$TAG" ]; then
  echo "缺少 tag。用法：ops/deploy.sh --site <test|prod> <tag> [--execute] [--rollback] [--allow-no-worker]" >&2
  exit 1
fi
# tag 會被拼進映像參照與 deploy_log，只收 docker tag 合法的字元。
if ! printf '%s' "$TAG" | grep -Eq '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$'; then
  echo "tag 格式不對：$TAG" >&2
  exit 1
fi

# 真的執行才會寫 /srv/fju（部署鎖、previous_tag、deploy_log）：先擋掉非 deploy 身分。
# 演練（dry-run）什麼都不寫，任何人都能跑。
if [ "$DRY_RUN" = 0 ]; then
  require_deploy_user "$REPO_ROOT/ops/deploy.sh ${ORIG_ARGS[*]:-}"
fi

site_setup "$SITE" "$REPO_ROOT"

# 真的執行時，先進到這一站的 Doppler 環境再重跑自己（只會發生一次）。
if [ "$DRY_RUN" = 0 ] && [ "${FJU_SECRETS_LOADED:-}" != "$SITE" ]; then
  # 用絕對路徑：上面已經 cd 過，相對路徑的 $0 在這裡會找不到自己。
  site_exec_with_secrets bash "$REPO_ROOT/ops/deploy.sh" "${ORIG_ARGS[@]}"
fi
if [ "$DRY_RUN" = 0 ]; then
  site_verify_secrets
fi

DEPLOY_DIR="${DEPLOY_DIR:-$SITE_ROOT/deploy}"
LOCK_FILE="$DEPLOY_DIR/deploy.lock"
PREVIOUS_FILE="$DEPLOY_DIR/previous_tag"
DEPLOY_LOG="$DEPLOY_DIR/deploy_log"
# 健康檢查走 Caddy（跟使用者看到的一樣，含 TLS），但直接連本機，不繞 DNS。
if [ -n "${HEALTH_URL:-}" ]; then
  HEALTH_CURL_ARGS=()
else
  HEALTH_URL="https://$SITE_HOST/api/health"
  HEALTH_CURL_ARGS=(--resolve "$SITE_HOST:443:127.0.0.1")
fi

# 這一次要部署的映像。Compose 的 app、worker、migrate 都吃這個變數，
# 所以 <tag> 真的會決定跑起來的是哪一版——不是只拿去比對健康狀態。
APP_IMAGE="$IMAGE_REPO:$TAG"
export APP_IMAGE

log() { printf '%s\n' "$*"; }
step() { printf '[%s] %s\n' "$([ "$DRY_RUN" = 1 ] && echo 'dry-run' || echo 'execute')" "$*"; }
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '        $ %s\n' "$*"
  else
    "$@"
  fi
}

# 從本機映像讀出 registry digest。/api/health 的 imageDigest 是執行期由環境變數帶進容器的
# （digest 要 push 之後才知道，沒辦法在 build 時烤進映像）。
image_digest() {
  docker image inspect --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}' "$1" 2>/dev/null || true
}

log "站台：${SITE}（Compose project ${COMPOSE_PROJECT_NAME}、${SITE_HOST}、Doppler ${SITE_DOPPLER_CONFIG}）"
log "部署 tag：$TAG$([ "$ROLLBACK" = 1 ] && echo '（回滾模式）')"
log "映像：$APP_IMAGE"
log "健康檢查端點：${HEALTH_URL}（逾時 ${HEALTH_TIMEOUT_SECONDS}s）"
if [ "$EXPECT_WORKER" = 1 ]; then
  log "健康條件：完整六項（HTTP 200、commit、imageDigest、schemaVersion、worker.version、worker.lastTickAt 在 60 秒內）"
else
  log "健康條件：有限四項（HTTP 200、commit、imageDigest、schemaVersion）且 worker 兩欄必須是 null（--allow-no-worker：只給還沒有 worker 的舊映像）"
fi
if [ "$DRY_RUN" = 1 ]; then
  log "秘密：執行時以 $SITE_TOKEN_FILE 的 Doppler token 跑 doppler run --no-fallback（不寫檔、不印值）"
fi
log ""

if [ "$DRY_RUN" = 0 ]; then
  mkdir -p "$DEPLOY_DIR"
fi

# ── 1. 部署鎖 ──────────────────────────────────────────────
step '1/7 取得部署鎖（flock，拿不到就失敗，不排隊）'
if [ "$DRY_RUN" = 1 ]; then
  printf '        $ flock --nonblock %s -c "<以下步驟>"\n' "$LOCK_FILE"
else
  exec 9>"$LOCK_FILE"
  if ! flock --nonblock 9; then
    echo "拿不到部署鎖 ${LOCK_FILE}，可能有另一次部署正在跑。" >&2
    # 75＝EX_TEMPFAIL：ops/auto-deploy.sh 看到它就知道「這次沒部署、下一輪再試」。
    exit 75
  fi
fi

# ── 2. 記下目前版本 ────────────────────────────────────────
step "2/7 記下目前版本到 ${PREVIOUS_FILE}（映像參照＋digest）"
if [ "$DRY_RUN" = 1 ]; then
  printf '        $ 讀目前 app 容器的映像與 digest，寫成 PREVIOUS_APP_IMAGE／PREVIOUS_IMAGE_DIGEST\n'
else
  previous_image="$($COMPOSE ps --format '{{.Image}}' app 2>/dev/null | head -1)"
  if [ -n "$previous_image" ]; then
    {
      printf 'PREVIOUS_APP_IMAGE=%q\n' "$previous_image"
      printf 'PREVIOUS_IMAGE_DIGEST=%q\n' "$(image_digest "$previous_image")"
    } > "$PREVIOUS_FILE"
    log "        目前版本：$previous_image"
  else
    # 第一次部署，沒有前一版可以回滾。
    : > "$PREVIOUS_FILE"
    log "        目前沒有在跑的 app，這是第一次部署（失敗時沒有可回滾的版本）"
  fi
fi

# ── 3. 拉新映像 ────────────────────────────────────────────
step '3/7 拉新映像'
if [ "$ROLLBACK" = 1 ]; then
  # 回滾不跑 migration，不需要 migrate 的映像。
  run $COMPOSE pull app worker
else
  run $COMPOSE pull app worker migrate
fi

NEW_DIGEST=""
if [ "$DRY_RUN" = 0 ]; then
  NEW_DIGEST="$(image_digest "$APP_IMAGE")"
  log "        digest：${NEW_DIGEST:-（本機建的映像沒有 registry digest）}"
fi
# app 與 worker 靠這個環境變數回報 imageDigest（契約 05 §1）。
export IMAGE_DIGEST="$NEW_DIGEST"

# 把 fju_app 的密碼設成 Doppler 的 APP_DB_PASSWORD。migration 只建角色、不設密碼
# （密碼是維運的事），第一次部署少了這步 app 會連不上資料庫。每次都做，冪等。
# SQL 從 stdin 餵給容器裡的 psql：密碼不會出現在任何指令列（ps 看不到），也不會印出來。
sync_app_db_password() {
  # 單引號雙寫。用變數而不是 \' 跳脫：bash 3.2 與 5.x 對替換字串裡的反斜線處理不同。
  local q="'"
  local escaped="${APP_DB_PASSWORD//$q/$q$q}"
  # 單引號是刻意的：${POSTGRES_USER}／$POSTGRES_DB 要在容器裡展開。
  # shellcheck disable=SC2016
  printf "ALTER ROLE fju_app PASSWORD '%s';\n" "$escaped" \
    | $COMPOSE exec -T postgres sh -c 'psql -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null
}

# 測試站的 E2E 測試管理員（票 3b）。回傳 0＝建好／已存在／略過，非 0＝seed 失敗（呼叫端只警告，不中止部署）。
# 正式站一律不建：這裡寫死只認 test，web/scripts/seed-e2e.mjs 也會自己檢查 FJU_SITE（兩道鎖）。
# 值用 `-e 名稱` 從環境轉交，不進指令列、不印出來（跟 ops/seed-admin.sh 一樣）。
seed_e2e_admin() {
  if [ "$SITE" != test ]; then
    if [ -n "${E2E_ADMIN_EMAIL:-}" ] || [ -n "${E2E_ADMIN_PASSWORD:-}" ]; then
      log "        E2E 測試帳號：$SITE 站一律不建（Doppler $SITE_DOPPLER_CONFIG 不該有 E2E_ADMIN_* 鍵，請刪掉）"
    fi
    return 0
  fi
  if [ -z "${E2E_ADMIN_EMAIL:-}" ] || [ -z "${E2E_ADMIN_PASSWORD:-}" ]; then
    log "        E2E 測試帳號：略過（Doppler $SITE_DOPPLER_CONFIG 沒有 E2E_ADMIN_EMAIL／E2E_ADMIN_PASSWORD）"
    return 0
  fi
  $COMPOSE run --rm --no-deps -e E2E_ADMIN_EMAIL -e E2E_ADMIN_PASSWORD -e FJU_SITE \
    migrate node migrate/web/scripts/seed-e2e.mjs
}

# ── 4. 先跑 migration ──────────────────────────────────────
NEW_SCHEMA=""
if [ "$ROLLBACK" = 1 ]; then
  step '4/7 略過 migration（回滾模式：DB 依 expand／contract 不回滾，舊映像的 migrator 不能跑）'
  if [ "$DRY_RUN" = 1 ]; then
    printf '        # 不跑 migrate 服務；健康判定不比對 schemaVersion（DB 維持目前的 schema）\n'
  fi
else
  step '4/7 用新映像跑 migration（失敗即中止，舊 app 繼續跑）'
  if [ "$DRY_RUN" = 1 ]; then
    printf '        $ %s run --rm migrate  # 從輸出取最後一支 migration 名稱\n' "$COMPOSE"
    printf '        $ （stdin）ALTER ROLE fju_app PASSWORD <APP_DB_PASSWORD> | %s exec -T postgres psql\n' "$COMPOSE"
    if [ "$SITE" = test ]; then
      printf '        $ %s run --rm --no-deps -e E2E_ADMIN_EMAIL -e E2E_ADMIN_PASSWORD -e FJU_SITE migrate node migrate/web/scripts/seed-e2e.mjs  # Doppler 有這兩個鍵才跑\n' "$COMPOSE"
    else
      printf '        # E2E 測試帳號：正式站一律不建\n'
    fi
  else
    migrate_output="$($COMPOSE run --rm migrate)"
    printf '%s\n' "$migrate_output"
    # migrate.mjs 會印一行 `SCHEMA_VERSION=<最後一支 migration>`，健康判定用它比對。
    NEW_SCHEMA="$(printf '%s\n' "$migrate_output" | sed -n 's/^SCHEMA_VERSION=//p' | tail -1)"
    if [ -z "$NEW_SCHEMA" ]; then
      echo "migrate 沒有輸出 SCHEMA_VERSION，無法比對 schemaVersion，中止。" >&2
      exit 1
    fi
    log "        schema：$NEW_SCHEMA"
    if ! sync_app_db_password; then
      echo "同步 fju_app 密碼失敗，中止（舊 app 繼續跑）。" >&2
      exit 1
    fi
    log "        fju_app 密碼已同步成 Doppler 的 APP_DB_PASSWORD"
    # 測試帳號只是驗收的方便，失敗不擋部署：印警告、記 deploy_log，照常往下。
    # （若中止，auto-deploy 會把這個 SHA 記成失敗、不再重試，整個測試站就卡住；
    #   舊 SHA 的映像沒有 seed-e2e.mjs 時也會失敗。）用 if 攔下來，set -e 才不會直接把腳本帶走。
    if ! seed_e2e_admin; then
      echo "⚠️ 建立 E2E 測試管理員失敗（部署照常繼續；看上面 seed-e2e 的訊息，多半是 Doppler stg 的 E2E_ADMIN_* 不對）。" >&2
      printf '%s\te2e-seed-failed\t%s\n' "$(date -u +%FT%TZ)" "$TAG" >> "$DEPLOY_LOG"
    fi
  fi
fi

# ── 5. 換上新版 ────────────────────────────────────────────
step "5/7 啟動$([ "$ROLLBACK" = 1 ] && echo '指定的舊版' || echo '新版') app 與 worker"
if [ "$DRY_RUN" = 1 ]; then
  printf '        $ %s up -d postgres\n' "$COMPOSE"
  printf '        $ %s up -d --no-deps app worker  # --no-deps：不讓 depends_on 帶起 migrate\n' "$COMPOSE"
fi

# 跑一輪健康判定；符合回 0。呼叫時帶要比對的期望值。
await_health() {
  local expect_tag="$1" expect_digest="$2" expect_schema="$3" expect_worker="$4"
  local deadline body
  deadline=$(( $(date +%s) + HEALTH_TIMEOUT_SECONDS ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    body="$(curl -sf --max-time 5 ${HEALTH_CURL_ARGS[@]+"${HEALTH_CURL_ARGS[@]}"} "$HEALTH_URL" || true)"
    if [ -n "$body" ] && HEALTH_JSON="$body" \
      EXPECT_TAG="$expect_tag" EXPECT_DIGEST="$expect_digest" \
      EXPECT_SCHEMA="$expect_schema" EXPECT_WORKER="$expect_worker" \
      node "$REPO_ROOT/ops/check-health.mjs"; then
      return 0
    fi
    sleep 2
  done
  return 1
}

# 補償流程：啟動失敗與健康失敗共用這一條。
# $1 是失敗原因，只用來寫 deploy_log 與訊息。
compensate() {
  local reason="$1"
  echo "部署失敗（${reason}），回滾到 $PREVIOUS_FILE 記的版本。" >&2
  printf '%s\trollback-start\t%s\t%s\n' "$(date -u +%FT%TZ)" "$TAG" "$reason" >> "$DEPLOY_LOG"

  if [ ! -s "$PREVIOUS_FILE" ]; then
    printf '%s\trollback-skipped\tno-previous\t%s\n' "$(date -u +%FT%TZ)" "$reason" >> "$DEPLOY_LOG"
    echo "沒有可回滾的版本（第一次部署）——需要人介入。" >&2
    exit 1
  fi

  # shellcheck disable=SC1090
  . "$PREVIOUS_FILE"
  APP_IMAGE="$PREVIOUS_APP_IMAGE"
  IMAGE_DIGEST="$PREVIOUS_IMAGE_DIGEST"
  export APP_IMAGE IMAGE_DIGEST
  log "回滾到 $APP_IMAGE"

  # --no-deps：只重建 app 與 worker。跟著 depends_on 會用**舊映像的 migrator**
  # 把 schema_meta 寫回舊 journal 的版本（DB 依 expand／contract 不回滾，schema 應該維持新的）。
  $COMPOSE up -d --no-deps app worker || true

  # 舊 app 要能在新 schema 上跑，所以 schemaVersion 仍然比對 migrate 這次輸出的值
  # （回滾模式沒跑 migrate，NEW_SCHEMA 是空的＝不比對）；commit 不比對（回滾目標是前一版）。
  if await_health "" "$PREVIOUS_IMAGE_DIGEST" "$NEW_SCHEMA" "$EXPECT_WORKER"; then
    printf '%s\trollback-done\t%s\thealthy\t%s\n' "$(date -u +%FT%TZ)" "$APP_IMAGE" "$reason" >> "$DEPLOY_LOG"
    echo "已回滾到 $APP_IMAGE 且健康判定通過。" >&2
  else
    printf '%s\trollback-done\t%s\tunhealthy\t%s\n' "$(date -u +%FT%TZ)" "$APP_IMAGE" "$reason" >> "$DEPLOY_LOG"
    echo "回滾後健康判定仍不通過——需要人介入。" >&2
  fi
  exit 1
}

# ── 6. 健康判定 ────────────────────────────────────────────
if [ "$DRY_RUN" = 1 ]; then
  step "6/7 健康判定（${HEALTH_TIMEOUT_SECONDS} 秒內要全部符合）"
  printf '        $ curl -sf %s %s\n' "${HEALTH_CURL_ARGS[*]:-}" "$HEALTH_URL"
  if [ "$ROLLBACK" = 1 ]; then
    printf '        $ node ops/check-health.mjs  # 比對 commit=<tag>、imageDigest=<pull 到的 digest>；schemaVersion 不比對（回滾模式）\n'
  else
    printf '        $ node ops/check-health.mjs  # 比對 commit=<tag>、imageDigest=<pull 到的 digest>、schemaVersion=<migrate 輸出>%s\n' \
      "$([ "$EXPECT_WORKER" = 1 ] && echo '、worker.version=<tag>、worker.lastTickAt 在 60 秒內' || echo '；worker 兩欄必須是 null（--allow-no-worker）')"
  fi
  printf '        # 第 5 步啟動失敗或本步健康失敗 → 同一條補償流程：回滾 + 重跑健康判定 + 寫 deploy_log\n'
else
  # postgres 先確保在跑（app 與 worker 用 --no-deps 起，不會幫忙帶它起來）。
  if ! $COMPOSE up -d postgres; then
    compensate 'postgres-start-failed'
  fi
  # set -e 之下，這一行失敗會直接把腳本帶走；用 if 攔下來走補償流程（review R4）。
  if ! $COMPOSE up -d --no-deps app worker; then
    compensate 'start-failed'
  fi

  step "6/7 健康判定（${HEALTH_TIMEOUT_SECONDS} 秒內要全部符合）"
  if ! await_health "$TAG" "$NEW_DIGEST" "$NEW_SCHEMA" "$EXPECT_WORKER"; then
    compensate 'health-failed'
  fi
fi

# ── 7. 記錄 ────────────────────────────────────────────────
step "7/7 寫 deploy_log（${DEPLOY_LOG}）"
condition="$([ "$EXPECT_WORKER" = 1 ] && echo 'full' || echo 'limited-no-worker')"
event="$([ "$ROLLBACK" = 1 ] && echo 'rolled-back' || echo 'deployed')"
if [ "$DRY_RUN" = 1 ]; then
  printf '        $ echo "<時間>\t%s\t%s\t%s" >> %s\n' "$event" "$TAG" "$condition" "$DEPLOY_LOG"
else
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$(date -u +%FT%TZ)" "$event" "$TAG" "$condition" "${NEW_DIGEST:-none}" "${NEW_SCHEMA:-unchanged}" >> "$DEPLOY_LOG"
fi

log ""
if [ "$DRY_RUN" = 1 ]; then
  log "這是演練，什麼都沒有執行。要真的部署請加 --execute（在 VM 上以 deploy 身分執行）。"
else
  log "部署完成：$SITE ← ${TAG}（${event}，健康條件：${condition}）"
fi
