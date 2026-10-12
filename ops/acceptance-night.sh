#!/usr/bin/env bash
# 整夜網站驗收的總指揮（設計方案 e2e/acceptance/redesign/設計方案.md §3.4、§6、§13）。
# 💻 在 Roy 的 Mac、repo 根目錄跑；Mac 不能睡：
#
#   caffeinate -dims ops/acceptance-night.sh --plan full                            # 路 A：金鑰裝好了
#   caffeinate -dims ops/acceptance-night.sh --plan full --no-reset --no-snapshot   # 路 B：Roy 手動重置
#   caffeinate -dims ops/acceptance-night.sh --plan tonight                         # 10/9 試跑那套
#
# tonight 的做法：
#   0. 產整夜密碼 → ~/.fju-acceptance/<runId>/secrets/night.pw（0600，目錄 0700，報告目錄外）
#   1. 記開始 commit（測試站 /api/health）
#   2. 並行群 1：資安靜態掃描、兩位訪客人設、劇本第 1 章；每項一個 ops/codex-e2e.sh（掃描直接跑腳本）
#   3. 第 1 章結束後跑新手系辦人設（沒有「接力：可以」照跑，run.log 記 dependency-not-met）
#   4. 每項有預算（分鐘）：到了就停掉；非 0 或逾時且 progress.md 有進度、session id 已知 → resume 一次（預算減半）
#   5. 記結束 commit、遮蔽輸出裡的整夜密碼與 E2E 管理員密碼、刪 ~/.fju-acceptance/<runId>、叫 summarize-night.sh --vault
#   第 5 步在任何結束（含 Ctrl-C）都會做。
#
# full 的做法（§13.4）：
#   前置：ssh fju-reset status → pause-deploy → reset，再記開始 commit（每次 ssh 一個子命令、相隔至少 15 秒）
#   劇本鏈 story-1→6 一章接一章（security-static 同時跑）：每章開跑前把上一章「交給下一章的狀態」寫成 handoff.md；
#     章 failed／timeout 才停鏈（後面的章 skipped）；「接力：不可以」照跑下一章、記 dependency-not-met
#   story-2 是 ok（不看接力行）→ ssh fju-reset snapshot midterm，整夜密碼另存 ~/.fju-acceptance/snapshots/midterm.pw
#   UX：今晚存到快照且 status 列出 midterm → restore midterm，否則 restore skipped；人設分三批、每批最多 4 個同時、
#     同一批不會有兩個系辦；超過 08:00 剩下的批次記 not-run
#   最後（並行群 L）：前面全部結束（含 security-static）才一項一項跑，不和任何項目並行——
#     r1-login-limit 會把一個學生帳號從這台 Mac 鎖 10 分鐘，所以排整套最後
#   後置：記結束 commit → resume-deploy → 遮蔽、刪秘密 → summarize-night.sh --vault --polish
#
# 參數：
#   --plan tonight|full   計畫
#   --only a,b            只跑這幾項（項目 id 用逗號隔開）；full 時等於 --no-reset（重跑單項不清站）
#   --no-reset            （full）不重置、不暫停／恢復部署：Roy 手動做（§13.5 路 B）
#   --no-snapshot         （full）不存、不還原學期中快照：UX 跑在第 5 章結束的站上
#   --purge               刪掉 ~/.fju-acceptance 底下所有 run 的秘密（中途被停掉時用）；不給 --plan 就只做這件事
#   --dry-run             只印會做什麼：不建目錄、不產密碼、不連網、不叫 codex、不 ssh
#
# 進度：tail -f e2e/acceptance/.out/night-*/run.log
#
# 可調的環境變數（今晚都不用動）：
#   CODEX_E2E_MODEL / CODEX_E2E_SANDBOX  預設 gpt-6.1-sol／danger-full-access（交給 codex-e2e.sh）
#   ACCEPT_BUDGET_OVERRIDE  每項預算改成 N 分鐘（或 Ns＝N 秒）；測試看門狗用
#   ACCEPT_HEALTH_URL       取 commit 的網址，預設 https://test.fju.roy422.dev/api/health；測試指到本機假伺服器
#   ACCEPT_E2E_ROOT         清單、人設卡、掃描與彙整腳本的根目錄，預設 e2e/acceptance；測試指到假清單
#   ACCEPT_VAULT            彙整寫進的 Vault 工程開發目錄，預設由 summarize-night.sh --vault 決定；測試指到 /tmp
#   ACCEPT_RESET_GAP        兩次 ssh fju-reset 之間至少隔幾秒，預設 15（ssh 限速：30 秒內第 6 次新連線會被拒）；測試縮短用
#   ACCEPT_UX_DEADLINE      UX 批次的截止時刻 HH:MM（開始之後的下一次），預設 08:00；@<epoch 秒> 給測試用
#   PWCLI                   playwright-cli wrapper，預設 ~/.codex/skills/playwright/scripts/playwright_cli.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CODEX_E2E="$REPO_ROOT/ops/codex-e2e.sh"
PROMPT_FILE="$REPO_ROOT/ops/lib/acceptance-night-prompt.md"
E2E_ROOT="${ACCEPT_E2E_ROOT:-$REPO_ROOT/e2e/acceptance}"
OUT_ROOT="$REPO_ROOT/e2e/acceptance/.out"
SECRETS_ROOT="$HOME/.fju-acceptance"
HEALTH_URL="${ACCEPT_HEALTH_URL:-https://test.fju.roy422.dev/api/health}"
PWCLI="${PWCLI:-${CODEX_HOME:-$HOME/.codex}/skills/playwright/scripts/playwright_cli.sh}"
MODEL="${CODEX_E2E_MODEL:-gpt-6.1-sol}"
SANDBOX="${CODEX_E2E_SANDBOX:-danger-full-access}"
KILL_GRACE=10
STALE_MINUTES=2880   # 48 小時

# 計畫表：id｜清單（相對 E2E_ROOT）｜種類｜預算分鐘｜依賴｜並行群。
# 瀏覽器工作階段名一律 ${ACCEPT_ITEM}-<角色>（§3.2），預設工作階段＝<id>-main。
PLAN_TONIGHT=(
  "security-static|security/run-static.sh|script|30||1"
  "ux-visitor-highschool|personas/visitor-highschool.md|codex|60||1"
  "ux-visitor-industry|personas/visitor-industry.md|codex|60||1"
  "story-1|story-1-opening.md|codex|240||1"
  "ux-admin-newbie|personas/admin-newbie.md|codex|120|story-1|2"
)

