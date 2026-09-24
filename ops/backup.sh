#!/usr/bin/env bash
# 手動備份某一站的資料庫（兩站版，2026-09-24）。不排程，需要時由 deploy 身分執行：
#
#   sudo -u deploy /srv/fju/app/ops/backup.sh --site <test|prod>
#
# 做什麼：在該站的 postgres 容器裡 `pg_dump -Fc`（容器內的 owner 帳號、本機 socket），
# 存到 VM 上 /srv/fju/<站台>/backups/fju-<站台>-<UTC 時間>.dump（目錄 700、檔案 600），
# 再用 `pg_restore --list` 讀一遍確認檔案是完整的 custom-format dump。
#
# 範圍（SOP 04 v3）：只放 VM、不做異地、不加密上傳；附件目錄不在備份內。
# backup_runs 表還不存在，這支不寫紀錄；還原步驟見 SOP 04。
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
    -h|--help) sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "不認得的參數：$1" >&2; exit 1 ;;
  esac
  shift
done
[ -n "$SITE" ] || { echo "缺少 --site test|prod" >&2; exit 1; }
site_setup "$SITE" "$APP_ROOT"

if [ "${FJU_SECRETS_LOADED:-}" != "$SITE" ]; then
  site_exec_with_secrets bash "${BASH_SOURCE[0]}" "${ORIG_ARGS[@]}"
fi
site_verify_secrets

BACKUP_DIR="$SITE_ROOT/backups"
umask 077
mkdir -p "$BACKUP_DIR"
out="$BACKUP_DIR/fju-$SITE-$(date -u +%Y%m%dT%H%M%SZ).dump"
partial="$out.partial"
trap 'rm -f "$partial"' EXIT

cd "$APP_ROOT"
echo "備份 $SITE 站（$COMPOSE_PROJECT_NAME）的資料庫 → $out"
# 帳號與資料庫名用容器自己的環境變數，不經過宿主機的指令列。
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$partial"

if [ ! -s "$partial" ]; then
  echo "pg_dump 沒有輸出任何東西，備份失敗。" >&2
  exit 1
fi
# 讀一遍目錄，確認 dump 是完整的（截斷的檔案在這裡會失敗）。
entries="$(docker compose exec -T postgres pg_restore --list < "$partial" | grep -vc '^;' || true)"
if [ "${entries:-0}" -lt 1 ]; then
  echo "pg_restore --list 讀不出內容，備份檔可能不完整。" >&2
  exit 1
fi
mv "$partial" "$out"
trap - EXIT
echo "✓ 完成：$(du -h "$out" | cut -f1)、$entries 個項目"
ls -l "$out"
