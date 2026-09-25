#!/usr/bin/env bash
# 測試站示範資料（web/scripts/seed-demo.mjs；票 32，#281）。要用 deploy 身分跑：
#
#   sudo -u deploy /srv/fju/app/ops/seed-demo.sh test            建立（已存在就不動）
#   sudo -u deploy /srv/fju/app/ops/seed-demo.sh test --remove   全部清掉，並讓之後的自動部署不再重建
#
# 平常不用手動跑：ops/deploy.sh --site test 每次部署都會跑一次「建立」（已存在就不動）。
# 這支是給兩種情況：
#   - 清掉示範資料（--remove）：同時留下 /srv/fju/test/deploy/demo-seed.off，自動部署看到它就略過。
#   - 清掉之後想再建回來：不帶 --remove 跑一次，會先拿掉 demo-seed.off 再建。
#
# 只認 test；prod 一律拒絕（seed-demo.mjs 自己也會檢查 FJU_SITE，兩道鎖）。
# 用這一站**目前正在跑的**映像，在 migrate 服務的容器裡執行（owner 連線；附件目錄掛進去寫／刪封面與附件）。
# 拿這一站的部署鎖，不會跟部署同時進行。輸出只有 seed-demo 自己的摘要，不印任何秘密值。
set -euo pipefail

ORIG_ARGS=("$@")
APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# `sudo -u deploy` 會沿用呼叫者的目錄（deploy 可能讀不到），先換到自己的目錄。
cd "$APP_ROOT"
# shellcheck source-path=SCRIPTDIR source=lib/site.sh
. "$APP_ROOT/ops/lib/site.sh"

SITE=""
REMOVE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --remove) REMOVE=1 ;;
    -h|--help) sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "不認得的選項：$1" >&2; exit 1 ;;
    *)
      [ -z "$SITE" ] || { echo "只能指定一個站（已經有 ${SITE}）" >&2; exit 1; }
      SITE="$1"
      ;;
  esac
  shift
done
[ -n "$SITE" ] || { echo "用法：ops/seed-demo.sh test [--remove]" >&2; exit 1; }
# 在碰任何東西之前擋掉正式站。
if [ "$SITE" != test ]; then
  echo "示範資料只放在測試站；「${SITE}」一律拒絕。" >&2
  exit 1
fi
# 在 mkdir／鎖檔之前擋掉非 deploy 身分（見 ops/lib/site.sh）。
require_deploy_user "$APP_ROOT/ops/seed-demo.sh ${ORIG_ARGS[*]:-}"
site_setup "$SITE" "$APP_ROOT"

if [ "${FJU_SECRETS_LOADED:-}" != "$SITE" ]; then
  site_exec_with_secrets bash "$APP_ROOT/ops/seed-demo.sh" "${ORIG_ARGS[@]}"
fi
site_verify_secrets

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

OFF_FILE="$DEPLOY_DIR/demo-seed.off"
args=()
if [ "$REMOVE" = 1 ]; then
  args=(--remove)
  echo "清除 $SITE 站的示範資料（${COMPOSE_PROJECT_NAME}，映像 ${APP_IMAGE}）……"
else
  echo "建立 $SITE 站的示範資料（${COMPOSE_PROJECT_NAME}，映像 ${APP_IMAGE}）……"
  rm -f "$OFF_FILE"
fi

# --no-deps：postgres 已經隨 app 在跑。-e 名稱（不帶值）：Compose 從目前環境轉交，值不進指令列。
docker compose run --rm --no-deps -e FJU_SITE -e FILES_ROOT -v "$SITE_ROOT/files:$FILES_ROOT" \
  migrate node migrate/web/scripts/seed-demo.mjs ${args[@]+"${args[@]}"}

if [ "$REMOVE" = 1 ]; then
  : > "$OFF_FILE"
  echo "已留下 ${OFF_FILE}：之後的自動部署不會再建示範資料（要建回來：ops/seed-demo.sh test）。"
fi