# 全套（§6.1、§13.2）：並行群 S＝劇本鏈（依賴＝上一章）、P＝和劇本並行、U1–U3＝UX 三批、L＝整套最後一項一項跑（快照是第 2 章結束，
# 還沒有評分方案與指派，所以學期中系辦在第 1 批先建、評分老師在第 2 批）。每批最多 4 個、不得有兩個系辦（ux-admin-*）。
PLAN_FULL=(
  "security-static|security/run-static.sh|script|30||P"
  "story-1|story-1-opening.md|codex|240||S"
  "story-2|story-2-semester.md|codex|240|story-1|S"
  "story-3|story-3-grading-signoff.md|codex|180|story-2|S"
  "story-4|story-4-frontstage.md|codex|120|story-3|S"
  "story-5|story-5-words-and-ownership.md|codex|120|story-4|S"
  # 第 6 章（Q20 檔案進出、X3）接在第 5 章後面；不設依賴：第 5 章是最後一個「接力：不適用」的章、只看不改，
  # 設了每晚都會記 dependency-not-met。第 5 章 failed／timeout 照樣停鏈。
  "story-6|story-6-csv-and-guards.md|codex|120||S"
  "ux-admin-midterm|personas/admin-midterm.md|codex|120||U1"
  "ux-leader|personas/leader.md|codex|90||U1"
  "ux-member|personas/member.md|codex|90||U1"
  "ux-ungrouped|personas/ungrouped.md|codex|90||U1"
  "ux-grader|personas/grader.md|codex|90||U2"
  "ux-advisor|personas/advisor.md|codex|90||U2"
  "ux-freshman|personas/freshman.md|codex|90||U2"
  "ux-visitor-highschool|personas/visitor-highschool.md|codex|60||U2"
  "ux-visitor-industry|personas/visitor-industry.md|codex|60||U3"
  "ux-admin-newbie|personas/admin-newbie.md|codex|120||U3"
  # L＝整套最後、一項一項跑（R1 登入次數限制會鎖帳號 10 分鐘，不能和別的項目並行）。
  "r1-login-limit|r1-login-rate-limit.md|codex|30||L"
)
UX_BATCHES=(U1 U2 U3)
UX_BATCH_MAX=4

usage() {
  sed -n '2,45p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

die() {
  printf '%s\n' "$*" >&2
  exit 1
}

PLAN=""
ONLY=""
PURGE=0
DRY_RUN=0
NO_RESET=0
NO_SNAPSHOT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --plan) [ $# -ge 2 ] || die "--plan 要給 tonight 或 full"; PLAN="$2"; shift ;;
    --plan=*) PLAN="${1#--plan=}" ;;
    --only) [ $# -ge 2 ] || die "--only 要給項目 id"; ONLY="$2"; shift ;;
    --only=*) ONLY="${1#--only=}" ;;
    --purge) PURGE=1 ;;
    --no-reset) NO_RESET=1 ;;
    --no-snapshot) NO_SNAPSHOT=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage 0 ;;
    *) echo "不認得的參數：$1" >&2; usage 1 ;;
  esac
  shift
done

purge_secrets() {
  # 只刪 run 目錄（night-*）；snapshots/ 是全套跨夜用的，不刪。
  local dir
  for dir in "$SECRETS_ROOT"/night-*; do
    [ -d "$dir" ] || continue
    rm -rf "$dir"
    echo "已刪：$dir"
  done
}

if [ -z "$PLAN" ]; then
  if [ "$PURGE" = 1 ] && [ "$DRY_RUN" = 0 ]; then
    purge_secrets
    exit 0
  fi
  die "用法：ops/acceptance-night.sh --plan tonight|full [--only a,b] [--no-reset] [--no-snapshot] [--dry-run] [--purge]"
fi
case "$PLAN" in
  tonight)
    PLAN_ROWS=("${PLAN_TONIGHT[@]}")
    [ "$NO_RESET$NO_SNAPSHOT" = 00 ] || die "--no-reset／--no-snapshot 只用在 --plan full（tonight 本來就不重置、不存快照）"
    ;;
  full) PLAN_ROWS=("${PLAN_FULL[@]}") ;;
  *) die "--plan 只能是 tonight 或 full（收到：${PLAN}）" ;;
esac
# 重跑單項不清站：--only 等於 --no-reset。
NO_RESET_WHY="--no-reset"
if [ "$PLAN" = full ] && [ -n "$ONLY" ] && [ "$NO_RESET" = 0 ]; then
  NO_RESET=1
  NO_RESET_WHY="--only 等於 --no-reset"
fi
case "$SANDBOX" in
  read-only|workspace-write|danger-full-access) ;;
  *) die "CODEX_E2E_SANDBOX 只能是 read-only、workspace-write 或 danger-full-access（收到：${SANDBOX}）" ;;
esac
if [ -n "${ACCEPT_BUDGET_OVERRIDE:-}" ]; then
  [[ "$ACCEPT_BUDGET_OVERRIDE" =~ ^[0-9]+s?$ ]] || die "ACCEPT_BUDGET_OVERRIDE 要是 N（分鐘）或 Ns（秒）"
fi
if [ -n "${ACCEPT_UX_DEADLINE:-}" ]; then
  [[ "$ACCEPT_UX_DEADLINE" =~ ^(([01][0-9]|2[0-3]):[0-5][0-9]|@[0-9]+)$ ]] || die "ACCEPT_UX_DEADLINE 要是 HH:MM 或 @<epoch 秒>"
fi
[[ "${ACCEPT_RESET_GAP:-15}" =~ ^[0-9]+$ ]] || die "ACCEPT_RESET_GAP 要是秒數"

# ── 選項目（bash 3.2：用平行陣列，不用關聯陣列）──────────────────
IDS=() LISTS=() KINDS=() BUDGETS=() DEPS=() GROUPS_=()
row_selected() {
  local id="$1" want
  [ -n "$ONLY" ] || return 0
  for want in ${ONLY//,/ }; do [ "$want" = "$id" ] && return 0; done
  return 1
}
for want in ${ONLY//,/ }; do
  found=0
  for row in "${PLAN_ROWS[@]}"; do [ "${row%%|*}" = "$want" ] && found=1; done
  [ "$found" = 1 ] || die "--only 裡的 $want 不在 $PLAN 計畫表裡"
done
for row in "${PLAN_ROWS[@]}"; do
  IFS='|' read -r r_id r_list r_kind r_budget r_dep r_group <<<"$row"
  row_selected "$r_id" || continue
  IDS+=("$r_id"); LISTS+=("$r_list"); KINDS+=("$r_kind"); BUDGETS+=("$r_budget"); DEPS+=("$r_dep"); GROUPS_+=("$r_group")
done
[ "${#IDS[@]}" -gt 0 ] || die "沒有選到任何項目"

# UX 批次防呆（§6.2、§13.2）：每批最多 UX_BATCH_MAX 個、不得有兩個系辦。計畫表改壞了就不開跑。
if [ "$PLAN" = full ]; then
  for b in "${UX_BATCHES[@]}"; do
    n=0 admins=0
    for row in "${PLAN_ROWS[@]}"; do
      IFS='|' read -r r_id _ _ _ _ r_group <<<"$row"
      [ "$r_group" = "$b" ] || continue
      n=$((n + 1))
      case "$r_id" in ux-admin-*) admins=$((admins + 1)) ;; esac
    done
    [ "$n" -le "$UX_BATCH_MAX" ] || die "計畫表錯：UX 批次 $b 有 $n 個（最多 ${UX_BATCH_MAX}）"
    [ "$admins" -le 1 ] || die "計畫表錯：UX 批次 $b 有 $admins 個系辦（同一批最多 1 個）"
  done
fi

is_selected() {
  local id
  for id in "${IDS[@]}"; do [ "$id" = "$1" ] && return 0; done
  return 1
}

# 秒數：預算分鐘×60；ACCEPT_BUDGET_OVERRIDE 蓋掉全部項目。
budget_seconds() {
  local minutes="$1" o="${ACCEPT_BUDGET_OVERRIDE:-}"
  case "$o" in
    "") echo $((minutes * 60)) ;;
    *s) echo "${o%s}" ;;
    *) echo $((o * 60)) ;;
  esac
}

