#!/usr/bin/env bash
# 整夜網站驗收的總指揮（設計方案 e2e/acceptance/redesign/設計方案.md §3.4，票 A）。
# 💻 在 Roy 的 Mac、repo 根目錄跑；Mac 不能睡：
#
#   caffeinate -dims ops/acceptance-night.sh --plan tonight
#
# 做法：
#   0. 產整夜密碼 → ~/.fju-acceptance/<runId>/secrets/night.pw（0600，目錄 0700，報告目錄外）
#   1. 記開始 commit（測試站 /api/health）
#   2. 並行群 1：資安靜態掃描、兩位訪客人設、劇本第 1 章；每項一個 ops/codex-e2e.sh（掃描直接跑腳本）
#   3. 第 1 章結束後跑新手系辦人設（沒有「接力：可以」照跑，run.log 記 dependency-not-met）
#   4. 每項有預算（分鐘）：到了就停掉；非 0 或逾時且 progress.md 有進度、session id 已知 → resume 一次（預算減半）
#   5. 記結束 commit、遮蔽輸出裡的整夜密碼與 E2E 管理員密碼、刪 ~/.fju-acceptance/<runId>、叫 summarize-night.sh --vault
#   第 5 步在任何結束（含 Ctrl-C）都會做。
#
# 參數：
#   --plan tonight|full   計畫（full 還沒做）
#   --only a,b            只跑這幾項（項目 id 用逗號隔開）
#   --purge               刪掉 ~/.fju-acceptance 底下所有 run 的秘密（中途被停掉時用）；不給 --plan 就只做這件事
#   --dry-run             只印會做什麼：不建目錄、不產密碼、不連網、不叫 codex
#
# 進度：tail -f e2e/acceptance/.out/night-*/run.log
#
# 可調的環境變數（今晚都不用動）：
#   CODEX_E2E_MODEL / CODEX_E2E_SANDBOX  預設 gpt-6.1-sol／danger-full-access（交給 codex-e2e.sh）
#   ACCEPT_BUDGET_OVERRIDE  每項預算改成 N 分鐘（或 Ns＝N 秒）；測試看門狗用
#   ACCEPT_HEALTH_URL       取 commit 的網址，預設 https://test.fju.roy422.dev/api/health；測試指到本機假伺服器
#   ACCEPT_E2E_ROOT         清單、人設卡、掃描與彙整腳本的根目錄，預設 e2e/acceptance；測試指到假清單
#   ACCEPT_VAULT            彙整寫進的 Vault 工程開發目錄，預設由 summarize-night.sh --vault 決定；測試指到 /tmp
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

usage() {
  sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
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
while [ $# -gt 0 ]; do
  case "$1" in
    --plan) [ $# -ge 2 ] || die "--plan 要給 tonight 或 full"; PLAN="$2"; shift ;;
    --plan=*) PLAN="${1#--plan=}" ;;
    --only) [ $# -ge 2 ] || die "--only 要給項目 id"; ONLY="$2"; shift ;;
    --only=*) ONLY="${1#--only=}" ;;
    --purge) PURGE=1 ;;
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
  die "用法：ops/acceptance-night.sh --plan tonight [--only a,b] [--dry-run] [--purge]"
fi
case "$PLAN" in
  tonight) PLAN_ROWS=("${PLAN_TONIGHT[@]}") ;;
  full) die "--plan full 還沒做（設計方案 §6）；今晚用 --plan tonight。" ;;
  *) die "--plan 只能是 tonight 或 full（收到：${PLAN}）" ;;
esac
case "$SANDBOX" in
  read-only|workspace-write|danger-full-access) ;;
  *) die "CODEX_E2E_SANDBOX 只能是 read-only、workspace-write 或 danger-full-access（收到：${SANDBOX}）" ;;
esac
if [ -n "${ACCEPT_BUDGET_OVERRIDE:-}" ]; then
  [[ "$ACCEPT_BUDGET_OVERRIDE" =~ ^[0-9]+s?$ ]] || die "ACCEPT_BUDGET_OVERRIDE 要是 N（分鐘）或 Ns（秒）"
fi

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
    '{runId:$runId,plan:$plan,startedAt:$s,finishedAt:$f,commitStart:$cs,commitEnd:$ce,items:$items,passwordLeaked:$leaked}' \
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
  else
    log commit-changed - "start=$COMMIT_START end=$COMMIT_END"
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
    if bash "$E2E_ROOT/summarize-night.sh" "$RUN_DIR" --vault ${ACCEPT_VAULT:+"$ACCEPT_VAULT"} >> "$RUN_DIR/summarize.log" 2>&1; then
      log summarize - "ok（$RUN_DIR/summary.md）"
    else
      log summarize-failed - "見 $RUN_DIR/summarize.log"
    fi
  else
    log summarize-missing - "$E2E_ROOT/summarize-night.sh 不存在"
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
