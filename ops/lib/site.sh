# shellcheck shell=bash
# 兩站共用設定（2026-09-24 兩站版）。由 ops/site.sh、ops/deploy.sh、ops/backup.sh、
# ops/auto-deploy.sh 用 `. ops/lib/site.sh` 載入，不單獨執行。
#
#   站台   Compose project   網址                     Doppler config
#   test   fju-test          test.fju.roy422.dev      stg
#   prod   fju-prod          fju.roy422.dev           prd
#
# 秘密怎麼進來（Doppler 唯讀 service token，每站一把）：
#   1. token 放在 $FJU_SECRETS_DIR/doppler-<站台>.token（deploy 擁有、600），Roy 親自貼。
#   2. site_exec_with_secrets 把 token 放進 DOPPLER_TOKEN **環境變數**（不進指令列，
#      `ps` 看不到），交給 `doppler run --no-fallback`：秘密只存在這一個程序樹的環境裡，
#      不寫檔、不留 Doppler 的加密快取。
#   3. doppler 再去執行真正的指令；DOPPLER_TOKEN 在這裡被 `env -u` 拿掉，
#      之後的 docker compose 與容器都看不到 token。
#   4. 容器拿到哪些秘密由 docker-compose.vm.yml 逐項列出，不是整包給。
# 本檔任何地方都不印秘密的值；缺東西時只印鍵名。

FJU_ROOT="${FJU_ROOT:-/srv/fju}"
FJU_SECRETS_DIR="${FJU_SECRETS_DIR:-$FJU_ROOT/secrets}"
FJU_DOPPLER_PROJECT="fju-im-capstone"
FJU_DEPLOY_USER="${FJU_DEPLOY_USER:-deploy}"

# docker-compose.vm.yml 要的鍵（Doppler 各 config 裡必須有）。只列名字。
FJU_REQUIRED_SECRETS=(
  POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB
  DATABASE_URL DATABASE_URL_OWNER APP_DB_PASSWORD
  BETTER_AUTH_SECRET BETTER_AUTH_URL
  GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET
  FILES_ROOT FILE_MAX_BYTES BUSINESS_CLOCK_OVERRIDE_ENABLED
)

# site_setup <test|prod> <app 目錄>：設定這一站的所有變數，並 export 給 Compose。
# SITE_HOST、SITE_ROOT 等由呼叫端（deploy.sh、backup.sh…）使用。
# shellcheck disable=SC2034
site_setup() {
  local site="$1" app_root="$2"
  case "$site" in
    test) SITE_HOST=test.fju.roy422.dev; SITE_DOPPLER_CONFIG=stg ;;
    prod) SITE_HOST=fju.roy422.dev;      SITE_DOPPLER_CONFIG=prd ;;
    *) echo "站台只能是 test 或 prod（收到：${site:-空的}）" >&2; return 1 ;;
  esac
  FJU_SITE="$site"
  SITE_ROOT="$FJU_ROOT/$site"
  SITE_TOKEN_FILE="$FJU_SECRETS_DIR/doppler-$site.token"
  # 絕對路徑：Compose 把 COMPOSE_FILE 裡的相對路徑當成相對於目前目錄，不是 app 目錄。
  COMPOSE_FILE="$app_root/docker-compose.yml:$app_root/docker-compose.vm.yml"
  COMPOSE_PROJECT_NAME="fju-$site"
  export FJU_SITE COMPOSE_FILE COMPOSE_PROJECT_NAME
}

# 檢查 token 檔存在、600、擁有者是執行者自己。不讀內容。
site_check_token_file() {
  local file="$SITE_TOKEN_FILE" mode owner
  if [ ! -f "$file" ]; then
    echo "找不到 $file——Roy 要先把 $FJU_SITE 站的 Doppler service token 貼進去（ops/README.md）。" >&2
    return 1
  fi
  mode="$(stat -c '%a' "$file" 2>/dev/null || stat -f '%Lp' "$file")"
  owner="$(stat -c '%U' "$file" 2>/dev/null || stat -f '%Su' "$file")"
  if [ "$mode" != 600 ]; then
    echo "$file 的權限是 $mode，必須是 600：chmod 600 $file" >&2
    return 1
  fi
  if [ "$owner" != "$(id -un)" ]; then
    echo "$file 的擁有者是 $owner，要用擁有者（$FJU_DEPLOY_USER）執行：sudo -u $FJU_DEPLOY_USER …" >&2
    return 1
  fi
}

# site_exec_with_secrets <指令…>：以這一站的 Doppler 秘密執行指令（exec，不回來）。
# 子程序會帶 FJU_SECRETS_LOADED=<站台>，腳本用它判斷「已經在 doppler run 裡面了」。
site_exec_with_secrets() {
  site_check_token_file || exit 1
  if ! command -v doppler >/dev/null 2>&1; then
    echo "VM 上沒有 doppler 指令——先跑 sudo bash ops/vm-setup.sh。" >&2
    exit 1
  fi
  local token=""
  IFS= read -r token < "$SITE_TOKEN_FILE" || true
  if [ -z "$token" ]; then
    echo "$SITE_TOKEN_FILE 是空的。" >&2
    exit 1
  fi
  # service token 本身就綁定 project＋config，不另外帶 --project／--config；
  # 進去之後由 site_verify_secrets 核對 Doppler 注入的 DOPPLER_CONFIG，防止貼錯站的 token。
  DOPPLER_TOKEN="$token" DOPPLER_ENABLE_VERSION_CHECK=false \
    exec doppler run --no-fallback -- \
    env -u DOPPLER_TOKEN FJU_SECRETS_LOADED="$FJU_SITE" "$@"
}

# 在 doppler run 裡面呼叫：確認 token 是這一站的，且必要的鍵都有值。只印鍵名。
site_verify_secrets() {
  if [ -n "${DOPPLER_CONFIG:-}" ] && [ "$DOPPLER_CONFIG" != "$SITE_DOPPLER_CONFIG" ]; then
    echo "這把 token 是 Doppler config「$DOPPLER_CONFIG」的，但 $FJU_SITE 站要用「$SITE_DOPPLER_CONFIG」——token 貼錯檔了。" >&2
    return 1
  fi
  if [ -n "${DOPPLER_PROJECT:-}" ] && [ "$DOPPLER_PROJECT" != "$FJU_DOPPLER_PROJECT" ]; then
    echo "這把 token 屬於 Doppler 專案「$DOPPLER_PROJECT」，不是 $FJU_DOPPLER_PROJECT。" >&2
    return 1
  fi
  local name missing=()
  for name in "${FJU_REQUIRED_SECRETS[@]}"; do
    [ -n "${!name:-}" ] || missing+=("$name")
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    echo "Doppler $SITE_DOPPLER_CONFIG 少了這些鍵（或值是空的）：${missing[*]}" >&2
    return 1
  fi
}