RUN_ID="night-$(date +%Y%m%d-%H%M)"
RUN_DIR="$OUT_ROOT/$RUN_ID"
if [ -e "$RUN_DIR" ] || [ -e "$SECRETS_ROOT/$RUN_ID" ]; then
  RUN_ID="night-$(date +%Y%m%d-%H%M%S)"
  RUN_DIR="$OUT_ROOT/$RUN_ID"
fi
SECRET_DIR="$SECRETS_ROOT/$RUN_ID"
PW_FILE="$SECRET_DIR/secrets/night.pw"
STATE_DIR="$SECRET_DIR/state"

# 列出某並行群選到的項目 id（空白隔開）。
ids_in_group() {
  local i out=""
  for i in "${!IDS[@]}"; do [ "${GROUPS_[$i]}" = "$1" ] && out="$out ${IDS[$i]}"; done
  printf '%s' "${out# }"
}

# 全套 dry-run 的順序。--no-reset／--no-snapshot 時整段不得出現重置主機別名（F11 驗收用 grep 檢查）。
print_full_order() {
  local reset_cmd="ssh fju-reset" stories ux last b n=0
  echo "順序（full）："
  if [ "$NO_RESET" = 1 ]; then
    echo "  前置：不重置、不暫停部署（${NO_RESET_WHY}；Roy 手動做）→ 記開始 commit"
  else
    echo "  前置：$reset_cmd status → $reset_cmd pause-deploy → $reset_cmd reset → 記開始 commit"
    echo "        （每個子命令一次連線、相鄰兩次至少隔 ${ACCEPT_RESET_GAP:-15} 秒；任一步失敗就停，收尾仍會 resume-deploy）"
  fi
  stories="$(ids_in_group S)"
  if [ -n "$stories" ]; then
    echo "  劇本鏈（一章接一章）：${stories// / → }"
    echo "    每章開跑前：上一章報告的「## 交給下一章的狀態」整節 → story-N/handoff.md（沒有報告就寫「上一章沒有報告」；第 1 章不寫）"
    echo "    某章 failed／timeout → 後面的章 skipped（停鏈）；「接力：不可以」→ 記 dependency-not-met、照跑下一章"
    echo "    每章開跑前記一次 commit，和開始不同就記 commit-changed"
  fi
  if [ "$NO_SNAPSHOT" = 1 ]; then
    echo "    第 2 章後：不存快照（--no-snapshot；run.log 記 snapshot skipped）"
  elif is_selected story-2; then
    echo "    story-2 status ok（不看接力行）→ $reset_cmd snapshot midterm → 整夜密碼另存 $SECRETS_ROOT/snapshots/midterm.pw（0600）"
  fi
  [ -z "$(ids_in_group P)" ] || echo "  同時（和劇本並行）：$(ids_in_group P)"
  ux=""
  for b in "${UX_BATCHES[@]}"; do ux="$ux$(ids_in_group "$b")"; done
  if [ -n "$ux" ]; then
    if [ "$NO_SNAPSHOT" = 1 ]; then
      echo "  UX：不還原快照（--no-snapshot）；人設跑在第 5 章結束的站上"
    else
      echo "  UX 前：今晚存到快照 → $reset_cmd status 確認有 midterm → $reset_cmd restore midterm（不在就 restore skipped，跑在當下的站上）"
    fi
    for b in "${UX_BATCHES[@]}"; do
      n=$((n + 1))
      [ -z "$(ids_in_group "$b")" ] || echo "    第 $n 批（同時，最多 ${UX_BATCH_MAX} 個、最多 1 個系辦）：$(ids_in_group "$b")"
    done
    echo "    過了 ${ACCEPT_UX_DEADLINE:-08:00} 還沒開始的批次記 not-run，不硬跑"
  fi
  last="$(ids_in_group L)"
  [ -z "$last" ] || echo "  最後（等劇本、UX、同時跑的項目全部結束；一項一項跑，不並行）：${last// / → }"
  echo "  每項逾時 → 停掉；progress.md 有進度且 session id 已知 → resume 一次（預算減半）"
  if [ "$NO_RESET" = 1 ]; then
    echo "  後置：記結束 commit（不恢復部署：${NO_RESET_WHY}）"
  else
    echo "  後置：記結束 commit → $reset_cmd resume-deploy（任何結束都做，含 Ctrl-C）"
  fi
  echo "  最後：遮蔽整夜密碼與 E2E 管理員密碼 → 刪 $SECRET_DIR → $E2E_ROOT/summarize-night.sh $RUN_DIR --vault ${ACCEPT_VAULT:-（預設 Vault）} --polish"
}

# ── --dry-run：只印，不碰檔案系統、不連網 ──────────────────────
if [ "$DRY_RUN" = 1 ]; then
  echo "計畫：${PLAN}（dry-run：不建目錄、不產密碼、不連網、不叫 codex）"
  echo "run 目錄：$RUN_DIR"
  echo "秘密目錄：${SECRET_DIR}（secrets/night.pw 0600、state/；結束時整個刪）"
  echo "Codex：模型 ${MODEL}、沙盒 ${SANDBOX}；測試站 commit 取自 ${HEALTH_URL}（開始、結束各一次）"
  [ "$PURGE" = 1 ] && echo "--purge：開始前會刪 $SECRETS_ROOT/night-*"
  echo ""
  printf '%-22s %-36s %-8s %6s  %-6s %-10s %s\n' 項目 清單 種類 預算分 並行群 依賴 工作階段
  for i in "${!IDS[@]}"; do
    session="${IDS[$i]}-main"
    [ "${KINDS[$i]}" = script ] && session="—"
    note=""
    [ -f "$E2E_ROOT/${LISTS[$i]}" ] || note="（檔案還沒有）"
    printf '%-22s %-36s %-8s %6s  %-6s %-10s %s\n' "${IDS[$i]}" "${LISTS[$i]}$note" "${KINDS[$i]}" \
      "$(( $(budget_seconds "${BUDGETS[$i]}") / 60 ))" "${GROUPS_[$i]}" "${DEPS[$i]:-—}" "$session"
  done
  echo ""
  if [ "$PLAN" = full ]; then
    print_full_order
    exit 0
  fi
  echo "順序："
  group1="" group2=""
  for i in "${!IDS[@]}"; do
    if [ -n "${DEPS[$i]}" ] && is_selected "${DEPS[$i]}"; then
      group2="$group2 ${IDS[$i]}（等 ${DEPS[$i]} 結束；沒有「接力：可以」記 dependency-not-met 照跑）"
    else
      group1="$group1 ${IDS[$i]}"
    fi
  done
  echo "  群 1 同時開始：${group1# }"
  [ -z "$group2" ] || echo "  群 2：${group2# }"
  echo "  每項逾時 → 停掉；progress.md 有進度且 session id 已知 → resume 一次（預算減半）"
  echo "  最後：記結束 commit → 遮蔽整夜密碼與 E2E 管理員密碼 → 刪 $SECRET_DIR → $E2E_ROOT/summarize-night.sh $RUN_DIR --vault ${ACCEPT_VAULT:-（預設 Vault）}"
  exit 0
