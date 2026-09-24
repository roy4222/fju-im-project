#!/usr/bin/env bash
# 建立某一站的第一位管理員 A1（web/scripts/seed-a1.mjs；2026-09-24）。要用 deploy 身分跑：
#
#   sudo -u deploy /srv/fju/app/ops/seed-admin.sh test
#   sudo -u deploy /srv/fju/app/ops/seed-admin.sh prod
#
# 每站在第一次部署成功之後跑一次。重跑是安全的：seed-a1 看到同一個 A1_EMAIL 已存在就什麼都不做
# （不改密碼、不改角色），只印「A1 已存在」。要重發一次性密碼請走系辦的「臨時密碼」功能。
#
# 做法：
#   - 秘密跟部署同一把 Doppler token（ops/lib/site.sh）：A1_EMAIL、A1_INITIAL_PASSWORD、
#     A1_NAME（可省略）與 owner 連線 DATABASE_URL_OWNER，只存在程序環境，不寫檔。
#   - 用這一站**目前正在跑的**映像，在 migrate 服務的容器裡執行 seed-a1.mjs
#     （它只拿得到 owner 連線；A1_* 用 `-e 名稱` 從環境轉交，值不會出現在指令列）。
#     VM 上不需要 node 以外的東西，也不裝 pnpm。
#   - 拿這一站的部署鎖，不會跟部署同時進行。
#   - 輸出只有 seed-a1 自己的「已建立／已存在」，不印任何秘密值（連 email 也不印）。
set -euo pipefail

ORIG_ARGS=("$@")
APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# `sudo -u deploy` 會沿用呼叫者的目錄（deploy 可能讀不到），先換到自己的目錄。
cd "$APP_ROOT"
# shellcheck source-path=SCRIPTDIR source=lib/site.sh
. "$APP_ROOT/ops/lib/site.sh"

SITE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --site) SITE="${2:-}"; shift ;;
    --site=*) SITE="${1#--site=}" ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "不認得的選項：$1" >&2; exit 1 ;;
    *)
      [ -z "$SITE" ] || { echo "只能指定一個站（已經有 ${SITE}）" >&2; exit 1; }
      SITE="$1"
      ;;
  esac
  shift
done
[ -n "$SITE" ] || { echo "用法：ops/seed-admin.sh <test|prod>" >&2; exit 1; }
# 在 mkdir／鎖檔之前擋掉非 deploy 身分（見 ops/lib/site.sh）。
require_deploy_user "$APP_ROOT/ops/seed-admin.sh ${ORIG_ARGS[*]:-}"
site_setup "$SITE" "$APP_ROOT"

if [ "${FJU_SECRETS_LOADED:-}" != "$SITE" ]; then
  site_exec_with_secrets bash "$APP_ROOT/ops/seed-admin.sh" "${ORIG_ARGS[@]}"
fi
site_verify_secrets

missing=()
for name in A1_EMAIL A1_INITIAL_PASSWORD; do
  [ -n "${!name:-}" ] || missing+=("$name")
done
if [ "${#missing[@]}" -gt 0 ]; then
  echo "Doppler $SITE_DOPPLER_CONFIG 少了這些鍵（或值是空的）：${missing[*]}" >&2
  exit 1
fi

# 用這一站正在跑的 app 映像（跟資料庫 schema 對得上）；還沒部署就停。
APP_IMAGE="$(docker inspect --format '{{.Config.Image}}' "fju-$SITE-app" 2>/dev/null || true)"
if [ -z "$APP_IMAGE" ]; then
  echo "$SITE 站還沒有在跑的 app（fju-$SITE-app）——先完成第一次部署（ops/deploy.sh --site $SITE <SHA> --execute）。" >&2
  exit 1
fi
export APP_IMAGE

DEPLOY_DIR="${DEPLOY_DIR:-$SITE_ROOT/deploy}"
mkdir -p "$DEPLOY_DIR"
exec 9>"$DEPLOY_DIR/deploy.lock"
if ! flock --nonblock 9; then
  echo "$SITE 站正在部署（拿不到 $DEPLOY_DIR/deploy.lock），等部署結束再跑。" >&2
  exit 75
fi

echo "在 $SITE 站（${COMPOSE_PROJECT_NAME}，映像 ${APP_IMAGE}）建立 A1……"
# --no-deps：postgres 已經隨 app 在跑；不讓 depends_on 去碰其他服務。
# -e 名稱（不帶值）：Compose 從目前環境轉交，值不進指令列。
docker compose run --rm --no-deps \
  -e A1_EMAIL -e A1_INITIAL_PASSWORD ${A1_NAME:+-e A1_NAME} \
  migrate node migrate/web/scripts/seed-a1.mjs
