#!/usr/bin/env bash
# 在某一站的環境裡執行指令（兩站版，2026-09-24）。要用 deploy 身分跑。
#
#   ops/site.sh <test|prod> <指令…>
#
# 例：
#   sudo -u deploy /srv/fju/app/ops/site.sh test docker compose ps
#   sudo -u deploy /srv/fju/app/ops/site.sh test docker compose logs --tail 100 app
#   sudo -u deploy /srv/fju/app/ops/site.sh prod docker compose restart app
#   sudo -u deploy /srv/fju/app/ops/site.sh test check     # 只核對 token 與鍵名，不印值
#
# 它會設好 COMPOSE_FILE／COMPOSE_PROJECT_NAME／FJU_SITE，再用這一站的 Doppler token
# 把秘密放進環境（見 ops/lib/site.sh），所以 docker compose 不用帶任何 -f 或 -p。
#
# 會把秘密印出來的指令一律擋掉：`docker compose config`、`env`、`printenv`、`docker compose exec … env`
# 之類。要看 resolved config 用 `sudo bash ops/vm-setup.sh --check`（假值）。
set -euo pipefail

APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# `sudo -u deploy` 會沿用呼叫者的目錄（deploy 可能讀不到），先換到自己的目錄。
cd "$APP_ROOT"
# shellcheck source-path=SCRIPTDIR source=lib/site.sh
. "$APP_ROOT/ops/lib/site.sh"

if [ $# -lt 2 ]; then
  sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 1
fi

# 跟其他 ops 腳本一樣先擋掉非 deploy 身分（見 ops/lib/site.sh）；
# 就算沒擋，後面 token 檔的擁有者檢查也會停，這裡只是讓訊息一致、更早。
require_deploy_user "$APP_ROOT/ops/site.sh $*"

SITE="$1"
shift
site_setup "$SITE" "$APP_ROOT"

# 擋掉會把環境（＝秘密）印到螢幕上的指令。這是防手滑，不是安全邊界。
for arg in "$@"; do
  case "$arg" in
    config|env|printenv|set|export)
      echo "「${arg}」會把秘密印出來，ops/site.sh 不執行它。" >&2
      echo "要看 compose 的合併結果：sudo bash $APP_ROOT/ops/vm-setup.sh --check（用假值）。" >&2
      exit 1
      ;;
  esac
done

if [ "${FJU_SECRETS_LOADED:-}" != "$SITE" ]; then
  site_exec_with_secrets bash "$APP_ROOT/ops/site.sh" "$SITE" "$@"
fi

site_verify_secrets

if [ "$1" = check ]; then
  echo "✓ $SITE 站：token 對應 Doppler config ${SITE_DOPPLER_CONFIG}，必要的 ${#FJU_REQUIRED_SECRETS[@]} 個鍵都有值。"
  exit 0
fi

cd "$APP_ROOT"
exec "$@"