fi

# ── 開跑前檢查：缺檔 23:00 就要知道，不要 02:00 才發現 ──────────
missing=()
for i in "${!IDS[@]}"; do
  [ -f "$E2E_ROOT/${LISTS[$i]}" ] || missing+=("$E2E_ROOT/${LISTS[$i]}")
done
[ "${#missing[@]}" -eq 0 ] || die "找不到這些清單或腳本：${missing[*]}"
[ -x "$CODEX_E2E" ] || die "找不到 $CODEX_E2E"
[ -s "$PROMPT_FILE" ] || die "找不到 $PROMPT_FILE"
command -v jq >/dev/null 2>&1 || die "找不到 jq"
command -v doppler >/dev/null 2>&1 || die "找不到 doppler 指令"

# E2E 管理員密碼只為了收尾的洩漏遮蔽：只留在這支腳本的變數裡（不 export、不寫檔、不印）。
ADMIN_PW="$(DOPPLER_ENABLE_VERSION_CHECK=false doppler secrets get E2E_ADMIN_PASSWORD --plain --project fju-im-capstone --config stg)" \
  || die "從 Doppler fju-im-capstone／stg 取不到 E2E_ADMIN_PASSWORD（先 doppler login）。"
[ -n "$ADMIN_PW" ] || die "Doppler stg 的 E2E_ADMIN_PASSWORD 是空的。"

if [ "$PURGE" = 1 ]; then
  purge_secrets
fi
# 超過 48 小時的舊秘密目錄（上次被人為停掉沒刪到的）自動刪。
if [ -d "$SECRETS_ROOT" ]; then
  find "$SECRETS_ROOT" -mindepth 1 -maxdepth 1 -type d -name 'night-*' -mmin +"$STALE_MINUTES" -exec rm -rf {} + 2>/dev/null || true
fi

umask 077
mkdir -p "$RUN_DIR"
RESULTS="$RUN_DIR/.results"
mkdir -p "$RESULTS" "$RUN_DIR/logs"
RUN_LOG="$RUN_DIR/run.log"
STARTED_AT="$(date +%Y-%m-%dT%H:%M:%S%z)"
RUN_START_EPOCH="$(date +%s)"

# run.log 一行：時間  事件  項目  細節（事件與項目之間只有空白，grep 'timeout\s+story-1' 抓得到）
log() {
  local line
  line="$(printf '%s  %-18s %-22s %s' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" "${2:--}" "${3:-}")"
  printf '%s\n' "$line" >> "$RUN_LOG"
  printf '%s\n' "$line"
}

now_iso() { date +%Y-%m-%dT%H:%M:%S%z; }

fetch_commit() {
  local body commit
  body="$(curl -s --max-time 20 "$HEALTH_URL" 2>/dev/null || true)"
  commit="$(printf '%s' "$body" | jq -r '.commit // empty' 2>/dev/null | cut -c1-8 || true)"
  [[ "$commit" =~ ^[0-9a-f]{8}$ ]] || commit=unknown
  printf '%s\n' "$commit"
}

COMMIT_START=unknown
COMMIT_END=""
PASSWORD_LEAKED=false
FINISHED_AT=""

# full：每章開頭量到和開始不同的 commit，一行一筆「項目|commit|時間」；run.json 的 commitMidway 陣列。
midway_json() {
  local f="$RESULTS/commit-midway"
  if [ -s "$f" ]; then
    jq -Rn '[inputs | split("|") | {item: .[0], commit: .[1], at: .[2]}]' < "$f"
  else
    echo '[]'
  fi
}

write_run_json() {
  local i id f status started finished exit_code resumed note items=""
  for i in "${!IDS[@]}"; do
    id="${IDS[$i]}"
    status=not-run started="" finished="" exit_code=null resumed=false note=""
    [ -f "$RESULTS/$id.start" ] && { started="$(cat "$RESULTS/$id.start")"; status=running; }
    if [ -f "$RESULTS/$id.result" ]; then
      IFS='|' read -r status started finished exit_code resumed < "$RESULTS/$id.result"
    elif [ -n "$FINISHED_AT" ] && [ "$status" = running ]; then
      status=interrupted
    fi
    f="$RESULTS/$id.note"
    [ -f "$f" ] && note="$(cat "$f")"
    items="$items$(jq -cn --arg id "$id" --arg kind "${KINDS[$i]}" --arg status "$status" \
      --arg s "$started" --arg f "$finished" --argjson exit "${exit_code:-null}" --argjson resumed "$resumed" \
      --arg note "$note" \
      '{id:$id,kind:$kind,status:$status,startedAt:$s,finishedAt:$f,exit:$exit,resumed:$resumed} + (if $note=="" then {} else {note:$note} end)'),"
  done
  jq -n --arg runId "$RUN_ID" --arg plan "$PLAN" --arg s "$STARTED_AT" --arg f "$FINISHED_AT" \
    --arg cs "$COMMIT_START" --arg ce "$COMMIT_END" --argjson leaked "$PASSWORD_LEAKED" \
    --argjson items "[${items%,}]" \
    --argjson cm "$(midway_json)" \
    '{runId:$runId,plan:$plan,startedAt:$s,finishedAt:$f,commitStart:$cs,commitEnd:$ce,items:$items,passwordLeaked:$leaked}
     + (if ($cm|length)==0 then {} else {commitMidway:$cm} end)' \
    > "$RUN_DIR/run.json.tmp"
  mv "$RUN_DIR/run.json.tmp" "$RUN_DIR/run.json"
}

# ── 看門狗：Mac 沒有 timeout。背景跑、到時間先 TERM 子孫（codex-e2e.sh 本身還能做完洩漏檢查），
#    KILL_GRACE 秒後連本體一起 KILL ──────────────────────────────
descendants() {
  local child
  for child in $(pgrep -P "$1" 2>/dev/null || true); do
    descendants "$child"
    echo "$child"
  done
}

stop_children() {
  # stop_children <pid>：收尾用，只停 pid 的子孫（pid＝orchestrator 自己）；先 TERM，等 KILL_GRACE 秒，還在就 KILL。
  local pid="$1" pids waited=0 p alive
  pids="$(descendants "$pid")"
  # shellcheck disable=SC2086  # pid 清單刻意 word-split
  [ -z "${pids// /}" ] || kill -TERM $pids 2>/dev/null || true
  while [ "$waited" -lt "$KILL_GRACE" ]; do
    alive=0
    for p in $pids; do kill -0 "$p" 2>/dev/null && alive=1; done
    [ "$alive" = 1 ] || return 0
    sleep 1
    waited=$((waited + 1))
  done
  pids="$pids $(descendants "$pid")"
  # shellcheck disable=SC2086
  kill -KILL $pids 2>/dev/null || true
}

