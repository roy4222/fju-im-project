#!/usr/bin/env bash
# 手動備份某一站的資料庫（兩站版＋票 27 紀錄，2026-09-24）。不排程，需要時由 deploy 身分執行：
#
#   sudo -u deploy /srv/fju/app/ops/backup.sh --site <test|prod>
#   sudo -u deploy /srv/fju/app/ops/backup.sh --site <test|prod> --status   # 只看最近成功備份／演練
#
# 做什麼：在該站的 postgres 容器裡 `pg_dump -Fc`（容器內的 owner 帳號、本機 socket），
# 存到 VM 上 /srv/fju/<站台>/backups/fju-<站台>-<UTC 時間>.dump（目錄 700、檔案 600），
# 用 `pg_restore --list` 讀一遍確認檔案完整，再量一次各表筆數（給還原演練比對），
# 最後在 /srv/fju/<站台>/backups/records.jsonl 加一筆紀錄。失敗也加一筆（含錯誤），
# 不會蓋掉上一次成功的紀錄。
#
# 範圍（SOP 04 v3）：只放 VM、不做異地、不加密上傳；附件目錄不在備份內。還原演練見 ops/restore-drill.sh。
set -euo pipefail

ORIG_ARGS=("$@")
APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# `sudo -u deploy` 會沿用呼叫者的目錄（deploy 可能讀不到），先換到自己的目錄。
cd "$APP_ROOT"
# shellcheck source-path=SCRIPTDIR source=lib/site.sh
. "$APP_ROOT/ops/lib/site.sh"
# shellcheck source-path=SCRIPTDIR source=lib/backup-common.sh
. "$APP_ROOT/ops/lib/backup-common.sh"

SITE=""
STATUS_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --site) SITE="${2:-}"; shift ;;
    --site=*) SITE="${1#--site=}" ;;
    --status) STATUS_ONLY=1 ;;
    -h|--help) sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "不認得的參數：$1" >&2; exit 1 ;;
  esac
  shift
done
[ -n "$SITE" ] || { echo "缺少 --site test|prod" >&2; exit 1; }
site_setup "$SITE" "$APP_ROOT"

BACKUP_DIR="$SITE_ROOT/backups"
RECORDS="$(backup_records_file "$BACKUP_DIR")"
RECORD_TOOL="$APP_ROOT/ops/lib/backup-record.mjs"

if [ "$STATUS_ONLY" = 1 ]; then
  node "$RECORD_TOOL" status "$RECORDS"
  exit 0
fi

umask 077
mkdir -p "$BACKUP_DIR"
STARTED_AT="$(utc_now)"

if [ "${FJU_SECRETS_LOADED:-}" != "$SITE" ]; then
  # 外層：帶 Doppler 秘密重新執行自己（在子 shell 裡 exec，所以外層還在）。
  # 內層一開始就刪掉 marker；marker 還在＝連內層都沒進去（token 檔、doppler 指令或網路出錯），
  # 這種失敗由外層寫紀錄。其他情況一律由內層寫，同一次不會寫兩筆。
  marker="$(mktemp "$BACKUP_DIR/.launch.XXXXXX")"
  launch_err="$(mktemp "$BACKUP_DIR/.launch-err.XXXXXX")"
  set +e
  (
    # shellcheck disable=SC2030  # 只給子 shell 裡 exec 出去的內層看，外層不需要。
    export FJU_BACKUP_MARKER="$marker"
    site_exec_with_secrets bash "$APP_ROOT/ops/backup.sh" "${ORIG_ARGS[@]}"
  ) 2> "$launch_err"
  code=$?
  set -e
  # 錯誤訊息先收進檔案（取不到秘密時要把它寫進紀錄），跑完再原樣印出來。
  cat "$launch_err" >&2
  if [ "$code" -ne 0 ] && [ -e "$marker" ]; then
    node "$RECORD_TOOL" append "$RECORDS" \
      kind=backup status=failed site="$SITE" project="$COMPOSE_PROJECT_NAME" \
      started_at="$STARTED_AT" finished_at="$(utc_now)" step="取得 Doppler 秘密" \
      error="取得 Doppler 秘密失敗（結束碼 $code）：$(tail -c 600 "$launch_err" | tr '\n' ' ')" \
      || echo "（連失敗紀錄都寫不進 $RECORDS）" >&2
    echo "✗ 備份沒有開始（取不到秘密），已寫入失敗紀錄：$RECORDS" >&2
  fi
  rm -f "$marker" "$launch_err"
  exit "$code"
fi

# ---- 以下是內層（已在 doppler run 裡面） ----
# shellcheck disable=SC2031  # 這是外層 export 給內層的值，內層讀得到。
[ -z "${FJU_BACKUP_MARKER:-}" ] || rm -f "$FJU_BACKUP_MARKER"
STEP="檢查 Doppler 秘密"
out="$BACKUP_DIR/fju-$SITE-$(date -u +%Y%m%dT%H%M%SZ).dump"
partial="$out.partial"
work="$(mktemp -d "$BACKUP_DIR/.work.XXXXXX")"
errlog="$work/stderr"
: > "$errlog"
RECORDED=0

