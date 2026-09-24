#!/usr/bin/env bash
# 故障演練的本機模擬（票 28）。💻 在自己的電腦跑，不碰 VM、不需要 Doppler。
#
#   ops/fault-drill-local.sh [--image <映像>] [--keep] [演練…]
#
#   --image   要演練的映像（預設 fju-web:faultsim；先用 docker build 建好，見 ops/README.md）
#   --keep    跑完不要拆掉模擬站（要自己看畫面時用；之後再跑一次不帶 --keep 就會拆）
#   演練      restart、worker-stall、poison、disk80、disk80-restore；不給就五個照順序全跑
#             （worker-stall 會真的等 5 分多鐘，那是 /api/health 判定停擺的門檻）
#
# 做什麼：用 docker-compose.faultsim.yml 起一個獨立的模擬站（fju-faultsim-*，跟本機開發的
# fju-postgres 完全分開），跑 migration、設 fju_app 密碼、起 app 與 worker，再對它執行
# **跟 VM 上一樣的** ops/fault-drill.sh --site test <演練> --execute。差別只有：
#   - docker compose 指向模擬站；健康檢查打 http://127.0.0.1:<port>/api/health（不經 Caddy）
#   - 紀錄寫在暫存目錄（最後印出來）；秘密是假值；身分守門用目前的帳號當 deploy
#   - 本機沒有 flock（macOS）時放一個不做事的替身：模擬站沒有別人會部署
set -euo pipefail

APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_ROOT"

IMAGE="fju-web:faultsim"
KEEP=0
CASES=()
while [ $# -gt 0 ]; do
  case "$1" in
    --image) IMAGE="${2:?--image 後面要接映像名稱}"; shift ;;
    --keep) KEEP=1 ;;
    -h|--help) sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "不認得的選項：$1" >&2; exit 1 ;;
    *) CASES+=("$1") ;;
  esac
  shift
done
[ "${#CASES[@]}" -gt 0 ] || CASES=(restart worker-stall poison disk80 disk80-restore)

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "找不到映像 ${IMAGE}。先建：docker build -f web/Dockerfile --build-arg GIT_COMMIT=faultsim -t ${IMAGE} ." >&2
  exit 1
fi

export FAULTSIM_IMAGE="$IMAGE"
export FAULTSIM_PORT="${FAULTSIM_PORT:-3928}"
# -p 一定要寫：fault-drill.sh 會 export COMPOSE_PROJECT_NAME=fju-test（ops/lib/site.sh），
# 那個環境變數比 Compose 檔裡的 name: 優先；只有 -p 蓋得過它。
COMPOSE="docker compose -p fju-faultsim -f $APP_ROOT/docker-compose.faultsim.yml"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/fju-faultsim.XXXXXX")"

# shellcheck disable=SC2329  # 由下面的 trap 在結束時呼叫。
teardown() {
  if [ "$KEEP" = 1 ]; then
    echo "模擬站保留著（--keep）：http://127.0.0.1:${FAULTSIM_PORT}。拆掉：$COMPOSE down -v"
  else
    $COMPOSE down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
}
trap teardown EXIT

echo "== 起模擬站（映像 ${IMAGE}）"
$COMPOSE down -v --remove-orphans >/dev/null 2>&1 || true
$COMPOSE up -d postgres
$COMPOSE run --rm migrate | tail -2
# 跟 deploy.sh 一樣：migration 只建角色不設密碼，這裡把 fju_app 的密碼設成模擬站的假值。
# shellcheck disable=SC2016  # ${POSTGRES_USER}／${POSTGRES_DB} 要在容器裡展開。
printf "ALTER ROLE fju_app PASSWORD 'faultsim_app';\n" \
  | $COMPOSE exec -T postgres sh -c 'psql -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
$COMPOSE up -d --no-deps app worker

HEALTH_URL="http://127.0.0.1:${FAULTSIM_PORT}/api/health"
echo "== 等 ${HEALTH_URL} 完整六項通過"
commit="$(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$IMAGE" | sed -n 's/^GIT_COMMIT=//p' | head -1)"
for _ in $(seq 1 60); do
  body="$(curl -sf --max-time 3 "$HEALTH_URL" || true)"
  if [ -n "$body" ] && HEALTH_JSON="$body" EXPECT_TAG="$commit" node ops/check-health.mjs >/dev/null 2>&1; then
    echo "   健康：$body"
    break
  fi
  sleep 2
done

# macOS 沒有 flock：放一個永遠拿得到鎖的替身（模擬站沒有別的部署會搶）。
mkdir -p "$WORK/bin"
if ! command -v flock >/dev/null 2>&1; then
  printf '#!/bin/sh\nexit 0\n' > "$WORK/bin/flock"
  chmod +x "$WORK/bin/flock"
fi

# 已經「在 Doppler 環境裡」的樣子（ops/lib/site.sh）：必要的鍵給假值，fault-drill.sh 就不會去找 token。
drill_env=(
  PATH="$WORK/bin:$PATH"
  FJU_SECRETS_LOADED=test
  FJU_DEPLOY_USER="$(id -un)"
  COMPOSE="$COMPOSE"
  HEALTH_URL="$HEALTH_URL"
  DRILL_DIR="$WORK/drills"
  DEPLOY_DIR="$WORK/deploy"
  DRILL_VOLUME=fju-faultsim-drill-disk80
  POSTGRES_USER=x POSTGRES_PASSWORD=x POSTGRES_DB=x DATABASE_URL=x DATABASE_URL_OWNER=x APP_DB_PASSWORD=x
  BETTER_AUTH_SECRET=x BETTER_AUTH_URL=x GOOGLE_CLIENT_ID=x GOOGLE_CLIENT_SECRET=x
  FILES_ROOT=/srv/fju/files FILE_MAX_BYTES=104857600 BUSINESS_CLOCK_OVERRIDE_ENABLED=true
)

failed=0
for drill in "${CASES[@]}"; do
  echo "== 演練：${drill}"
  env "${drill_env[@]}" bash "$APP_ROOT/ops/fault-drill.sh" --site test "$drill" --execute || failed=1
done

echo "== 演練紀錄（$WORK/drills/fault-drills.log）"
cat "$WORK/drills/fault-drills.log" 2>/dev/null || echo "（沒有紀錄）"
exit "$failed"