# 看門狗用：先 TERM 子孫（沒有子孫就 TERM 本體），等 KILL_GRACE 秒讓本體收尾；時間到連本體一起 KILL。
stop_watched() {
  local pid="$1" kids waited=0
  kids="$(descendants "$pid")"
  if [ -n "$kids" ]; then
    # shellcheck disable=SC2086  # pid 清單刻意 word-split
    kill -TERM $kids 2>/dev/null || true
  else
    kill -TERM "$pid" 2>/dev/null || true
  fi
  while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt "$KILL_GRACE" ]; do
    sleep 1
    waited=$((waited + 1))
  done
  kids="$kids $(descendants "$pid")"
  # shellcheck disable=SC2086
  kill -KILL $kids "$pid" 2>/dev/null || true
}

WD_TIMED_OUT=0
run_with_watchdog() {
  # run_with_watchdog <秒> <輸出檔> <函式或指令…>；結束碼＝指令的結束碼，逾時設 WD_TIMED_OUT=1
  local budget="$1" out="$2" pid deadline status=0
  shift 2
  WD_TIMED_OUT=0
  ( "$@" ) < /dev/null >> "$out" 2>&1 &
  pid=$!
  deadline=$((SECONDS + budget))
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      WD_TIMED_OUT=1
      stop_watched "$pid"
      break
    fi
    sleep 1
  done
  wait "$pid" || status=$?
  return "$status"
}

# 交給 codex-e2e.sh 的環境：整夜密碼只在這個子 shell 裡 export，不進指令列。
launch_codex() {
  local id="$1" list="$2" resume_id="$3"
  export ACCEPT_PASSWORD="$NIGHT_PW"
  export ACCEPT_STATE_DIR="$STATE_DIR"
  export ACCEPT_ITEM="$id"
  export PLAYWRIGHT_CLI_SESSION="$id-main"
  export CODEX_E2E_RUN_DIR="$RUN_DIR/$id"
  export CODEX_E2E_KEEP_SESSION=1
  export CODEX_E2E_EXTRA_ENV="ACCEPT_PASSWORD ACCEPT_STATE_DIR PLAYWRIGHT_CLI_SESSION ACCEPT_ITEM"
  export CODEX_E2E_EXTRA_SECRET_FILE="$PW_FILE"
  export CODEX_E2E_PROMPT_FILE="$PROMPT_FILE"
  export CODEX_E2E_MODEL="$MODEL"
  export CODEX_E2E_SANDBOX="$SANDBOX"
  if [ -n "$resume_id" ]; then
    export CODEX_E2E_RESUME="$resume_id"
  else
    unset CODEX_E2E_RESUME
  fi
  exec "$CODEX_E2E" "$E2E_ROOT/$list"
}

launch_script() {
  local id="$1" list="$2"
  local commit_arg=()
  [ "$COMMIT_START" = unknown ] || commit_arg=("$COMMIT_START")
  exec bash "$E2E_ROOT/$list" "$RUN_DIR/$id" ${commit_arg[@]+"${commit_arg[@]}"}
}

# 項目結束後關掉它開的瀏覽器（名稱帶 <id>- 前綴），下一項才不會接到別人的 session。
close_sessions() {
  local id="$1" names name
  names="$( (run_with_watchdog 60 /dev/stdout "$PWCLI" list 2>/dev/null || true) \
    | grep -oE "(^|[^A-Za-z0-9_-])${id}-[A-Za-z0-9_-]+" | grep -oE "${id}-[A-Za-z0-9_-]+" | sort -u || true)"
  for name in $(printf '%s\n%s\n' "$id-main" "$names" | sort -u); do
    run_with_watchdog 60 "$RUN_DIR/pwcli.log" "$PWCLI" --session "$name" close || true
  done
}

progress_lines() {
  local f="$RUN_DIR/$1/progress.md"
  [ -f "$f" ] || { echo 0; return; }
  grep -c . "$f" || true
}

run_item() {
  local i="$1" id list kind budget dir started status exit_code=0 resumed=false sid
  id="${IDS[$i]}" list="${LISTS[$i]}" kind="${KINDS[$i]}"
  budget="$(budget_seconds "${BUDGETS[$i]}")"
  dir="$RUN_DIR/$id"
  mkdir -p "$dir"
  started="$(now_iso)"
  printf '%s\n' "$started" > "$RESULTS/$id.start"
  log start "$id" "budget=${budget}s kind=$kind"

  if [ "$kind" = script ]; then
    run_with_watchdog "$budget" "$RUN_DIR/logs/$id.log" launch_script "$id" "$list" || exit_code=$?
    if [ "$WD_TIMED_OUT" = 1 ]; then
      log timeout "$id" "預算 ${budget}s 到，已停掉"
      status=timeout
    elif [ "$exit_code" = 0 ]; then
      status=ok
    else
      status=failed
    fi
  else
    run_with_watchdog "$budget" "$RUN_DIR/logs/$id.log" launch_codex "$id" "$list" "" || exit_code=$?
    if [ "$WD_TIMED_OUT" = 1 ]; then
      log timeout "$id" "預算 ${budget}s 到，已停掉"
    elif [ "$exit_code" != 0 ]; then
      log exit "$id" "codex-e2e.sh 以 $exit_code 結束"
    fi
    if [ "$WD_TIMED_OUT" = 0 ] && [ "$exit_code" = 0 ]; then
      status=ok
    else
      sid="$(head -1 "$dir/codex-session.txt" 2>/dev/null || true)"
      sid="${sid:-unknown}"
      if [ "$(progress_lines "$id")" -lt 1 ]; then
        log no-resume "$id" "progress.md 沒有任何一步"
        if [ "$WD_TIMED_OUT" = 1 ]; then status=timeout; else status=failed; fi
      elif [ "$sid" = unknown ]; then
        log no-resume "$id" "session=unknown"
        status=failed
      else
        budget=$((budget / 2))
        resumed=true
        exit_code=0
        log resume "$id" "session=$sid budget=${budget}s"
        run_with_watchdog "$budget" "$RUN_DIR/logs/$id.log" launch_codex "$id" "$list" "$sid" || exit_code=$?
        if [ "$WD_TIMED_OUT" = 1 ]; then
          log timeout "$id" "續跑預算 ${budget}s 到，已停掉"
          status=failed
        elif [ "$exit_code" = 0 ]; then
          status=resumed
        else
          log exit "$id" "續跑以 $exit_code 結束"
          status=failed
        fi
      fi
    fi
    close_sessions "$id"
  fi
  [ "$WD_TIMED_OUT" = 1 ] && [ "$exit_code" = 0 ] && exit_code=143
  printf '%s|%s|%s|%s|%s\n' "$status" "$started" "$(now_iso)" "$exit_code" "$resumed" > "$RESULTS/$id.result"
  log end "$id" "status=$status exit=$exit_code resumed=$resumed"
}

# ── 全套（--plan full）────────────────────────────────────────
RESET_GAP="${ACCEPT_RESET_GAP:-15}"
RESET_LAST=""   # 上一次 ssh 的時間（SECONDS）：發出時先記，回來後改成結束時間
RESET_OUT=""
PAUSED=0
SNAPSHOT_STATE=""   # taken／skipped／failed；空＝還沒決定

