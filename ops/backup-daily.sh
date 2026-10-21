#!/usr/bin/env bash
# 每日備份（⑤-06，把原本只在 VM 上的包裝腳本搬進 repo）。由 systemd timer（fju-backup.timer，
# vm-setup.sh 步驟 12 安裝）每天 UTC 19:30（台灣 03:30）以 deploy 身分執行；也可以手動跑：
#
#   sudo -u deploy /srv/fju/app/ops/backup-daily.sh
#
# 做什麼：
#   1. 正式站的 postgres 容器（fju-prod-postgres）存在 → ops/backup.sh --site prod，
#      再把 /srv/fju/prod/backups/ 裡還沒同步過的 dump 複製到 /srv/fju/offsite/prod/（目錄 700、檔案 600）。
#      不存在（例如還沒開正式站的機器）→ 印「正式站不存在，略過」，仍算成功。
#   2. 量 /srv 的磁碟使用率：≥ 80% → 對「每日備份」check 送 /fail，body「磁碟 NN%」；否則送成功。
#
# Healthchecks.io：/srv/fju/secrets/healthchecks-backup.url 存在才打卡（開始 /start、成功、失敗 /fail）；
# 不存在就完全不呼叫 curl。測試站不在每日備份內（要備份測試站請手動 backup.sh --site test）。
set -euo pipefail

APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_ROOT"
# shellcheck source-path=SCRIPTDIR source=lib/site.sh
. "$APP_ROOT/ops/lib/site.sh"
# shellcheck source-path=SCRIPTDIR source=lib/healthchecks.sh
. "$APP_ROOT/ops/lib/healthchecks.sh"

case "${1:-}" in
  -h|--help) sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
  '') ;;
  *) echo "不認得的參數：$1（這支腳本不接受參數）" >&2; exit 1 ;;
esac

# 在 mkdir／寫檔之前擋掉非 deploy 身分（見 ops/lib/site.sh）。
require_deploy_user "$APP_ROOT/ops/backup-daily.sh"

HC_URL_FILE="$FJU_SECRETS_DIR/healthchecks-backup.url"
PROD_CONTAINER=fju-prod-postgres
PROD_BACKUP_DIR="$FJU_ROOT/prod/backups"
OFFSITE_DIR="${FJU_OFFSITE_DIR:-$FJU_ROOT/offsite}/prod"
DISK_PATH="${BACKUP_DISK_PATH:-/srv}"
DISK_LIMIT_PCT=80

say() { printf '[backup-daily] %s\n' "$*"; }

# 量 DISK_PATH 的使用率（整數百分比）。測試可用 BACKUP_DISK_USED_PCT 假裝。
disk_used_pct() {
  if [ -n "${BACKUP_DISK_USED_PCT:-}" ]; then
    printf '%s' "$BACKUP_DISK_USED_PCT"
    return 0
  fi
  df -P "$DISK_PATH" | awk 'NR == 2 { sub(/%$/, "", $5); print $5 }'
}

# 沒預料到的錯誤（set -e）也要送 /fail；正常結束的路徑自己打卡並把 PINGED 設成 1。
PINGED=0
# shellcheck disable=SC2329  # 由下面的 trap 呼叫。
on_exit() {
  local code=$?
  if [ "$code" -ne 0 ] && [ "$PINGED" = 0 ]; then
    hc_ping "$HC_URL_FILE" fail "每日備份失敗（exit ${code}）"
  fi
}
trap on_exit EXIT

hc_ping "$HC_URL_FILE" start

summary=""
if docker inspect "$PROD_CONTAINER" >/dev/null 2>&1; then
  rc=0
  "$APP_ROOT/ops/backup.sh" --site prod || rc=$?
  if [ "$rc" -ne 0 ]; then
    say "正式站備份失敗（exit ${rc}），細節看 ${PROD_BACKUP_DIR}/records.jsonl。"
    hc_ping "$HC_URL_FILE" fail "正式站備份失敗（exit ${rc}）"
    PINGED=1
    exit "$rc"
  fi
  umask 077
  mkdir -p "$OFFSITE_DIR"
  copied=0
  for f in "$PROD_BACKUP_DIR"/*.dump; do
    [ -f "$f" ] || continue
    [ -e "$OFFSITE_DIR/$(basename "$f")" ] && continue
    cp -p "$f" "$OFFSITE_DIR/"
    copied=$((copied + 1))
  done
  say "正式站備份完成，同步 ${copied} 個檔到 ${OFFSITE_DIR}。"
  summary="正式站備份完成"
else
  say "正式站不存在，略過（找不到 ${PROD_CONTAINER} 容器）。"
  summary="正式站不存在，略過"
fi

pct="$(disk_used_pct || true)"
if ! printf '%s' "$pct" | grep -Eq '^[0-9]+$'; then
  say "量不到 ${DISK_PATH} 的磁碟使用率。"
  hc_ping "$HC_URL_FILE" fail "${summary}；量不到磁碟使用率"
  PINGED=1
  exit 1
fi
if [ "$pct" -ge "$DISK_LIMIT_PCT" ]; then
  say "磁碟 ${pct}%（${DISK_PATH}，≥ ${DISK_LIMIT_PCT}%），送失敗通知。"
  hc_ping "$HC_URL_FILE" fail "磁碟 ${pct}%（${summary}）"
  PINGED=1
  # 備份本身已完成；磁碟告警只走 Healthchecks.io，不讓 systemd 把這次記成失敗。
  exit 0
fi
say "磁碟 ${pct}%（${DISK_PATH}）。"
hc_ping "$HC_URL_FILE" '' "${summary}；磁碟 ${pct}%"
PINGED=1
exit 0