record_failure() {
  local message="$1"
  node "$RECORD_TOOL" append "$RECORDS" \
    kind=backup status=failed site="$SITE" project="$COMPOSE_PROJECT_NAME" \
    started_at="$STARTED_AT" finished_at="$(utc_now)" \
    step="$STEP" error="$message" \
    || echo "（連失敗紀錄都寫不進 $RECORDS）" >&2
  RECORDED=1
}

# 任何一步失敗（包括 set -e 抓到的）都留一筆失敗紀錄，並清掉寫到一半的檔案。
on_exit() {
  local code=$?
  # set -e 在「帶 2>>errlog 的函式呼叫」裡觸發時，trap 會沿用那個轉向；先換回原本的畫面輸出。
  exec 1>&4 2>&3
  rm -f "$partial"
  if [ "$code" -ne 0 ] && [ "$RECORDED" = 0 ]; then
    local detail
    detail="$(tail -c 600 "$errlog" 2>/dev/null | tr '\n' ' ' || true)"
    record_failure "${STEP}失敗（結束碼 $code）${detail:+：$detail}"
    echo "✗ 備份失敗（$STEP），已寫入失敗紀錄：$RECORDS" >&2
    [ -z "$detail" ] || echo "  錯誤：$detail" >&2
  fi
  rm -rf "$work"
}
exec 3>&2 4>&1
trap on_exit EXIT

# 換到下一步：錯誤訊息只留這一步的，失敗紀錄才看得出是哪裡壞。
step() { STEP="$1"; : > "$errlog"; }

site_verify_secrets 2>>"$errlog" || { cat "$errlog" >&2; exit 1; }

# 在來源站的 postgres 容器裡跑唯讀查詢，輸出一行 JSON（筆數＋回答內容 md5）。
spot_counts_source() {
  # 單引號是刻意的：$POSTGRES_USER／$POSTGRES_DB 要在容器裡展開。
  # shellcheck disable=SC2016
  printf '%s\n' "BEGIN READ ONLY;" "$SPOT_COUNTS_SQL" "COMMIT;" \
    | docker compose exec -T postgres sh -c 'psql -qAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
    | grep '^{'
}

cd "$APP_ROOT"
echo "備份 $SITE 站（$COMPOSE_PROJECT_NAME）的資料庫 → $out"

step "備份前量筆數"
spot_counts_source > "$work/counts-before.json" 2>>"$errlog"

step "pg_dump"
# 帳號與資料庫名用容器自己的環境變數，不經過宿主機的指令列。
# shellcheck disable=SC2016
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$partial" 2>>"$errlog"

if [ ! -s "$partial" ]; then
  echo "pg_dump 沒有輸出任何東西。" >> "$errlog"
  exit 1
fi

step "檢查備份檔（pg_restore --list）"
# 讀一遍目錄，確認 dump 是完整的（截斷的檔案在這裡會失敗）。
entries="$(docker compose exec -T postgres pg_restore --list < "$partial" 2>>"$errlog" | grep -vc '^;' || true)"
if [ "${entries:-0}" -lt 1 ]; then
  echo "pg_restore --list 讀不出內容，備份檔可能不完整。" >> "$errlog"
  exit 1
fi

step "備份後量筆數"
spot_counts_source > "$work/counts-after.json" 2>>"$errlog"
stable=true
cmp -s "$work/counts-before.json" "$work/counts-after.json" || stable=false

step "存檔與寫紀錄"
mv "$partial" "$out"
chmod 600 "$out"
bytes="$(wc -c < "$out" | tr -d ' ')"
sha="$(sha256_of "$out")"
node "$RECORD_TOOL" append "$RECORDS" \
  kind=backup status=ok site="$SITE" project="$COMPOSE_PROJECT_NAME" \
  started_at="$STARTED_AT" finished_at="$(utc_now)" \
  file="$(basename "$out")" bytes="json:$bytes" sha256="$sha" entries="json:$entries" \
  counts="file:$work/counts-before.json" counts_after="file:$work/counts-after.json" \
  counts_stable="json:$stable" attachments_included="json:false" \
  note="只備份資料庫；附件（/srv/fju/$SITE/files）不在這份備份裡。"
RECORDED=1

echo "✓ 完成：$(du -h "$out" | cut -f1)、$entries 個項目，sha256 ${sha:0:12}…"
if [ "$stable" = false ]; then
  echo "⚠️ 備份期間有人寫入資料（前後筆數不同）；還原演練的比對兩邊都接受。沒人操作時重備一次會更乾淨。"
fi
ls -l "$out"
echo "紀錄已寫入 $RECORDS"