# fju_reset <預算秒> <子命令> [名稱]：一個子命令一次 ssh 連線（§6.4；gate 只認 SSH_ORIGINAL_COMMAND 的字）。
# 和上一次 ssh 至少隔 RESET_GAP 秒（ssh 限速：30 秒內第 6 次新連線會被拒）。上一次被 Ctrl-C 打斷也算一次：
# 發出前就先記時間，收尾的 resume-deploy 才不會緊接著被打斷的那次連線送出。輸出累積在 logs/fju-reset.log，
# 這一次的輸出另放 RESET_OUT 讓呼叫端讀（status 看有沒有 midterm）。
fju_reset() {
  local budget="$1" status=0 wait_s
  shift
  if [ -n "$RESET_LAST" ]; then
    # SECONDS 是整數秒，多等 1 秒才保證真的隔滿。
    wait_s=$((RESET_LAST + RESET_GAP + 1 - SECONDS))
    [ "$wait_s" -le 0 ] || sleep "$wait_s"
  fi
  RESET_OUT="$RUN_DIR/logs/fju-reset.last"
  : > "$RESET_OUT"
  log reset-call - "ssh fju-reset $*"
  RESET_LAST=${SECONDS}
  run_with_watchdog "$budget" "$RESET_OUT" ssh fju-reset "$@" || status=$?
  RESET_LAST=${SECONDS}
  [ "$WD_TIMED_OUT" = 0 ] || status=124
  { printf '── %s  ssh fju-reset %s（exit=%s）\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" "$status"; cat "$RESET_OUT"; } \
    >> "$RUN_DIR/logs/fju-reset.log"
  return "$status"
}

# 前置：status → pause-deploy → reset。任一步失敗回 1（呼叫端停掉整夜；收尾照樣 resume-deploy）。
pre_reset() {
  if [ "$NO_RESET" = 1 ]; then
    log reset - "reset skipped（${NO_RESET_WHY}）：不重置、不暫停部署"
    return 0
  fi
  if ! fju_reset 120 status; then
    log reset-failed - "status 失敗（見 logs/fju-reset.log）；金鑰沒裝好就改用 --no-reset --no-snapshot（§13.5 路 B）"
    return 1
  fi
  # pause 半途失敗也可能已經 touch 了；resume-deploy 對沒暫停的站是空操作，所以先記要恢復。
  PAUSED=1
  if ! fju_reset 120 pause-deploy; then
    log reset-failed - "pause-deploy 失敗（見 logs/fju-reset.log）"
    return 1
  fi
  if ! fju_reset 2400 reset; then
    log reset-failed - "reset 失敗（見 logs/fju-reset.log）；站可能停在半途，先 ssh fju-reset status 看"
    return 1
  fi
  log reset - "reset ok"
}

# 寫一筆不跑的結果（skipped／not-run）；五欄都要有值，write_run_json 才讀得動。
mark_result() {
  local id="$1" status="$2" note="$3"
  printf '%s|||null|false\n' "$status" > "$RESULTS/$id.result"
  printf '%s\n' "$note" > "$RESULTS/$id.note"
}

item_status() {
  local st=missing
  [ -f "$RESULTS/$1.result" ] && IFS='|' read -r st _ < "$RESULTS/$1.result"
  printf '%s\n' "$st"
}

# 每章開跑前：上一章報告的「## 交給下一章的狀態」整節 → story-N/handoff.md（§13.4；第 1 章不寫）。
write_handoff() {
  local id="$1" n prev_report out
  n="${id#story-}"
  [ "$n" -gt 1 ] || return 0
  prev_report="$RUN_DIR/story-$((n - 1))/report.md"
  out="$RUN_DIR/$id/handoff.md"
  mkdir -p "$RUN_DIR/$id"
  if [ ! -s "$prev_report" ]; then
    printf '上一章沒有報告\n' > "$out"
  elif grep -q '^## 交給下一章的狀態' "$prev_report"; then
    awk '/^## 交給下一章的狀態/ { on = 1; print; next }
         on && (/^## / || /^總結：/ || /^接力：/) { exit }
         on { print }' "$prev_report" > "$out"
  else
    printf '上一章的報告沒有「交給下一章的狀態」一節\n' > "$out"
  fi
  log handoff "$id" "story-$((n - 1)) → $id/handoff.md"
}

# §6.5：每章開頭都記 commit；和開始不同就記下來（總覽要警告）。
check_commit() {
  local id="$1" now
  now="$(fetch_commit)"
  if [ "$now" != unknown ] && [ "$COMMIT_START" != unknown ] && [ "$now" != "$COMMIT_START" ]; then
    log commit-changed "$id" "start=$COMMIT_START now=$now"
    printf '%s|%s|%s\n' "$id" "$now" "$(now_iso)" >> "$RESULTS/commit-midway"
  else
    log commit "$id" "commit=$now"
  fi
}

# 學期中快照（§6.2、§13.4）：story-2 status 是 ok／resumed 就存，不看接力行。
take_snapshot() {
  local st="$1" snap_dir="$SECRETS_ROOT/snapshots"
  if [ "$NO_SNAPSHOT" = 1 ]; then
    SNAPSHOT_STATE=skipped
    log snapshot - "snapshot skipped（--no-snapshot）"
    return 0
  fi
  if [ "$st" != ok ] && [ "$st" != resumed ]; then
    SNAPSHOT_STATE=skipped
    log snapshot - "snapshot skipped（story-2 status=${st}）"
    return 0
  fi
  if fju_reset 1800 snapshot midterm; then
    # 快照裡的帳號密碼就是今晚的 night.pw；跨夜重用快照時要用它，所以留著（0600，--purge 不刪）。
    mkdir -p "$snap_dir"
    chmod 700 "$snap_dir"
    cp "$PW_FILE" "$snap_dir/midterm.pw.tmp"
    chmod 600 "$snap_dir/midterm.pw.tmp"
    mv "$snap_dir/midterm.pw.tmp" "$snap_dir/midterm.pw"
    SNAPSHOT_STATE=taken
    log snapshot - "snapshot midterm ok（密碼另存 $snap_dir/midterm.pw）"
  else
    SNAPSHOT_STATE=failed
    log snapshot-failed - "snapshot midterm 失敗（見 logs/fju-reset.log）；UX 會跑在第 5 章結束的站上"
  fi
}

# 劇本鏈：一章接一章。failed／timeout 才停鏈；「接力：不可以」照跑下一章並記 dependency-not-met（§13.2）。
run_story_chain() {
  local i id prev st stopped=""
  for i in "${!IDS[@]}"; do
    [ "${GROUPS_[$i]}" = S ] || continue
    id="${IDS[$i]}"
    if [ -n "$stopped" ]; then
      mark_result "$id" skipped "skipped：$stopped"
      log skipped "$id" "$stopped"
      write_run_json
      continue
    fi
    prev="${DEPS[$i]}"
    write_handoff "$id"
    if [ -n "$prev" ] && is_selected "$prev" && ! grep -qE '^接力：可以' "$RUN_DIR/$prev/report.md" 2>/dev/null; then
      log dependency-not-met "$id" "$prev 沒有「接力：可以」，照跑（上一章實際狀態在 $id/handoff.md）"
      printf 'dependency-not-met\n' > "$RESULTS/$id.note"
    fi
    check_commit "$id"
    run_item "$i" &
    wait $! || true
    write_run_json
    st="$(item_status "$id")"
    case "$st" in
      failed|timeout|missing)
        stopped="$id status=${st}，劇本鏈停在這章"
        log chain-stopped "$id" "status=${st}：後面的章不跑，直接進 UX"
        ;;
    esac
    [ "$id" != story-2 ] || take_snapshot "$st"
  done
  if [ -z "$SNAPSHOT_STATE" ]; then
    SNAPSHOT_STATE=skipped
    if [ "$NO_SNAPSHOT" = 1 ]; then
      log snapshot - "snapshot skipped（--no-snapshot）"
    else
      log snapshot - "snapshot skipped（story-2 沒有跑）"
    fi
  fi
}

# UX 前還原快照：只還原今晚存的；restore 前先 status 確認快照在（§13.4）。
restore_midterm() {
  if [ "$NO_SNAPSHOT" = 1 ]; then
    log restore - "restore skipped（--no-snapshot）；UX 跑在當下的站上"
    return 0
  fi
  if [ "$SNAPSHOT_STATE" != taken ]; then
    log restore - "restore skipped（今晚沒存到快照）；UX 跑在當下的站上"
    return 0
  fi
  if ! fju_reset 120 status; then
    log restore - "restore skipped（status 失敗）；UX 跑在當下的站上"
    return 0
  fi
  # status 一行一個 key=value；只看 snapshots= 那行（last_run= 也可能出現 midterm 字樣）。
  if ! grep -qE '^snapshots=(.*[ ,])?midterm([ ,]|$)' "$RESET_OUT"; then
    log restore - "restore skipped（status 的 snapshots= 沒有 midterm）；UX 跑在當下的站上"
    return 0
  fi
  if fju_reset 2400 restore midterm; then
    log restore - "restore midterm ok"
  else
    log restore-failed - "restore midterm 失敗（見 logs/fju-reset.log）；UX 照跑，結果可能是環境問題"
  fi
}

# UX 截止（epoch 秒）：開始之後的下一次 HH:MM；@<epoch> 直接用。
ux_deadline_epoch() {
  local v="${ACCEPT_UX_DEADLINE:-08:00}" start_epoch at
  case "$v" in
    @*) printf '%s\n' "${v#@}"; return ;;
  esac
  start_epoch="$RUN_START_EPOCH"
  at="$(date -j -f '%Y-%m-%d %H:%M:%S' "$(date -r "$start_epoch" +%Y-%m-%d) $v:00" +%s)"
  [ "$at" -gt "$start_epoch" ] || at=$((at + 86400))
  printf '%s\n' "$at"
}

