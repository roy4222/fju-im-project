#!/usr/bin/env bash
# 把一夜驗收結果送上開發者後台（設計方案 docs/plans/2026-10-12-status-console §3.5；票 S-8；AC-S-22）。
# 💻 在 Mac mini 或 MacBook 的 repo 根目錄跑；acceptance-night.sh 收尾會自動叫，也可以手動重送：
#
#   ops/status-publish-run.sh e2e/acceptance/.out/night-20261012-2200
#   ops/status-publish-run.sh latest --dry-run
#
# 送什麼：一定送 run.json（每夜都有；summarize 失敗也要讓後台知道這夜存在）；summary.json 有才送；
#   summary.json 裡 items[].steps[].截圖 列到的圖（<item>/screenshots/*.png|jpg|jpeg|webp）。
#   不送 report.md、progress.md、summary.md、run.log、logs/、.playwright-cli/ 和沒列到的圖（logs 與 playwright 狀態可能有 email、提示詞）。
# 怎麼送：先複製到本機暫存鏡像（預設 ~/.fju-status-publish/<runId>/，只留最新 5 夜），
#   再用一次 rsync（＝一次 ssh 連線，不碰 ufw 30 秒 6 次的限速）把整個鏡像 --delete 同步到 VM 的 inbox：
#   帳號 fjustatus 的 authorized_keys 是 rrsync -wo /srv/fju/status/inbox，只能寫那裡。所以 VM 上最多 5 夜。
#   落地權限一律 --chmod=D755,F644：Mac 上是 700／600，照搬上去 status-web（容器內非 root）讀不到。
#
# 參數：
#   <run 目錄>|latest   latest＝e2e/acceptance/.out 底下最新一個有 run.json 的 night-*
#   --dry-run           只印會送哪些檔、鏡像會留哪幾夜、rsync 指令；不動鏡像、不連線
#
# 可調的環境變數：
#   STATUS_PUBLISH_HOST      ssh 主機別名，預設 fju-status-publish（見 ops/ssh-config.example）
#   STATUS_PUBLISH_MIRROR    暫存鏡像目錄，預設 ~/.fju-status-publish
#   STATUS_PUBLISH_OUT_ROOT  latest 從哪裡找，預設 e2e/acceptance/.out
#   STATUS_PUBLISH_SSH       ssh 指令，預設 ssh；測試指到假 ssh
#   STATUS_PUBLISH_RSYNC     rsync 指令，預設 rsync；macOS 內建的舊版不認 D755 這種寫法時，指到 Homebrew 的 rsync
#
# 結束碼：0＝送出（沒有 summary.json、列到的圖找不到都只警告）；1＝run 目錄或 run.json 有問題、rsync 失敗；2＝參數錯
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${STATUS_PUBLISH_HOST:-fju-status-publish}"
MIRROR="${STATUS_PUBLISH_MIRROR:-$HOME/.fju-status-publish}"
OUT_ROOT="${STATUS_PUBLISH_OUT_ROOT:-$REPO_ROOT/e2e/acceptance/.out}"
SSH="${STATUS_PUBLISH_SSH:-ssh}"
RSYNC="${STATUS_PUBLISH_RSYNC:-rsync}"
KEEP=5

usage() {
  sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed -e '$d' -e 's/^# \{0,1\}//'
}
die() { echo "錯誤：$1" >&2; exit "${2:-1}"; }
warn() { echo "警告：$1" >&2; }

TARGET=""
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    -*) die "不認得的參數 $1（看 --help）" 2 ;;
    *) [ -z "$TARGET" ] || die "只能給一個 run 目錄" 2; TARGET="$1" ;;
  esac
  shift
done
[ -n "$TARGET" ] || die "要給 run 目錄或 latest（看 --help）" 2

if [ "$TARGET" = latest ]; then
  RUN_DIR=""
  for d in "$OUT_ROOT"/night-*/; do
    [ -f "${d}run.json" ] && RUN_DIR="${d%/}"
  done
  [ -n "$RUN_DIR" ] || die "${OUT_ROOT} 底下沒有任何有 run.json 的 night-* 目錄"
else
  RUN_DIR="${TARGET%/}"
