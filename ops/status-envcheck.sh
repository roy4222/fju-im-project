#!/usr/bin/env bash
# 正式站設定檢查（開發者後台 G5，設計方案 §3.8，票 S-3）。deploy 身分、每天 04:10 與開機後各跑一次
# （systemd：fju-status-envcheck.timer）。也可以手動跑：
#
#   sudo -u deploy /srv/fju/app/ops/status-envcheck.sh prod
#   sudo -u deploy /srv/fju/app/ops/status-envcheck.sh prod --out /tmp/envcheck.json   # 寫到別處
#
# 結果寫到 /srv/fju/status/envcheck/<站>.json（collector 唯讀讀它），內容只有鍵名與 false/absent/other：
#   {"site":"prod","checkedAt":…,"missing":[鍵名],"forbiddenPresent":[鍵名],
#    "flags":{"REGISTRATION_OPEN":"false|absent|other","BUSINESS_CLOCK_OVERRIDE_ENABLED":"false|other"}}
# 不寫、不印任何秘密的值。
#
# 為什麼不經 ops/site.sh：它在執行指令前先跑 site_verify_secrets，缺鍵就直接退出，
# 缺鍵清單永遠產不出來。所以這裡自己 source ops/lib/site.sh、用 site_exec_with_secrets 重新進入自己，
# 進去之後只核對 token 是這一站的（DOPPLER_CONFIG／DOPPLER_PROJECT），缺哪些鍵自己收集。
set -euo pipefail

ORIG_ARGS=("$@")
APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# `sudo -u deploy` 會沿用呼叫者的目錄（deploy 可能讀不到），先換到自己的目錄。
cd "$APP_ROOT"
# shellcheck source-path=SCRIPTDIR source=lib/site.sh
. "$APP_ROOT/ops/lib/site.sh"

# 正式站上線前不能存在的鍵（測試站專用的系辦測試帳號）。
FORBIDDEN_KEYS=(E2E_ADMIN_EMAIL E2E_ADMIN_PASSWORD)

SITE=""
INSIDE=0
OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --inside) INSIDE=1 ;;
    --out) OUT="${2:-}"; [ -n "$OUT" ] || { echo "--out 後面要接檔案路徑" >&2; exit 1; }; shift ;;
    --out=*) OUT="${1#--out=}" ;;
    -h|--help) sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    test|prod) SITE="$1" ;;
    *) echo "不認得的參數：$1" >&2; exit 1 ;;
  esac
  shift
done
[ -n "$SITE" ] || { echo "用法：ops/status-envcheck.sh <test|prod> [--out 檔案]" >&2; exit 1; }
[ -n "$OUT" ] || OUT="$FJU_ROOT/status/envcheck/${SITE}.json"

if [ "$INSIDE" = 0 ]; then
  require_deploy_user "$APP_ROOT/ops/status-envcheck.sh ${ORIG_ARGS[*]:-}"
  site_setup "$SITE" "$APP_ROOT"
  # exec 進 doppler run，不會回來。
  site_exec_with_secrets bash "$APP_ROOT/ops/status-envcheck.sh" "$SITE" --inside --out "$OUT"
fi

# ── 以下在 doppler run 裡面 ──────────────────────────────────
site_setup "$SITE" "$APP_ROOT"
if [ "${FJU_SECRETS_LOADED:-}" != "$SITE" ]; then
  echo "--inside 只給腳本自己重新進入時用（要在 ${SITE} 站的 doppler run 裡面）。" >&2
  exit 1
fi
# site_verify_secrets 的前半：token 必須是這一站、這個專案的（防貼錯站）。這裡兩個都必須存在。
if [ "${DOPPLER_CONFIG:-}" != "$SITE_DOPPLER_CONFIG" ]; then
  echo "這把 token 的 Doppler config 是「${DOPPLER_CONFIG:-沒有}」，${SITE} 站要用「${SITE_DOPPLER_CONFIG}」——不寫結果。" >&2
  exit 1
fi
if [ "${DOPPLER_PROJECT:-}" != "$FJU_DOPPLER_PROJECT" ]; then
  echo "這把 token 屬於 Doppler 專案「${DOPPLER_PROJECT:-沒有}」，不是 ${FJU_DOPPLER_PROJECT}——不寫結果。" >&2
  exit 1
fi

missing=()
for name in "${FJU_REQUIRED_SECRETS[@]}"; do
  [ -n "${!name:-}" ] || missing+=("$name")
done
forbidden=()
for name in "${FORBIDDEN_KEYS[@]}"; do
  [ -z "${!name+x}" ] || forbidden+=("$name")
done

# 兩個旗標只回報是不是 false，不輸出值。
if [ -z "${REGISTRATION_OPEN+x}" ]; then
  registration=absent
elif [ "$REGISTRATION_OPEN" = false ]; then
  registration=false
else
  registration=other
fi
if [ "${BUSINESS_CLOCK_OVERRIDE_ENABLED:-}" = false ]; then
  clock=false
else
  clock=other
fi

# 鍵名都是 [A-Z0-9_]，直接組 JSON 陣列不用跳脫。
json_names() {
  local out="" n
  for n in "$@"; do out="${out}\"${n}\","; done
  printf '[%s]' "${out%,}"
}

json="$(printf '{"site":"%s","checkedAt":"%s","missing":%s,"forbiddenPresent":%s,"flags":{"REGISTRATION_OPEN":"%s","BUSINESS_CLOCK_OVERRIDE_ENABLED":"%s"}}' \
  "$SITE" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  "$(json_names ${missing[@]+"${missing[@]}"})" "$(json_names ${forbidden[@]+"${forbidden[@]}"})" \
  "$registration" "$clock")"

tmp="${OUT}.tmp.$$"
printf '%s\n' "$json" > "$tmp"
chmod 644 "$tmp"
mv "$tmp" "$OUT"

echo "✓ ${SITE} 站設定檢查寫到 ${OUT}"
echo "  少的鍵：${missing[*]:-（沒有）}"
echo "  不該有的鍵：${forbidden[*]:-（沒有）}"
echo "  REGISTRATION_OPEN：${registration}；BUSINESS_CLOCK_OVERRIDE_ENABLED：${clock}"