# UX 三批：每批同時開始、等整批結束才下一批（最多 UX_BATCH_MAX 個同時；批次表已檢查過不會有兩個系辦）。
run_ux_batches() {
  local b i n=0 deadline ids pids
  deadline="$(ux_deadline_epoch)"
  for b in "${UX_BATCHES[@]}"; do
    n=$((n + 1))
    ids="$(ids_in_group "$b")"
    [ -n "$ids" ] || continue
    if [ "$(date +%s)" -ge "$deadline" ]; then
      for i in "${!IDS[@]}"; do
        [ "${GROUPS_[$i]}" = "$b" ] || continue
        mark_result "${IDS[$i]}" not-run "未跑：過了 UX 截止 ${ACCEPT_UX_DEADLINE:-08:00}"
      done
      log not-run - "第 $n 批 ${ids}：過了 UX 截止 ${ACCEPT_UX_DEADLINE:-08:00}，不跑"
      write_run_json
      continue
    fi
    log batch - "第 $n 批開始：$ids"
    pids=()
    for i in "${!IDS[@]}"; do
      [ "${GROUPS_[$i]}" = "$b" ] || continue
      run_item "$i" &
      pids+=($!)
    done
    write_run_json
    for i in "${pids[@]}"; do wait "$i" || true; done
    write_run_json
    log batch - "第 $n 批結束"
  done
}

run_full() {
  local bg_pids=() i pid
  for i in "${!IDS[@]}"; do
    [ "${GROUPS_[$i]}" = P ] || continue
    run_item "$i" &
    bg_pids+=($!)
  done
  write_run_json
  run_story_chain
  restore_midterm
  run_ux_batches
  for pid in ${bg_pids[@]+"${bg_pids[@]}"}; do wait "$pid" || true; done
  run_last_items
}

# 並行群 L：前面全部結束後一項一項跑（R1 會鎖帳號，不能和任何項目並行）。不看 UX 截止：一定要跑。
run_last_items() {
  local i
  for i in "${!IDS[@]}"; do
    [ "${GROUPS_[$i]}" = L ] || continue
    log last - "${IDS[$i]} 開始（前面的項目都已結束）"
    run_item "$i" &
    wait $! || true
    write_run_json
  done
}