fi
[ -d "$RUN_DIR" ] || die "找不到 run 目錄 ${RUN_DIR}"
RUN_DIR="$(cd "$RUN_DIR" && pwd)"
RUN_ID="$(basename "$RUN_DIR")"
[[ "$RUN_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die "run 目錄名稱 ${RUN_ID} 不合規（只能英數、.、_、-）"

command -v jq >/dev/null 2>&1 || die "找不到 jq"
[ -f "$RUN_DIR/run.json" ] && [ ! -L "$RUN_DIR/run.json" ] || die "${RUN_DIR} 沒有 run.json，不送（這夜可能沒開跑）"
jq -e 'type == "object"' "$RUN_DIR/run.json" >/dev/null 2>&1 || die "${RUN_DIR}/run.json 不是合法的 JSON 物件，不送"

# ── 這夜要送的檔（相對 run 目錄） ─────────────────────────────
FILES=(run.json)
if [ -f "$RUN_DIR/summary.json" ] && [ ! -L "$RUN_DIR/summary.json" ]; then
  FILES+=(summary.json)
  if shots="$(jq -r '[.items[]?.steps[]?["截圖"][]? | strings] | unique | .[]' "$RUN_DIR/summary.json" 2>/dev/null)"; then
    while IFS= read -r shot; do
      [ -n "$shot" ] || continue
      # 只收 <item>/screenshots/<名稱>.png|jpg|jpeg|webp；任何 . 或 .. 路徑段都不收（不能跳出 screenshots/）。
      if ! [[ "$shot" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*/screenshots/[A-Za-z0-9._/-]+\.([Pp][Nn][Gg]|[Jj][Pp][Ee]?[Gg]|[Ww][Ee][Bb][Pp])$ ]] \
        || [[ "/$shot/" == */./* || "/$shot/" == */../* ]]; then
        warn "summary.json 列到 ${shot}：不是 <item>/screenshots/ 底下的 png／jpg／webp，不送"
      elif [ -L "$RUN_DIR/$shot" ] || [ ! -f "$RUN_DIR/$shot" ]; then
        warn "summary.json 列到 ${shot}：run 目錄裡沒有這個檔（或是符號連結），不送"
      else
        FILES+=("$shot")
      fi
    done <<< "$shots"
  else
    warn "summary.json 不是合法的 JSON：照送（後台會標不合法），但讀不出截圖清單，這夜不送截圖"
  fi
else
  warn "${RUN_DIR} 沒有 summary.json（彙整可能失敗）：只送 run.json，後台會顯示這夜沒有彙整"
fi

# ── 鏡像會留哪幾夜（名稱 night-YYYYMMDD-HHMM[SS] 照字典序＝照時間） ──
NIGHTS=()
if [ -d "$MIRROR" ]; then
  for d in "$MIRROR"/*/; do
    [ -d "$d" ] || continue
    n="$(basename "$d")"
    [ "$n" = "$RUN_ID" ] || NIGHTS+=("$n")
  done
fi
NIGHTS+=("$RUN_ID")
SORTED=()   # bash 3.2（macOS 內建）沒有 mapfile
while IFS= read -r n; do SORTED+=("$n"); done < <(printf '%s\n' "${NIGHTS[@]}" | LC_ALL=C sort)
DROP=()
KEPT=()
for i in "${!SORTED[@]}"; do
  if [ "$i" -lt $(( ${#SORTED[@]} - KEEP )) ]; then DROP+=("${SORTED[$i]}"); else KEPT+=("${SORTED[$i]}"); fi
done
for n in ${DROP[@]+"${DROP[@]}"}; do
  [ "$n" != "$RUN_ID" ] || warn "${RUN_ID} 比鏡像裡留的 ${KEEP} 夜都舊，送了也會馬上被擠掉"
done

SSH_CMD="$SSH -o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=4"
RSYNC_ARGS=(-rt --perms --chmod=D755,F644 --delete --timeout=120 --exclude='/.build.*' -e "$SSH_CMD" "$MIRROR/" "$HOST:")

echo "這夜：${RUN_ID}（${RUN_DIR}）"
echo "要送的檔（${#FILES[@]} 個）："
printf '  %s\n' "${FILES[@]}"
echo "鏡像 ${MIRROR} 送完後留這幾夜（VM inbox 同步成一樣）：${KEPT[*]}"
[ "${#DROP[@]}" -eq 0 ] || echo "擠掉（鏡像與 VM inbox 都刪）：${DROP[*]}"

if [ "$DRY_RUN" = 1 ]; then
  echo "（--dry-run：不動鏡像、不連線）會跑：$RSYNC ${RSYNC_ARGS[*]}"
  exit 0
fi

# ── 重建這夜的鏡像：先在暫存目錄組好再換上，中途失敗不留半套 ──────
mkdir -p "$MIRROR"
chmod 700 "$MIRROR"
BUILD="$(mktemp -d "$MIRROR/.build.XXXXXX")"
trap 'rm -rf "$BUILD"' EXIT
for f in "${FILES[@]}"; do
  mkdir -p "$BUILD/$(dirname "$f")"
  cp -p "$RUN_DIR/$f" "$BUILD/$f"
done
rm -rf "${MIRROR:?}/$RUN_ID"
mv "$BUILD" "$MIRROR/$RUN_ID"
for n in ${DROP[@]+"${DROP[@]}"}; do
  rm -rf "${MIRROR:?}/$n"
done

# ── 一次 rsync＝一次 ssh 連線 ─────────────────────────────────
if ! "$RSYNC" "${RSYNC_ARGS[@]}"; then
  die "rsync 到 ${HOST} 失敗（鏡像已更新；修好連線後重跑：ops/status-publish-run.sh ${RUN_DIR}）"
fi
echo "已送上 ${HOST}：${RUN_ID}（${#FILES[@]} 個檔）"
