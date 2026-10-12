#!/usr/bin/env bash
# 產生開發者後台的隧道設定 ops/status/cloudflared.yml（設計方案 §3.2a、§3.12 第 7 步；S-4）。
#
#   ops/status-render-cloudflared.sh --team <team> --aud <AUD> (--tunnel-id <id> | --credentials <tunnel.json>)
#                                    [--out <檔案>] [--no-access]
#   ops/status-render-cloudflared.sh --print-hosts
#
#   --team         Access 的 team 名稱（<team> 或 <team>.cloudflareaccess.com 都收，設定檔裡只寫名稱）
#   --aud          Access 應用程式的 Application Audience（AUD）tag
#   --tunnel-id    隧道 ID；或用 --credentials 從 tunnel.json 的 TunnelID 讀
#   --out          輸出檔，預設 ops/status/cloudflared.yml；- 表示印到螢幕
#   --no-access    不加 access 區塊。只給安裝腳本第 7b 步的「突變測試」用（暫時隧道），真後台絕不能用
#   --print-hosts  依序印出四個網址（status-web、beszel、dozzle、pghero），給其他腳本共用
#
# 四個網址只寫在 STATUS_HOSTS 這一個設定值（可用環境變數覆寫，順序固定）：
#   status-web:3000、beszel:8090、dozzle:8080、pghero:8080
# 每條 ingress 都帶 originRequest.access（required、teamName、audTag）：cloudflared 在轉給容器前
# 先驗 Access JWT，不合法回 403，流量進不到任何容器（兩道鎖的第一道在隧道端）。
# 輸出是 JSON 寫法的 YAML（cloudflared 用 YAML 讀，JSON 本來就是合法 YAML），
# 這樣測試與安裝腳本第 10 步都能逐條確實核對 access 區塊，不必猜 YAML 縮排。
set -euo pipefail

APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="${APP_ROOT}/ops/status/cloudflared.yml.tmpl"
STATUS_HOSTS="${STATUS_HOSTS:-fju-status.roy422.dev fju-status-vm.roy422.dev fju-status-logs.roy422.dev fju-status-db.roy422.dev}"
SERVICES=(http://status-web:3000 http://beszel:8090 http://dozzle:8080 http://pghero:8080)

TEAM=""
AUD=""
TUNNEL_ID=""
CREDENTIALS=""
OUT="${APP_ROOT}/ops/status/cloudflared.yml"
WITH_ACCESS=1
PRINT_HOSTS=0

usage() {
  sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}
die() {
  printf '✗ %s\n' "$*" >&2
  exit 1
}
need_value() {
  [ $# -ge 2 ] && [ -n "$2" ] || die "${1} 後面要接值"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --team) need_value "$@"; TEAM="$2"; shift ;;
    --aud) need_value "$@"; AUD="$2"; shift ;;
    --tunnel-id) need_value "$@"; TUNNEL_ID="$2"; shift ;;
    --credentials) need_value "$@"; CREDENTIALS="$2"; shift ;;
    --out) need_value "$@"; OUT="$2"; shift ;;
    --no-access) WITH_ACCESS=0 ;;
    --print-hosts) PRINT_HOSTS=1 ;;
    -h | --help) usage 0 ;;
    *)
      printf '不認得的參數：%s\n' "$1" >&2
      usage 2 >&2
      ;;
  esac
  shift
done

read -r -a HOSTS <<<"$STATUS_HOSTS"
[ "${#HOSTS[@]}" = 4 ] || die "STATUS_HOSTS 要剛好四個網址（status-web、beszel、dozzle、pghero），現在是 ${#HOSTS[@]} 個"
for h in "${HOSTS[@]}"; do
  [[ "$h" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] || die "網址格式不對：${h}"
done

if [ "$PRINT_HOSTS" = 1 ]; then
  printf '%s\n' "${HOSTS[@]}"
  exit 0
fi

TEAM="${TEAM%.cloudflareaccess.com}"
[ -n "$TEAM" ] || die "缺 --team（Access 的 team 名稱）"
[[ "$TEAM" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || die "team 名稱格式不對：${TEAM}"
[ -n "$AUD" ] || die "缺 --aud（Access 應用程式的 AUD tag）"
[[ "$AUD" =~ ^[A-Za-z0-9]{16,128}$ ]] || die "AUD 格式不對（應該是一串英數字）"

if [ -z "$TUNNEL_ID" ] && [ -n "$CREDENTIALS" ]; then
  [ -r "$CREDENTIALS" ] || die "讀不到 ${CREDENTIALS}"
  TUNNEL_ID="$(sed -n 's/.*"TunnelID"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$CREDENTIALS" | head -n 1)"
fi
[ -n "$TUNNEL_ID" ] || die "缺 --tunnel-id 或 --credentials"
[[ "$TUNNEL_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || die "隧道 ID 格式不對：${TUNNEL_ID}"

[ -r "$TEMPLATE" ] || die "讀不到範本 ${TEMPLATE}"

# 上面已逐項驗過字元集（沒有引號、反斜線、換行），所以直接嵌進 JSON 是安全的。
ingress=""
for i in 0 1 2 3; do
  entry="    {
      \"hostname\": \"${HOSTS[$i]}\",
      \"service\": \"${SERVICES[$i]}\""
  if [ "$WITH_ACCESS" = 1 ]; then
    entry+=",
      \"originRequest\": {
        \"access\": { \"required\": true, \"teamName\": \"${TEAM}\", \"audTag\": [\"${AUD}\"] }
      }"
  fi
  entry+="
    },"
  ingress+="${entry}"$'\n'
done
ingress="${ingress%$'\n'}"

content="$(cat "$TEMPLATE")"
content="${content//__TUNNEL_ID__/"$TUNNEL_ID"}"
content="${content//__INGRESS__/"$ingress"}"

if [ "$OUT" = - ]; then
  printf '%s\n' "$content"
  exit 0
fi

tmp="$(mktemp "${OUT}.XXXXXX")"
printf '%s\n' "$content" >"$tmp"
chmod 644 "$tmp"
mv -f "$tmp" "$OUT"
if [ "$WITH_ACCESS" = 1 ]; then
  printf '✓ 已產生 %s（四條 ingress 都有 originRequest.access）\n' "$OUT"
else
  printf '⚠ 已產生 %s（沒有 access 區塊：只能給暫時隧道的突變測試用）\n' "$OUT"
fi