# ── 收尾：任何結束都要刪秘密 ──────────────────────────────────
FINALIZED=0
finalize() {
  local reason="$1" leaked=() file secret
  [ "$FINALIZED" = 0 ] || return 0
  FINALIZED=1
  trap '' INT TERM HUP
  if [ "$reason" != "done" ]; then
    log interrupt - "收到 ${reason}，停掉進行中的項目"
    stop_children "$$"
    for i in "${!IDS[@]}"; do
      [ -f "$RESULTS/${IDS[$i]}.start" ] && [ ! -f "$RESULTS/${IDS[$i]}.result" ] && close_sessions "${IDS[$i]}"
    done
  fi
  COMMIT_END="$(fetch_commit)"
  if [ "$COMMIT_START" = "$COMMIT_END" ]; then
    log commit-end - "commit=${COMMIT_END}（未變）"
  elif [ "$COMMIT_START" = unknown ]; then
    # 還沒記到開始 commit 就結束（前置中止、極早中斷）：沒得比，不算換版。
    log commit-end - "commit=${COMMIT_END}（沒有開始 commit 可比）"
  else
    log commit-changed - "start=$COMMIT_START end=$COMMIT_END"
  fi
  if [ "$PAUSED" = 1 ]; then
    if fju_reset 120 resume-deploy; then
      log resume-deploy - "ok"
    else
      log resume-deploy-failed - "請手動：ssh fju-reset resume-deploy"
    fi
    PAUSED=0
  fi
  # 整夜密碼與 E2E 管理員密碼不得留在 RUN_DIR 任何文字檔（報告、logs/、progress、run.log）：
  # 逾時、中斷時 codex-e2e.sh 沒機會檢查，codex 印到 stderr 的也只進 logs/。
  if [ -n "${NIGHT_PW:-}" ] || [ -n "${ADMIN_PW:-}" ]; then
    for secret in "${NIGHT_PW:-}" "${ADMIN_PW:-}"; do
      [ -n "$secret" ] || continue
      while IFS= read -r file; do
        [ -n "$file" ] || continue
        leaked+=("$file")
        E2E_REDACT="$secret" perl -pi -e 's/\Q$ENV{E2E_REDACT}\E/[已遮蔽]/g' "$file"
      done < <(grep -rIlF -f <(printf '%s\n' "$secret") "$RUN_DIR" 2>/dev/null || true)
    done
    # codex-e2e.sh 自己遮蔽過的也算外洩（它的訊息在 logs/<id>.log）。
    if grep -lE '整夜密碼外洩|輸出裡出現了密碼' "$RUN_DIR"/logs/*.log >/dev/null 2>&1; then
      PASSWORD_LEAKED=true
      log password-leaked - "codex-e2e.sh 已遮蔽，見 $(grep -lE '整夜密碼外洩|輸出裡出現了密碼' "$RUN_DIR"/logs/*.log | tr '\n' ' ')"
    fi
    if [ "${#leaked[@]}" -gt 0 ]; then
      PASSWORD_LEAKED=true
      log password-leaked - "已遮蔽：${leaked[*]}"
    fi
  fi
  rm -rf "$SECRET_DIR"
  NIGHT_PW="" ADMIN_PW=""
  log secrets-deleted - "$SECRET_DIR"
  FINISHED_AT="$(now_iso)"
  write_run_json || log run-json-failed - ""
  if [ -f "$E2E_ROOT/summarize-night.sh" ]; then
    # full 帶 --polish（教訓 4）；潤稿這條路整個失敗時退回不潤稿再彙整一次，總覽照出。
    if [ "$PLAN" = full ] && bash "$E2E_ROOT/summarize-night.sh" "$RUN_DIR" --vault ${ACCEPT_VAULT:+"$ACCEPT_VAULT"} --polish >> "$RUN_DIR/summarize.log" 2>&1; then
      log summarize - "ok（--polish；$RUN_DIR/summary.md）"
    elif bash "$E2E_ROOT/summarize-night.sh" "$RUN_DIR" --vault ${ACCEPT_VAULT:+"$ACCEPT_VAULT"} >> "$RUN_DIR/summarize.log" 2>&1; then
      log summarize - "ok（$RUN_DIR/summary.md）"
    else
      log summarize-failed - "見 $RUN_DIR/summarize.log"
    fi
  else
    log summarize-missing - "$E2E_ROOT/summarize-night.sh 不存在"
  fi
  # 送上開發者後台（S-8）：run.json 一定送、summary.json 有才送。失敗只記警告，不改整夜結束碼；
  # 本機試跑這支腳本（假清單、假健康檢查）時設 ACCEPT_STATUS_PUBLISH=0，免得假的夜擠掉 VM 上真的夜。
  if [ "${ACCEPT_STATUS_PUBLISH:-1}" = 0 ]; then
    log status-publish - "略過（ACCEPT_STATUS_PUBLISH=0）"
  elif bash "$REPO_ROOT/ops/status-publish-run.sh" "$RUN_DIR" >> "$RUN_DIR/publish.log" 2>&1; then
    log status-publish - "ok（見 $RUN_DIR/publish.log）"
  else
    log status-publish-failed - "見 $RUN_DIR/publish.log；手動重送：ops/status-publish-run.sh $RUN_DIR"
  fi
  if [ "$reason" = "done" ]; then
    log "done" - "報告：$RUN_DIR"
  else
    log interrupted - "整夜被中斷（${reason}）；報告留在 $RUN_DIR"
  fi
}
trap 'finalize INT; exit 130' INT
trap 'finalize TERM; exit 143' TERM
trap 'finalize HUP; exit 129' HUP
trap 'finalize error' EXIT

log begin - "plan=$PLAN items=${IDS[*]} model=$MODEL sandbox=$SANDBOX"
if [ "$PLAN" = full ]; then
  if [ "$NO_RESET" = 1 ]; then
    log options - "no-reset=1（${NO_RESET_WHY}） no-snapshot=$NO_SNAPSHOT"
  else
    log options - "no-reset=0 no-snapshot=$NO_SNAPSHOT"
  fi
fi

# 0. 整夜密碼（24 字英數，大小寫與數字都要有），報告目錄外、只有自己讀得到。
mkdir -p "$SECRET_DIR/secrets" "$STATE_DIR"
chmod 700 "$SECRETS_ROOT" "$SECRET_DIR" "$SECRET_DIR/secrets" "$STATE_DIR"
NIGHT_PW=""
while ! { [ "${#NIGHT_PW}" -eq 24 ] && [[ "$NIGHT_PW" =~ [a-z] ]] && [[ "$NIGHT_PW" =~ [A-Z] ]] && [[ "$NIGHT_PW" =~ [0-9] ]]; }; do
  NIGHT_PW="$(openssl rand -base64 48 | LC_ALL=C tr -dc 'A-Za-z0-9' | head -c 24)"
done
printf '%s\n' "$NIGHT_PW" > "$PW_FILE"
chmod 600 "$PW_FILE"
log secrets - "${SECRET_DIR}（0700，night.pw 0600）"

# 全套前置：重置測試站（reset 會同版重部署，所以開始 commit 在它之後才記）。
if [ "$PLAN" = full ] && ! pre_reset; then
  log abort - "前置重置沒完成，整夜停止（收尾照做）"
  exit 1
fi

# 1. 開始 commit
COMMIT_START="$(fetch_commit)"
log commit-start - "commit=${COMMIT_START}（${HEALTH_URL}）"
write_run_json

# 暖 npx 快取：免得幾個 codex 同時首裝 @playwright/cli 互撞。
if run_with_watchdog 300 "$RUN_DIR/pwcli.log" "$PWCLI" --help; then
  log pwcli-warm - "ok"
else
  log pwcli-warm - "失敗（見 pwcli.log），照跑"
fi

if [ "$PLAN" = full ]; then
  run_full
  finalize "done"
  trap - EXIT
  exit 0
fi

# 2. 沒有依賴（或依賴沒選到）的項目同時開始；有依賴的等依賴結束再開始。
PIDS=()
pid_of() {
  local i
  for i in "${!IDS[@]}"; do [ "${IDS[$i]}" = "$1" ] && { echo "${PIDS[$i]:-}"; return; }; done
}
for i in "${!IDS[@]}"; do
  PIDS[i]=""
  if [ -z "${DEPS[$i]}" ] || ! is_selected "${DEPS[$i]}"; then
    run_item "$i" &
    PIDS[i]=$!
  fi
done
write_run_json
for i in "${!IDS[@]}"; do
  [ -z "${PIDS[$i]}" ] || continue
  dep="${DEPS[$i]}"
  dep_pid="$(pid_of "$dep")"
  [ -z "$dep_pid" ] || wait "$dep_pid" || true
  if ! grep -qE '^接力：可以' "$RUN_DIR/$dep/report.md" 2>/dev/null; then
    log dependency-not-met "${IDS[$i]}" "$dep 沒有「接力：可以」，照跑"
    printf 'dependency-not-met\n' > "$RESULTS/${IDS[$i]}.note"
  fi
  run_item "$i" &
  PIDS[i]=$!
  write_run_json
done
for pid in "${PIDS[@]}"; do
  wait "$pid" || true
done

finalize "done"
trap - EXIT
exit 0
