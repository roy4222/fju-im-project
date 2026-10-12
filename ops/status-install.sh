#!/usr/bin/env bash
# 開發者後台｜VM 一次 sudo 安裝（設計方案 §3.12；票 S-9）。
#
#   # 先看會做什麼（只讀現況、只印不做；不需要 sudo）
#   bash ops/status-install.sh --dry-run --access-team <team>.cloudflareaccess.com \
#     --access-aud <AUD> --publish-pubkey '<ssh-ed25519 … fju-status-publish>'
#
#   # 實際安裝（Roy 貼 status-prepare.sh 印的那一行；sudo 只問一次）
#   sudo bash /srv/fju/app/ops/status-install.sh --access-team <team>.cloudflareaccess.com \
#     --access-aud <AUD> --publish-pubkey '<ssh-ed25519 … fju-status-publish>'
#
#   # 只核對一份 cloudflared 設定檔（第 10 步第二段同一個檢查；不需要 sudo）
#   bash ops/status-install.sh --check-cloudflared-config <檔> --access-team … --access-aud … [--hosts '<網址…>']
#
# 其他參數：
#   --offsite-dir <路徑>             異地備份目錄不在 /srv/fju/offsite 時指定（寫進 /srv/fju/status/paths.env）
#   --mem-available-override <MB>    假裝可用記憶體只有這麼多（測第 1 步的停止條件）
#   --hosts '<網址 …>'               只給 --check-cloudflared-config 用；預設是 STATUS_HOSTS 四個網址
#
# 可重跑：每步先檢查，已完成就印「跳過」。每步印 ✓／跳過／✗，最後印摘要。
# 可用記憶體 < 2.5 GB 就在第 1 步停下、什麼都不建。
# 第 7b 步只對暫時隧道 fju-status-verify 與假 origin 做破壞性測試，不碰真後台、不改 Access 政策。
# 第 10 步任何一個網址沒被 Access 擋住 → 停掉 cloudflared 與自動更新 timer、結束碼 1。
# 第 1 步過了之後、第 10 步守門通過之前，不論怎麼結束（失敗、set -e、Ctrl-C、ssh 斷線、輸出管線斷、
# 等授權時被終止）都先關門：停 cloudflared 容器、停用 fju-status-update timer、停 service；紀錄在 .install/exit.log。
# 說明與 Roy 的 3 件事見 ops/status/README.md。

# -E：ERR trap 在函式裡也有效（結束時才印得出「最後失敗的指令」）。
set -Eeuo pipefail
umask 077

DEPLOY_USER=deploy
PUBLISH_USER=fjustatus
APP_DIR=${FJU_STATUS_APP_DIR:-/srv/fju/app}
COMPOSE_FILE=$APP_DIR/docker-compose.status.yml
STATUS_UP=$APP_DIR/ops/status-up.sh
RENDER=$APP_DIR/ops/status-render-cloudflared.sh
# S-4 的 compose 把這份掛成 cloudflared 容器的 /etc/cloudflared/config.yml。
CLOUDFLARED_YML=$APP_DIR/ops/status/cloudflared.yml
UNIT_SRC=$APP_DIR/ops/status/systemd
# 下面幾個 FJU_STATUS_* 只給 status/test/ops/install.test.ts 的故障注入測試用（把系統路徑換成暫存目錄）；正式安裝不要設。
UNIT_DIR=${FJU_STATUS_UNIT_DIR:-/etc/systemd/system}
UNITS="fju-status-update.service fju-status-update.timer fju-status-envcheck.service fju-status-envcheck.timer"
RESET_SCRIPTS="fju-test-reset fju-test-reset-gate"

STATUS_ROOT=${FJU_STATUS_ROOT:-/srv/fju/status}
SECRETS=$STATUS_ROOT/secrets
DATA=$STATUS_ROOT/data
INBOX=$STATUS_ROOT/inbox
ENVCHECK=$STATUS_ROOT/envcheck
DISKPROBE=$STATUS_ROOT/diskprobe
PATHS_ENV=$STATUS_ROOT/paths.env
# 安裝腳本自己的紀錄（第 7b 步通過的 team／AUD／版本）；root 700。
STATE_DIR=$STATUS_ROOT/.install
VERIFY_MARKER=$STATE_DIR/verify-7b.ok
# 結束時（關門、清理）的紀錄：畫面或 ssh 已經不在時，Roy 事後還查得到發生什麼事。
EXIT_LOG=$STATE_DIR/exit.log
# tunnel login 產生的 cert.pem 只活在這裡，結束時（不論成敗）整個刪掉。
LOGIN_DIR=$STATUS_ROOT/.cloudflared-login
OFFSITE_DEFAULT=/srv/fju/offsite
OFFSITE_DIR=$OFFSITE_DEFAULT

# 四個網址只寫在這一個值（設計方案 §0）。
STATUS_HOSTS=${STATUS_HOSTS:-fju-status.roy422.dev fju-status-vm.roy422.dev fju-status-logs.roy422.dev fju-status-db.roy422.dev}
TUNNEL_NAME=fju-status
VERIFY_TUNNEL=fju-status-verify
VERIFY_HOST=fju-status-verify.roy422.dev
VERIFY_NET=fju-status-verify
VERIFY_ORIGIN=fju-status-verify-origin
VERIFY_CF=fju-status-verify-cloudflared
VERIFY_PORT=8080
CURL_IMAGE=curlimages/curl:8.16.0
# 映像版本以 compose 檔為準（S-4 固定版本）；讀不到才用這兩個。
CLOUDFLARED_IMAGE_FALLBACK=cloudflare/cloudflared:2025.9.1
STATUS_IMAGE_FALLBACK=ghcr.io/roy4222/fju-status:main
MIN_MEM_MB=2560
TEST_PG=fju-test-postgres
SSH_DIR=${FJU_STATUS_SSH_DIR:-/etc/ssh}
SSHD_CONF=$SSH_DIR/sshd_config.d/10-fju.conf
HOME_ROOT=${FJU_STATUS_HOME_ROOT:-/home}
SBIN=${FJU_STATUS_SBIN:-/usr/local/sbin}
OS_RELEASE=${FJU_STATUS_OS_RELEASE:-/etc/os-release}
RRSYNC=${FJU_STATUS_RRSYNC:-/usr/bin/rrsync}
CF_API=${FJU_STATUS_CF_API:-https://api.cloudflare.com/client/v4}
BESZEL_SOCKET=/beszel_socket/beszel.sock

DRY_RUN=0
MEM_OVERRIDE=""
ACCESS_TEAM=""
ACCESS_AUD=""
PUBKEY=""
CHECK_FILE=""
HOSTS_ARG=""

# 畫面輸出一律 2>/dev/null：stdout 管線斷掉時（PIPE 有 trap）printf 只會回非 0，不要再往 stderr 噴「write error」。
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*" 2>/dev/null; }
skip() { printf '  \033[36m跳過\033[0m %s\n' "$*" 2>/dev/null; }
todo() { printf '  \033[33m→\033[0m %s\n' "$*" 2>/dev/null; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*" 2>/dev/null; }
step() { CUR_STEP=$1; shift; printf '\n\033[1m步驟 %s：%s\033[0m\n' "$CUR_STEP" "$*" 2>/dev/null; }
die()  { echo "$*" >&2; exit 1; }

SUMMARY=""
FAILED=0
CUR_STEP=""
# 每步一行摘要：note ✓|跳過|✗ <說明>
# --dry-run 時 ✓ 一律改成 →（只印了、沒做）。
note() {
  local mark=$1
  [ "$DRY_RUN" = 1 ] && [ "$mark" = "✓" ] && mark="→"
  SUMMARY="${SUMMARY}  步驟 ${CUR_STEP}：${mark} $2"$'\n'
  [ "$mark" = "✗" ] && FAILED=1
  return 0
}
# 停在這一步：印原因、印摘要、結束碼 1（記憶體不足用 2）。
halt() {
  local code=$1; shift
  EXIT_WHY="停在步驟 ${CUR_STEP}：$*"
  bad "$*"
  note "✗" "$*"
  printf '\n\033[1m停在步驟 %s。\033[0m到目前為止：\n%s' "$CUR_STEP" "$SUMMARY" 2>/dev/null
  exit "$code"
}

usage() { sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

# --dry-run 只印「會執行」，不執行。RUN_CMD：真的執行時先記下來，set -e 中止時 on_err 才印得出是哪個指令（不然只看到 "$@"）。
RUN_CMD=""
run() {
  local rc=0
  if [ "$DRY_RUN" = 1 ]; then todo "會執行：$*"; return 0; fi
  RUN_CMD="$*"
  "$@" || rc=$?
  # 失敗時留著 RUN_CMD 給 on_err；回傳碼一定要原樣帶回去（set -e、|| halt 都靠它）。
  if [ "$rc" = 0 ]; then RUN_CMD=""; fi
  return "$rc"
}
as_deploy() { run runuser -u "$DEPLOY_USER" -- "$@"; }

# 寫檔（內容從 stdin）：同目錄暫存檔＋mv，權限先設好才換上。--dry-run 只印路徑、不印內容（可能是密碼）。
write_file() {
  local mode=$1 owner=$2 dest=$3 tmp
  if [ "$DRY_RUN" = 1 ]; then
    cat >/dev/null
    todo "會寫入 ${dest}（${mode}，${owner}）"
    return 0
  fi
  tmp=$(mktemp "${dest}.XXXXXX")
  cat >"$tmp"
  chmod "$mode" "$tmp"
  chown "$owner" "$tmp"
  mv -f "$tmp" "$dest"
}

dir_state() { stat -c '%U:%G:%a' "$1" 2>/dev/null || true; }

# 目錄：已是對的擁有者與權限就跳過。
ensure_dir() {
  local dest=$1 owner=$2 mode=$3 want
  want="${owner}:${mode}"
  if [ "$(dir_state "$dest")" = "$want" ]; then
    skip "${dest} 已是 ${owner} ${mode}"
    return 0
  fi
  run install -d -o "${owner%%:*}" -g "${owner##*:}" -m "$mode" "$dest"
  [ "$DRY_RUN" = 1 ] || ok "${dest}（${owner} ${mode}）"
}

# fju-status 某個服務的所有容器 id（不經 docker compose：它會先讀 env_file，缺一個就整個失敗）。
svc_cids() {
  docker ps -q --filter "label=com.docker.compose.project=fju-status" \
    --filter "label=com.docker.compose.service=$1"
}

# compose 檔裡某個映像的完整寫法（含固定版本）；有 ${…} 或讀不到就用備用值。
image_from_compose() {
  local repo=$1 fallback=$2 found=""
  if [ -f "$COMPOSE_FILE" ]; then
    found=$(sed -n "s|^[[:space:]]*image:[[:space:]]*[\"']\{0,1\}\(${repo}:[^\"'[:space:]]*\).*|\1|p" "$COMPOSE_FILE" | head -n 1)
  fi
  case "$found" in
    ''|*'$'*) echo "$fallback" ;;
    *) echo "$found" ;;
  esac
}

# 結束時的訊息：先寫 EXIT_LOG（ssh 斷線後 Roy 還查得到），再盡力印到畫面。
# 這時 PIPE 已被忽略：畫面不在了只會得到寫入錯誤（丟掉），不會把關門打斷。
# shellcheck disable=SC2329  # 由 on_exit（EXIT trap）呼叫
say() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)" "$*" >>"$EXIT_LOG" 2>/dev/null || true
  printf '  %s\n' "$*" 2>/dev/null || true
}
# 關門（冪等、不寫 stdout）：停用自動更新 timer 並停掉正在跑的那一輪（不然 10 分鐘內 up -d 會把 cloudflared 再起來），
# 再停掉所有 fju-status 的 cloudflared 容器。每個動作都 >/dev/null 2>&1：關門途中不會再被 SIGPIPE 打斷。
# 第 1 步過了就 GATE_ARMED=1，第 10 步守門通過才歸 0；GATE_ARMED=1 時不論怎麼結束，on_exit 都先叫這裡。
DOOR_CLOSED=0
GATE_ARMED=0
EXIT_WHY=""
ERR_AT=""
# set -e 直接中止時沒有人印原因：ERR trap 記下最後失敗的指令、行號、步驟，on_exit 一併印、寫 log。
# BASH_COMMAND 在 trap 執行期間就是失敗的那個指令（變數還沒展開）；經 run 包的改印 run 記下的實際指令。
# shellcheck disable=SC2329  # 由 trap on_err ERR 呼叫
on_err() { # <行號>
  ERR_AT="${RUN_CMD:-$BASH_COMMAND}（第 ${1} 行，步驟 ${CUR_STEP}）"
}
close_door() {
  local cid
  [ "$DOOR_CLOSED" = 0 ] || return 0
  DOOR_CLOSED=1
  systemctl disable --now fju-status-update.timer >/dev/null 2>&1 || true
  systemctl stop fju-status-update.service >/dev/null 2>&1 || true
  for cid in $(svc_cids cloudflared 2>/dev/null || true); do docker stop "$cid" >/dev/null 2>&1 || true; done
  return 0
}

# ---------------------------------------------------------------------------
# cloudflared 設定檔核對（第 7b 步與第 10 步第二段共用）
# ---------------------------------------------------------------------------

# 把 cloudflared 會用到的那種 YAML（巢狀 map、list、[a, b]、{k: v}）攤平成 `路徑=值`，例：
#   ingress.0.originRequest.access.audTag.0=<AUD>
# 只為核對 access 區塊而寫，不是完整的 YAML 解析器；看不懂的寫法核對會失敗（寧可擋下）。
yaml_flatten() {
  awk -v q="'" '
    function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
    function unq(s,   f, l) {
      s = trim(s)
      f = substr(s, 1, 1); l = substr(s, length(s), 1)
      if (length(s) >= 2 && ((f == "\"" && l == "\"") || (f == q && l == q))) s = substr(s, 2, length(s) - 2)
      return s
    }
    function cur(   i, p) { p = ""; for (i = 1; i <= sp; i++) p = (p == "" ? seg[i] : p "." seg[i]); return p }
    function join(p, k) { return p == "" ? k : p "." k }
    # 鍵名裡有「.」會跟真正的巢狀撞成同一個路徑（cloudflared 卻當成別的鍵、等於沒鎖）：一律標成看不懂。
    function keyok(k) { if (k == "" || k ~ /[.=]/) { print "!invalid=鍵名「" k "」"; return 0 } return 1 }
    # 以最外層逗號切開 [ ] 或 { } 裡面的內容
    function splitflow(s, out,   i, ch, depth, n, buf) {
      n = 0; depth = 0; buf = ""
      for (i = 1; i <= length(s); i++) {
        ch = substr(s, i, 1)
        if (ch == "[" || ch == "{") depth++
        if (ch == "]" || ch == "}") depth--
        if (ch == "," && depth == 0) { out[++n] = buf; buf = "" } else buf = buf ch
      }
      if (trim(buf) != "") out[++n] = buf
      return n
    }
    function emitval(p, v) {
      v = trim(v)
      if (v ~ /^\[.*\]$/) emitlist(p, substr(v, 2, length(v) - 2))
      else if (v ~ /^\{.*\}$/) emitmap(p, substr(v, 2, length(v) - 2))
      else print p "=" unq(v)
    }
    function emitlist(p, s,   parts, n, i, idx) {
      n = splitflow(s, parts); idx = 0
      for (i = 1; i <= n; i++) if (trim(parts[i]) != "") { emitval(p "." idx, parts[i]); idx++ }
    }
    function emitmap(p, s,   parts, n, i, c, k) {
      n = splitflow(s, parts)
      for (i = 1; i <= n; i++) {
        c = trim(parts[i])
        if (match(c, /:( |$)/)) { k = unq(substr(c, 1, RSTART - 1)); if (keyok(k)) emitval(join(p, k), substr(c, RSTART + 1)) }
        else print "!invalid=flow 寫法「" c "」"
      }
    }
    function handlekey(ind, c,   k, v) {
      while (sp > 0 && sind[sp] >= ind) sp--
      if (!match(c, /:( |$)/)) { print cur() "=" unq(c); return }
      k = unq(substr(c, 1, RSTART - 1)); v = trim(substr(c, RSTART + 1))
      if (!keyok(k)) { sp++; seg[sp] = "!"; sind[sp] = ind; stype[sp] = "key"; return }
      if (v == "") { sp++; seg[sp] = k; sind[sp] = ind; stype[sp] = "key"; return }
      emitval(join(cur(), k), v)
    }
    {
      line = $0
      sub(/\r$/, "", line)
      if (line ~ /^[ \t]*#/ || line ~ /^[ \t]*$/ || line ~ /^---/) next
      sub(/[ \t]+#.*$/, "", line)
      if (line ~ /^ *\t/) { print "!invalid=用 tab 縮排"; next }
      match(line, /^ */); ind = RLENGTH; c = substr(line, ind + 1)
      if (c == "-" || c ~ /^- /) {
        while (sp > 0 && (sind[sp] > ind || (sind[sp] == ind && stype[sp] == "item"))) sp--
        p = cur(); i = cnt[p] + 0; cnt[p] = i + 1
        sp++; seg[sp] = i; sind[sp] = ind; stype[sp] = "item"
        rest = substr(c, 2); match(rest, /^ */); off = 1 + RLENGTH; rest = trim(rest)
        if (rest == "") next
        f = substr(rest, 1, 1)
        if (f != "\"" && f != q && f != "[" && f != "{" && match(rest, /:( |$)/)) handlekey(ind + off, rest)
        else emitval(cur(), rest)
        next
      }
      handlekey(ind, c)
    }
  ' "$1"
}

# 核對：每個要的網址都在 ingress 裡；每條會轉給服務的 ingress（http_status:* 以外，含沒有 hostname 的）
# 都有 originRequest.access.required: true、teamName＝team 名稱、audTag 恰好一個且等於 AUD。
# 看不懂的寫法（鍵名帶「.」、tab 縮排、同一個鍵寫兩次）一律判失敗：寧可擋下也不要誤判有鎖。
# 用法：check_cloudflared_config <檔> <team 名稱> <AUD> <網址（空白分隔）>；不通過印出哪條、回傳 1。
check_cloudflared_config() {
  local file=$1 team=$2 aud=$3 hosts=$4
  [ -s "$file" ] || { bad "設定檔不存在或是空的：${file}"; return 1; }
  yaml_flatten "$file" | awk -v team="$team" -v aud="$aud" -v hosts="$hosts" '
    function add(a, b) { return a == "" ? b : a "、" b }
    {
      eq = index($0, "="); k = substr($0, 1, eq - 1); v = substr($0, eq + 1)
      if (k == "!invalid") { print "  ✗ 看不懂的寫法：" v; bad = 1; next }
      if (k in kv) { print "  ✗ 同一個鍵寫了兩次：" k; bad = 1 }
      kv[k] = v
      if (k ~ /^ingress\.[0-9]+\./) { split(k, a, "."); if (a[2] + 1 > maxn) maxn = a[2] + 1 }
    }
    END {
      fail = bad + 0
      if (maxn == 0) { print "  ✗ 設定檔裡沒有 ingress"; exit 1 }
      for (i = 0; i < maxn; i++) {
        pre = "ingress." i "."
        h = kv[pre "hostname"]; svc = kv[pre "service"]
        if (svc ~ /^http_status:/) continue
        label = (h == "" ? "第 " (i + 1) " 條 ingress（沒有 hostname）" : h)
        why = ""
        # 用 add() 接「、」而不是事後 substr 去頭：mawk 以位元組、gawk（UTF-8）以字元算長度，兩邊結果不同。
        if (tolower(kv[pre "originRequest.access.required"]) != "true") why = add(why, "access.required 不是 true")
        if (kv[pre "originRequest.access.teamName"] != team) why = add(why, "teamName 不是 " team)
        # audTag 多放別的值，同 team 其他 Access 應用程式的 JWT 也能過，所以要恰好一個。
        for (j = 0; (pre "originRequest.access.audTag." j) in kv; j++) ;
        if (j != 1 || kv[pre "originRequest.access.audTag.0"] != aud) why = add(why, "audTag 不是恰好這一個 AUD")
        if (why != "") { print "  ✗ " label "：" why; fail = 1 }
        if (h != "") seen[h] = 1
      }
      n = split(hosts, H, " ")
      for (j = 1; j <= n; j++) if (!(H[j] in seen)) { print "  ✗ " H[j] "：設定檔裡沒有這個網址"; fail = 1 }
      exit fail
    }
  '
}

team_name() { printf '%s' "${ACCESS_TEAM%.cloudflareaccess.com}"; }

# ---------------------------------------------------------------------------
# 參數
# ---------------------------------------------------------------------------

need_val() { [ $# -ge 2 ] && [ -n "$2" ] || die "$1 後面要接值（--help 看用法）"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --access-team) need_val "$@"; ACCESS_TEAM=$2; shift ;;
    --access-team=*) ACCESS_TEAM=${1#*=} ;;
    --access-aud) need_val "$@"; ACCESS_AUD=$2; shift ;;
    --access-aud=*) ACCESS_AUD=${1#*=} ;;
    --publish-pubkey) need_val "$@"; PUBKEY=$2; shift ;;
    --publish-pubkey=*) PUBKEY=${1#*=} ;;
    --offsite-dir) need_val "$@"; OFFSITE_DIR=${2%/}; shift ;;
    --offsite-dir=*) OFFSITE_DIR=${1#*=}; OFFSITE_DIR=${OFFSITE_DIR%/} ;;
    --mem-available-override) need_val "$@"; MEM_OVERRIDE=$2; shift ;;
    --mem-available-override=*) MEM_OVERRIDE=${1#*=} ;;
    --check-cloudflared-config) need_val "$@"; CHECK_FILE=$2; shift ;;
    --hosts) need_val "$@"; HOSTS_ARG=$2; shift ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "不認得的參數：$1（--help 看用法）" ;;
  esac
  shift
done

# team 網域、AUD、公鑰都不是秘密，但會進設定檔與 authorized_keys，格式不對一律不收。
[[ "$ACCESS_TEAM" =~ ^[a-z0-9][a-z0-9-]*\.cloudflareaccess\.com$ ]] \
  || die "--access-team 要是 <team>.cloudflareaccess.com（Zero Trust 設定頁的 team 網域），收到：「${ACCESS_TEAM}」"
[[ "$ACCESS_AUD" =~ ^[A-Za-z0-9]{32,128}$ ]] \
  || die "--access-aud 要是 Access 應用程式的 Application Audience (AUD) tag（32–128 個英數字）"
[ -z "$MEM_OVERRIDE" ] || [[ "$MEM_OVERRIDE" =~ ^[0-9]+$ ]] || die "--mem-available-override 要是 MB 整數"

if [ -n "$CHECK_FILE" ]; then
  hosts=${HOSTS_ARG:-$STATUS_HOSTS}
  echo "核對 ${CHECK_FILE}（team $(team_name)，網址：${hosts}）"
  if check_cloudflared_config "$CHECK_FILE" "$(team_name)" "$ACCESS_AUD" "$hosts"; then
    ok "每條 ingress 都有 originRequest.access（required、teamName、audTag）"
    exit 0
  fi
  bad "設定檔沒通過：上面那幾條的隧道端不會驗 Access JWT"
  exit 1
fi

[[ "$PUBKEY" =~ ^ssh-ed25519\ [A-Za-z0-9+/]+={0,3}(\ [A-Za-z0-9._@-]+)?$ ]] \
  || die "--publish-pubkey 要是一整行 ssh-ed25519 公鑰（status-prepare.sh 印的那一行，外面加單引號）"

if [ "$DRY_RUN" = 0 ] && [ "$(id -u)" -ne 0 ]; then
  die "要用 sudo 執行：sudo bash $0 …（先看會做什麼：加 --dry-run，不需要 sudo）"
fi
[ "$DRY_RUN" = 1 ] && printf '\033[1m--dry-run：只讀現況、只印不做，這一輪不會建立或改動任何東西。\033[0m\n'
if [ "$DRY_RUN" = 1 ] && [ "$(id -u)" -ne 0 ]; then
  todo "不是 root：讀不到 ${SECRETS} 與 ${STATE_DIR}，「已完成、會跳過」的判斷可能偏保守（印成會做）"
fi

CLOUDFLARED_IMAGE=$(image_from_compose cloudflare/cloudflared "$CLOUDFLARED_IMAGE_FALLBACK")
STATUS_IMAGE=$(image_from_compose ghcr.io/roy4222/fju-status "$STATUS_IMAGE_FALLBACK")

show_usage_snapshot() {
  if command -v free >/dev/null 2>&1; then free -m; else todo "這台沒有 free 指令"; fi
  docker stats --no-stream 2>/dev/null || todo "docker stats 讀不到（docker 沒在跑或沒權限）"
}

# ---------------------------------------------------------------------------
# 隧道、清理與結束時的處理（函式先定義好，第 1 步之後就可能被 EXIT trap 叫到）
# ---------------------------------------------------------------------------
# cloudflared 一律用固定版本的容器跑，不在主機裝套件；cert.pem 只放 LOGIN_DIR（root 700）。
CF_ARGS=(--user 0:0 -e HOME=/cf -e TUNNEL_ORIGIN_CERT=/cf/.cloudflared/cert.pem -v "$LOGIN_DIR:/cf/.cloudflared" "$CLOUDFLARED_IMAGE" tunnel)
cf() { docker run --rm "${CF_ARGS[@]}" "$@"; }
# tunnel login 要等 Roy 到瀏覽器授權，可能等很久。bash 要等前景子程序結束才會執行 trap，所以放到背景再 wait：
# 中途收到 INT／HUP／TERM，wait 會立刻回來、on_exit 把這個容器砍掉再關門，不會卡著等 Roy 點。
# 容器有固定名字，砍的時候不用知道 id；簡單指令接 & 時 $! 就是 docker 本身的 pid。
LOGIN_CONTAINER=fju-status-login
LOGIN_PID=""
cf_login() {
  local rc=0
  docker rm -f "$LOGIN_CONTAINER" >/dev/null 2>&1 || true
  docker run --rm --name "$LOGIN_CONTAINER" "${CF_ARGS[@]}" login & LOGIN_PID=$!
  wait "$LOGIN_PID" || rc=$?
  LOGIN_PID=""
  return "$rc"
}
# shellcheck disable=SC2329  # 由 on_exit（EXIT trap）呼叫
kill_login() {
  [ -n "$LOGIN_PID" ] || return 0
  kill -TERM "$LOGIN_PID" 2>/dev/null || true
  docker rm -f "$LOGIN_CONTAINER" >/dev/null 2>&1 || true
  wait "$LOGIN_PID" 2>/dev/null || true
  LOGIN_PID=""
}
# 印隧道 id（沒有這條就印空字串）；列不出來（網路、API 錯）回傳 2，不能當成「沒有」。
tunnel_id_by_name() {
  local out
  out=$(cf list --output json --name "$1" 2>/dev/null) || return 2
  printf '%s' "$out" | python3 -c '
import json, sys
try:
    rows = json.load(sys.stdin) or []
except ValueError:
    sys.exit(2)
ids = [r.get("id", "") for r in rows if r.get("name") == sys.argv[1]]
print(ids[0] if ids else "")' "$1"
}
# 0＝確定沒有暫時隧道；其他（還在、或列不出來）都不算清乾淨。
verify_tunnel_gone() {
  local id
  id=$(tunnel_id_by_name "$VERIFY_TUNNEL") || return 2
  [ -z "$id" ]
}
cred_tunnel_id() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["TunnelID"])' "$1"; }
route_dns() { # <隧道> <網址>：已經指到這條隧道也算成功
  local out
  if out=$(cf route dns "$1" "$2" 2>&1); then ok "DNS ${2} → ${1}"; return 0; fi
  case "$out" in
    *"already configured to route to your tunnel"*) skip "DNS ${2} 已指到 ${1}" ;;
    *) printf '%s\n' "$out" | sed 's/^/    /'; return 1 ;;
  esac
}
# 用 cert.pem 裡那把只管 roy422.dev 的 token 刪暫時網址的 DNS 記錄（cloudflared 沒有刪 DNS 的子命令）。
# token 只在 python 行程裡用，不進指令列、不印出來；只刪「名稱完全相同、指到 cfargotunnel.com 的 CNAME」。
delete_verify_dns() {
  python3 - "$LOGIN_DIR/cert.pem" "$VERIFY_HOST" "$CF_API" <<'PY'
import base64, json, re, sys, urllib.request
cert, host, base = sys.argv[1], sys.argv[2], sys.argv[3]
m = re.search(r"-----BEGIN ARGO TUNNEL TOKEN-----(.*?)-----END ARGO TUNNEL TOKEN-----", open(cert).read(), re.S)
if not m:
    print("    cert.pem 裡找不到 tunnel token"); sys.exit(1)
tok = json.loads(base64.b64decode("".join(m.group(1).split())))
api = "%s/zones/%s/dns_records" % (base, tok["zoneID"])
def call(method, url):
    req = urllib.request.Request(url, method=method, headers={"Authorization": "Bearer " + tok["apiToken"]})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)
def records():
    return [r for r in call("GET", api + "?type=CNAME&name=" + host)["result"]
            if r.get("name") == host and r.get("content", "").endswith(".cfargotunnel.com")]
for r in records():
    call("DELETE", api + "/" + r["id"])
left = records()
print("    DNS %s：%s" % (host, "已刪" if not left else "還有 %d 筆" % len(left)))
sys.exit(1 if left else 0)
PY
}

# 0＝確定暫時容器與暫時網路都不在；docker 本身回不出清單也不算確定。
verify_docker_gone() {
  local names nets
  names=$(docker ps -a --format '{{.Names}}') || return 2
  nets=$(docker network ls --format '{{.Name}}') || return 2
  ! printf '%s\n' "$names" | grep -qxE "${VERIFY_CF}|${VERIFY_ORIGIN}" \
    && ! printf '%s\n' "$nets" | grep -qx "$VERIFY_NET"
}
# 清第 7b 步的四類暫時資源（容器、網路、隧道、DNS），每一類都要「確定已經不在」才算清乾淨；
# 任何一類刪不掉或確認不了 → VERIFY_CLEANUP_FAILED=1（不寫通過紀錄，下次重跑會重新核對）。
VERIFY_CLEANUP_FAILED=0
cleanup_verify() {
  docker rm -f "$VERIFY_CF" "$VERIFY_ORIGIN" >/dev/null 2>&1 || true
  docker network rm "$VERIFY_NET" >/dev/null 2>&1 || true
  if ! verify_docker_gone; then
    bad "暫時容器（${VERIFY_CF}、${VERIFY_ORIGIN}）或暫時網路 ${VERIFY_NET} 刪不掉或確認不了（docker ps -a、docker network ls 手動確認、刪掉）"
    VERIFY_CLEANUP_FAILED=1
  fi
  [ -s "$LOGIN_DIR/cert.pem" ] || return 0
  if ! verify_tunnel_gone; then
    cf cleanup "$VERIFY_TUNNEL" >/dev/null 2>&1 || true
    cf delete -f "$VERIFY_TUNNEL" >/dev/null 2>&1 || true
  fi
  if ! verify_tunnel_gone; then
    bad "暫時隧道 ${VERIFY_TUNNEL} 刪不掉或確認不了（Zero Trust → Networks → Tunnels 手動確認、刪掉）"
    VERIFY_CLEANUP_FAILED=1
  fi
  delete_verify_dns || {
    bad "暫時網址 ${VERIFY_HOST} 的 DNS 記錄刪不掉或確認不了（Cloudflare → roy422.dev → DNS 手動確認、刪掉）"
    VERIFY_CLEANUP_FAILED=1
  }
  return 0
}
# 每一種結束都走這裡（EXIT trap）：正常失敗（halt）、set -e、INT／HUP／TERM／PIPE 的 trap 都是 exit 進來。
# 順序固定：①守門沒過就先關門（最快、最要緊、不寫 stdout）→ ②砍掉還在等授權的 login 容器
# → ③清第 7b 步的暫時資源、刪 cert.pem（它能管整個 zone，只在建立時需要）。
# 這裡關掉 -e、忽略再來的訊號（含 PIPE：畫面或 tee 不在了，寫入只會失敗、不會再被殺）。
# shellcheck disable=SC2329  # 由 trap on_exit EXIT 呼叫
on_exit() {
  local code=$? why
  set +e
  trap '' INT HUP TERM PIPE
  trap - ERR
  if [ "$GATE_ARMED" = 1 ]; then
    close_door
    why=${EXIT_WHY:-"指令失敗，最後失敗的指令：${ERR_AT:-（不明）}"}
    say "✗ 安裝在第 10 步守門通過前結束（結束碼 ${code}；${why}）"
    say "✗ 已停掉 cloudflared 容器、停用 fju-status-update.timer、停掉 fju-status-update.service：四個網址現在都連不上。修好後重跑同一行"
  fi
  kill_login
  if [ -d "$LOGIN_DIR" ]; then
    cleanup_verify
    rm -rf "$LOGIN_DIR"
    say "已刪 cert.pem 與暫時登入目錄"
  fi
  exit "$code"
}

marker_body() { printf 'team=%s\naud=%s\ncloudflared=%s\nhosts=%s\n' "$ACCESS_TEAM" "$ACCESS_AUD" "$CLOUDFLARED_IMAGE" "$STATUS_HOSTS"; }
marker_ok() { [ "$(sed '/^at=/d' "$VERIFY_MARKER" 2>/dev/null || true)" = "$(marker_body)" ]; }

# ---------------------------------------------------------------------------
# 步驟 1：前置與記憶體
# ---------------------------------------------------------------------------
step 1 "前置檢查（Ubuntu 24.04、docker、compose 檔）與記憶體（可用 < 2.5 GB 就停）"
pre_ok=1
check_pre() { # <說明> <指令…>
  local what=$1; shift
  if "$@" >/dev/null 2>&1; then ok "$what"; else bad "$what"; pre_ok=0; fi
}
# shellcheck disable=SC2329  # 由 check_pre 間接呼叫
os_is_2404() { [ -r "$OS_RELEASE" ] && grep -q '^ID=ubuntu$' "$OS_RELEASE" && grep -q '^VERSION_ID="24.04"$' "$OS_RELEASE"; }
check_pre "Ubuntu 24.04" os_is_2404
check_pre "docker 與 compose 外掛" docker compose version
check_pre "${COMPOSE_FILE} 存在（S-4 的 compose 檔）" test -f "$COMPOSE_FILE"
check_pre "${STATUS_UP} 存在（S-4）" test -f "$STATUS_UP"
check_pre "${RRSYNC}（驗收結果推送只准寫 inbox）" test -x "$RRSYNC"
check_pre "python3、curl、openssl、ssh-keygen" sh -c 'command -v python3 && command -v curl && command -v openssl && command -v ssh-keygen'
check_pre "${DEPLOY_USER} 帳號存在" id "$DEPLOY_USER"
echo "  記憶體與容器用量（安裝前）："
show_usage_snapshot | sed 's/^/    /'
if [ -n "$MEM_OVERRIDE" ]; then
  MEM_MB=$MEM_OVERRIDE
  todo "用 --mem-available-override 假裝可用記憶體 ${MEM_MB} MB"
else
  MEM_MB=$(awk '/^MemAvailable:/ { printf "%d", $2 / 1024 }' /proc/meminfo 2>/dev/null || true)
fi
[ -n "$MEM_MB" ] || halt 2 "讀不到可用記憶體（/proc/meminfo 沒有 MemAvailable），什麼都沒建"
if [ "$MEM_MB" -lt "$MIN_MEM_MB" ]; then
  halt 2 "可用記憶體 ${MEM_MB} MB，低於 ${MIN_MEM_MB} MB（2.5 GB）：停止，什麼都沒建。後台全部上限約 1.25 GB，先查是誰吃掉記憶體"
fi
ok "可用記憶體 ${MEM_MB} MB（門檻 ${MIN_MEM_MB} MB）"
if [ "$pre_ok" = 0 ]; then
  [ "$DRY_RUN" = 1 ] || halt 1 "上面打 ✗ 的前置沒過；S-4（compose、status-up.sh、systemd）合併並把 ops 送上 VM 之前只能 --dry-run"
  note "✗" "前置有缺（--dry-run 繼續往下印）"
else
  note "✓" "前置齊、可用記憶體 ${MEM_MB} MB"
fi
# 前置過了、要開始改設定：先停自動更新（安裝中途它的 up -d 會把半套設定或 cloudflared 起起來），
# 並掛上「中途結束就關門」——已安裝過的機器重跑時，壞掉的新設定不能讓既有的對外通道繼續開著。
# 第 10 步守門通過才解除、才重新啟用自動更新。
if [ "$DRY_RUN" = 0 ]; then
  GATE_ARMED=1
  trap on_exit EXIT
  # 訊號一律記下原因再 exit（結束碼 128+訊號號），讓 EXIT trap 關門。PIPE 一定要接：不接的話 bash 被 SIGPIPE
  # 直接殺死、EXIT trap 不會跑（畫面或 `| tee` 不在了，清理訊息的第一個 printf 就把自己打死，門還開著）。
  trap 'EXIT_WHY="被中斷（Ctrl-C）"; exit 130' INT
  trap 'EXIT_WHY="連線中斷（SIGHUP）"; exit 129' HUP
  trap 'EXIT_WHY="被終止（SIGTERM）"; exit 143' TERM
  trap 'EXIT_WHY="輸出管線中斷（SIGPIPE：畫面或 tee 已經不在）"; exit 141' PIPE
  trap 'on_err "$LINENO"' ERR
  systemctl stop fju-status-update.timer fju-status-update.service >/dev/null 2>&1 || true
  todo "安裝期間先停 fju-status-update（timer 與 service）；第 10 步守門通過才重新啟用，中途失敗就關門"
fi

# ---------------------------------------------------------------------------
# 步驟 2：目錄
# ---------------------------------------------------------------------------
step 2 "建 /srv/fju/status 的目錄與權限（設計方案 §3.1）"
ensure_dir "$STATUS_ROOT" root:root 755
ensure_dir "$SECRETS" "${DEPLOY_USER}:${DEPLOY_USER}" 700
ensure_dir "$DATA" root:root 755
# inbox 先建成 root，第 3 步建好 fjustatus 才交給它。
[ -d "$INBOX" ] || ensure_dir "$INBOX" root:root 755
ensure_dir "$ENVCHECK" "${DEPLOY_USER}:${DEPLOY_USER}" 700
for d in beszel gatus pghero; do
  if [ -d "$STATUS_ROOT/$d" ]; then skip "${STATUS_ROOT}/${d} 已存在"; else ensure_dir "$STATUS_ROOT/$d" root:root 755; fi
done
ensure_dir "$STATE_DIR" root:root 700
# Beszel agent 唯讀掛這個空目錄量根磁碟容量（§3.13）：裡面有東西 agent 就讀得到，所以必須是空的。
ensure_dir "$DISKPROBE" root:root 755
if [ -d "$DISKPROBE" ] && [ -n "$(ls -A "$DISKPROBE" 2>/dev/null)" ]; then
  [ "$DRY_RUN" = 1 ] || halt 1 "${DISKPROBE} 不是空的（Beszel agent 會讀得到裡面的東西）：清空後重跑"
  bad "${DISKPROBE} 不是空的"
fi
# 異地備份目錄：collector 唯讀掛它；路徑不同就印出來、寫進 paths.env 讓 compose 改掛載點。
if [ -d "$OFFSITE_DIR" ]; then
  ok "異地備份目錄 ${OFFSITE_DIR}：$(find "$OFFSITE_DIR" -mindepth 1 -maxdepth 1 -printf '%f ' 2>/dev/null || true)"
else
  bad "異地備份目錄 ${OFFSITE_DIR} 不存在（「24 小時內有備份」那條會是紅的）"
  candidates=$(find /srv/fju -maxdepth 3 -type d -name 'offsite*' 2>/dev/null | tr '\n' ' ' || true)
  [ -n "$candidates" ] && todo "找到可能的位置：${candidates}→ 加 --offsite-dir <路徑> 重跑"
fi
[ "$OFFSITE_DIR" = "$OFFSITE_DEFAULT" ] || todo "異地備份不在預設的 ${OFFSITE_DEFAULT}，改掛 ${OFFSITE_DIR}（STATUS_OFFSITE_DIR）"
if [ "$(cat "$PATHS_ENV" 2>/dev/null || true)" = "STATUS_OFFSITE_DIR=${OFFSITE_DIR}" ]; then
  skip "${PATHS_ENV} 已是 STATUS_OFFSITE_DIR=${OFFSITE_DIR}"
else
  printf 'STATUS_OFFSITE_DIR=%s\n' "$OFFSITE_DIR" | write_file 644 root:root "$PATHS_ENV"
fi
note "✓" "目錄（含空的 diskprobe）；異地備份 ${OFFSITE_DIR}"

# ---------------------------------------------------------------------------
# 步驟 3：fjustatus 帳號（只能用 rrsync 寫 inbox）
# ---------------------------------------------------------------------------
step 3 "帳號 ${PUBLISH_USER}＋authorized_keys（只能 rrsync 寫 inbox）＋sshd 放行"
if id "$PUBLISH_USER" >/dev/null 2>&1; then
  skip "${PUBLISH_USER} 已存在"
else
  # --system 帳號沒有密碼（鎖住）；shell 給 /bin/sh 是因為 command= 要靠它執行 rrsync，
  # 能不能開互動 shell 由 authorized_keys 的 restrict,command= 擋（跟 fjureset 一樣）。
  run useradd --system --create-home --home-dir "${HOME_ROOT}/${PUBLISH_USER}" --shell /bin/sh "$PUBLISH_USER"
fi
ensure_dir "${HOME_ROOT}/${PUBLISH_USER}/.ssh" "root:${PUBLISH_USER}" 750
AUTH_LINE="restrict,command=\"${RRSYNC} -wo ${INBOX}\" ${PUBKEY}"
AUTH_FILE=${HOME_ROOT}/${PUBLISH_USER}/.ssh/authorized_keys
if [ "$(cat "$AUTH_FILE" 2>/dev/null || true)" = "$AUTH_LINE" ]; then
  skip "authorized_keys 已是這把公鑰、綁 rrsync -wo ${INBOX}"
else
  printf '%s\n' "$AUTH_LINE" | write_file 640 "root:${PUBLISH_USER}" "$AUTH_FILE"
  # 公鑰不是秘密，印出來讓人核對綁的指令。
  todo "authorized_keys：${AUTH_LINE}"
fi
ensure_dir "$INBOX" "${PUBLISH_USER}:${PUBLISH_USER}" 755
# sshd 有 AllowUsers 白名單（ops/README.md「重置測試站專用金鑰」④）：不加進去，推送會被拒。
# 只自動改 10-fju.conf 那一行；別的檔也有 AllowUsers、或那行帶註解，就停下來請人手動改（改錯會把人鎖在外面）。
other_allow=$(grep -l '^[[:space:]]*AllowUsers' "$SSH_DIR/sshd_config" "$SSH_DIR"/sshd_config.d/*.conf 2>/dev/null | grep -vx "$SSHD_CONF" || true)
if [ -n "$other_allow" ]; then
  [ "$DRY_RUN" = 1 ] || halt 1 "AllowUsers 也寫在 ${other_allow}：請手動把 ${PUBLISH_USER} 加進去（sshd -t 後 reload ssh）再重跑"
  bad "AllowUsers 也寫在 ${other_allow}（真的跑會停在這裡）"
elif [ -f "$SSHD_CONF" ] && grep -q '^AllowUsers ' "$SSHD_CONF"; then
  if grep -Eq "^AllowUsers [^#]*(^| )${PUBLISH_USER}( |\$)" "$SSHD_CONF"; then
    skip "sshd AllowUsers 已有 ${PUBLISH_USER}"
  elif grep -q '^AllowUsers .*#' "$SSHD_CONF"; then
    [ "$DRY_RUN" = 1 ] || halt 1 "${SSHD_CONF} 的 AllowUsers 那行有註解：請手動把 ${PUBLISH_USER} 加在註解前面再重跑"
    bad "${SSHD_CONF} 的 AllowUsers 那行有註解（真的跑會停在這裡）"
  elif [ "$DRY_RUN" = 1 ]; then
    todo "會在 ${SSHD_CONF} 的 AllowUsers 加上 ${PUBLISH_USER}，sshd -t 通過才 reload ssh"
  else
    cp -p "$SSHD_CONF" "$STATE_DIR/10-fju.conf.bak"
    sed -i "s/^AllowUsers .*/& ${PUBLISH_USER}/" "$SSHD_CONF"
    if sshd -t; then
      systemctl reload ssh
      ok "sshd AllowUsers：$(grep '^AllowUsers ' "$SSHD_CONF")"
    else
      cp -p "$STATE_DIR/10-fju.conf.bak" "$SSHD_CONF"
      halt 1 "改完 sshd 設定 sshd -t 不通過，已還原 ${SSHD_CONF}；什麼都沒 reload"
    fi
  fi
else
  skip "sshd 沒有 AllowUsers 白名單（${SSHD_CONF}），不用改"
fi
note "✓" "${PUBLISH_USER} 只能寫 ${INBOX}"

# ---------------------------------------------------------------------------
# 步驟 4：重置金鑰加 seed-demo（S-7）
# ---------------------------------------------------------------------------
step 4 "重置測試站專用金鑰：裝上含 seed-demo 的兩支腳本（S-7）"
has_seed_demo=1
for f in $RESET_SCRIPTS; do
  grep -q 'seed-demo' "$APP_DIR/ops/$f" 2>/dev/null || has_seed_demo=0
done
if [ "$has_seed_demo" = 0 ]; then
  skip "重置腳本還沒有 seed-demo（S-7 還沒合併），${SBIN} 不動"
  note "跳過" "重置腳本還沒有 seed-demo"
else
  for f in $RESET_SCRIPTS; do
    if cmp -s "$APP_DIR/ops/$f" "$SBIN/$f"; then
      skip "${SBIN}/${f} 已是這個版本"
    else
      run install -o root -g root -m 755 "$APP_DIR/ops/$f" "$SBIN/$f"
    fi
  done
  echo "  兩支的 sha256（要跟 Mac 上 status-prepare.sh 印的一樣）："
  # RESET_SCRIPTS 是刻意用空白分開的兩個檔名。
  # shellcheck disable=SC2086
  (cd "$APP_DIR/ops" && sha256sum $RESET_SCRIPTS) | sed 's/^/    /'
  note "✓" "重置腳本含 seed-demo，已裝到 ${SBIN}"
fi

# ---------------------------------------------------------------------------
# 步驟 5：PgHero 唯讀角色
# ---------------------------------------------------------------------------
step 5 "pghero.env 與測試站唯讀角色 fju_monitor（只有 pg_monitor＋CONNECT）"
PGHERO_ENV=$SECRETS/pghero.env
pg_running() { [ "$(docker inspect -f '{{.State.Running}}' "$TEST_PG" 2>/dev/null || true)" = true ]; }
if [ -f "$PGHERO_ENV" ] && grep -q '^FJU_MONITOR_PASSWORD=.' "$PGHERO_ENV" && grep -q '^DATABASE_URL=.' "$PGHERO_ENV"; then
  skip "${PGHERO_ENV} 已有密碼與連線字串"
elif [ "$DRY_RUN" = 1 ]; then
  todo "會用 openssl rand -hex 24 產密碼，寫 ${PGHERO_ENV}（600，${DEPLOY_USER}）"
else
  pw=$(sed -n 's/^FJU_MONITOR_PASSWORD=//p' "$PGHERO_ENV" 2>/dev/null || true)
  [ -n "$pw" ] || pw=$(openssl rand -hex 24)
  db=""
  # 資料庫名不是秘密；單引號是刻意的：$POSTGRES_DB 在容器裡展開。
  # shellcheck disable=SC2016
  pg_running && db=$(docker exec "$TEST_PG" sh -c 'printf %s "$POSTGRES_DB"' 2>/dev/null || true)
  {
    printf 'FJU_MONITOR_PASSWORD=%s\n' "$pw"
    [ -z "$db" ] || printf 'DATABASE_URL=postgres://fju_monitor:%s@%s:5432/%s\n' "$pw" "$TEST_PG" "$db"
  } | write_file 600 "${DEPLOY_USER}:${DEPLOY_USER}" "$PGHERO_ENV"
  unset pw
  if [ -n "$db" ]; then ok "${PGHERO_ENV}（600）"; else bad "測試站 postgres 不在：pghero.env 先只寫密碼，測試站起來後重跑補連線字串"; fi
fi
if [ "$DRY_RUN" = 1 ] || pg_running; then
  (cd "$APP_DIR" 2>/dev/null || true; as_deploy bash "$STATUS_UP" --ensure-db-role-only) \
    || halt 1 "status-up.sh --ensure-db-role-only 失敗（看上面 psql 的錯誤）"
  note "✓" "pghero.env、fju_monitor"
else
  bad "${TEST_PG} 沒在跑：fju_monitor 之後由每 10 分鐘的 fju-status-update 補建"
  note "✗" "測試站 postgres 不在，fju_monitor 沒建（timer 會補）"
fi

# ---------------------------------------------------------------------------
# 步驟 6：status.env
# ---------------------------------------------------------------------------
step 6 "status.env（team、AUD；都不是秘密）"
STATUS_ENV_BODY="STATUS_DATA_DIR=/data
STATUS_ACCEPTANCE_DIR=/acceptance
ACCESS_TEAM_DOMAIN=${ACCESS_TEAM}
ACCESS_AUD=${ACCESS_AUD}
STATUS_HOSTS=${STATUS_HOSTS}"
if [ "$(cat "$SECRETS/status.env" 2>/dev/null || true)" = "$STATUS_ENV_BODY" ]; then
  skip "${SECRETS}/status.env 已是這組 team／AUD"
else
  printf '%s\n' "$STATUS_ENV_BODY" | write_file 600 "${DEPLOY_USER}:${DEPLOY_USER}" "$SECRETS/status.env"
fi
# compose 的 env_file 缺檔會整個起不來；Beszel 金鑰第 11 步才有，先放空檔。
if [ -f "$SECRETS/beszel-agent.env" ]; then
  skip "beszel-agent.env 已存在"
else
  printf '' | write_file 600 "${DEPLOY_USER}:${DEPLOY_USER}" "$SECRETS/beszel-agent.env"
fi
note "✓" "status.env（${ACCESS_TEAM}）"

# ---------------------------------------------------------------------------
# 步驟 7、7b：Cloudflare Tunnel 與隧道端 JWT 鎖的隔離驗證
# ---------------------------------------------------------------------------
step 7 "Cloudflare Tunnel ${TUNNEL_NAME}（${CLOUDFLARED_IMAGE}）：登入、建隧道、四個網址的 DNS、產生設定"
NEED_LOGIN=0
[ -s "$SECRETS/tunnel.json" ] || NEED_LOGIN=1
marker_ok || NEED_LOGIN=1
if [ "$DRY_RUN" = 1 ]; then
  if [ "$NEED_LOGIN" = 1 ]; then
    todo "會跑 cloudflared tunnel login（印一個網址，Roy 打開選 roy422.dev 授權；cert.pem 只放 ${LOGIN_DIR}）"
    todo "會建隧道 ${TUNNEL_NAME}（已存在就沿用、補抓憑證）→ ${SECRETS}/tunnel.json（600，${DEPLOY_USER}）"
    for h in $STATUS_HOSTS; do todo "會設 DNS：cloudflared tunnel route dns ${TUNNEL_NAME} ${h}"; done
  else
    skip "已有 tunnel.json 與第 7b 步通過紀錄（同 team／AUD／cloudflared 版本），不用再登入"
  fi
  todo "會執行：STATUS_HOSTS='${STATUS_HOSTS}' bash ${RENDER} --team $(team_name) --aud <AUD> --tunnel-id <隧道 id> --out ${CLOUDFLARED_YML}"
  todo "會用第 10 步同一個檢查核對產生的設定"
  note "→" "（--dry-run）隧道與設定"
else
  # 上次被硬砍（kill -9、當機）留下的 cert.pem 先刪掉；要用時下面會重新登入。
  rm -rf "$LOGIN_DIR"
  if [ "$NEED_LOGIN" = 1 ]; then
    # 決定重做 7b 就先把舊的通過紀錄刪掉：驗證與四類清理全部通過才會原子地寫新的（write_file 是暫存檔＋mv）。
    # 不先刪的話：tunnel.json 遺失→重做 7b→驗證過但清理失敗→舊紀錄還在、tunnel.json 又已寫好，
    # 再重跑就會跳過 7b、結束碼 0，殘留的暫時 DNS 沒人清。
    rm -f "$VERIFY_MARKER"
    install -d -o root -g root -m 700 "$LOGIN_DIR"
    run docker pull -q "$CLOUDFLARED_IMAGE" >/dev/null
    printf '\n  \033[1m下面會印一個 https://dash.cloudflare.com/argotunnel?… 網址：用瀏覽器打開、選 roy422.dev、按 Authorize。\033[0m\n' 2>/dev/null
    cf_login || halt 1 "cloudflared tunnel login 沒成功（網址要在幾分鐘內點）；重跑同一行即可"
    ok "已授權（cert.pem 在 ${LOGIN_DIR}，結束時刪掉）"
    if [ -s "$SECRETS/tunnel.json" ]; then
      skip "${SECRETS}/tunnel.json 已存在"
    else
      if [ -n "$(tunnel_id_by_name "$TUNNEL_NAME")" ]; then
        cf token --cred-file "/cf/.cloudflared/${TUNNEL_NAME}.json" "$TUNNEL_NAME" >/dev/null \
          || halt 1 "隧道 ${TUNNEL_NAME} 已存在但抓不到憑證"
        ok "沿用既有隧道 ${TUNNEL_NAME}"
      else
        cf create --credentials-file "/cf/.cloudflared/${TUNNEL_NAME}.json" "$TUNNEL_NAME" >/dev/null \
          || halt 1 "建隧道 ${TUNNEL_NAME} 失敗"
        ok "建好隧道 ${TUNNEL_NAME}"
      fi
      install -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 600 "$LOGIN_DIR/${TUNNEL_NAME}.json" "$SECRETS/tunnel.json"
      ok "${SECRETS}/tunnel.json（600，${DEPLOY_USER}）"
    fi
    for h in $STATUS_HOSTS; do
      route_dns "$TUNNEL_NAME" "$h" || halt 1 "DNS ${h} 設不上（同名記錄若指到別處，先到 Cloudflare DNS 確認再刪）"
    done
  else
    skip "已有 tunnel.json 與第 7b 步通過紀錄（同 team／AUD／cloudflared 版本），不用再登入"
  fi
  TUNNEL_ID=$(cred_tunnel_id "$SECRETS/tunnel.json")
  STATUS_HOSTS="$STATUS_HOSTS" bash "$RENDER" --team "$(team_name)" --aud "$ACCESS_AUD" \
    --tunnel-id "$TUNNEL_ID" --out "$CLOUDFLARED_YML" || halt 1 "${RENDER} 產生設定失敗"
  chmod 644 "$CLOUDFLARED_YML"
  check_cloudflared_config "$CLOUDFLARED_YML" "$(team_name)" "$ACCESS_AUD" "$STATUS_HOSTS" \
    || halt 1 "產生出來的 ${CLOUDFLARED_YML} 沒有每條都帶 originRequest.access：不起服務"
  ok "${CLOUDFLARED_YML}：四條 ingress 都帶 originRequest.access"
  note "✓" "隧道 ${TUNNEL_NAME}、四個網址 DNS、設定檔"
fi

step 7b "隧道端 JWT 鎖的隔離驗證（暫時隧道 ${VERIFY_TUNNEL}、暫時網址 ${VERIFY_HOST}、計數假 origin；不碰真後台）"
# 有鎖：access.required: true（同 team、同 AUD）；沒鎖：同一份拿掉 originRequest 區塊（突變測試）。
write_verify_configs() { # <隧道 id>
  cat >"$LOGIN_DIR/verify-locked.yml" <<EOF
tunnel: $1
credentials-file: /etc/cloudflared/tunnel.json
ingress:
  - hostname: ${VERIFY_HOST}
    service: http://${VERIFY_ORIGIN}:${VERIFY_PORT}
    originRequest:
      access:
        required: true
        teamName: $(team_name)
        audTag:
          - ${ACCESS_AUD}
  - service: http_status:404
EOF
  awk '/^    originRequest:/ { skip = 1; next } skip && /^      / { next } { skip = 0; print }' \
    "$LOGIN_DIR/verify-locked.yml" >"$LOGIN_DIR/verify-open.yml"
}
start_verify_cf() { # <設定檔>
  docker rm -f "$VERIFY_CF" >/dev/null 2>&1 || true
  docker run -d --name "$VERIFY_CF" --network "$VERIFY_NET" --memory 128m --user 0:0 \
    -v "$LOGIN_DIR/verify.json:/etc/cloudflared/tunnel.json:ro" \
    -v "$1:/etc/cloudflared/config.yml:ro" \
    "$CLOUDFLARED_IMAGE" tunnel --no-autoupdate --config /etc/cloudflared/config.yml run >/dev/null
}
# 等暫時網址真的經過 Cloudflare 打到這個 cloudflared：打 /ready（假 origin 回 404、不計數）直到拿到預期的碼。
wait_verify_ready() { # <預期碼>
  local code=""
  for _ in $(seq 1 36); do
    code=$(curl -s -o /dev/null -m 15 -w '%{http_code}' "https://${VERIFY_HOST}/ready" || true)
    [ "$code" = "$1" ] && return 0
    sleep 5
  done
  bad "等了 3 分鐘，${VERIFY_HOST}/ready 還是 ${code}（預期 ${1}）"
  return 1
}
probe3() { # 從 VM 經 Cloudflare 打 /probe 三次，印三個 HTTP 碼
  local out=""
  for _ in 1 2 3; do out="${out} $(curl -s -o /dev/null -m 15 -w '%{http_code}' "https://${VERIFY_HOST}/probe" || true)"; done
  echo "${out# }"
}
read_count() { # 從暫時網路內讀假 origin 的 /count（唯讀、不計數）
  docker run --rm --network "$VERIFY_NET" "$CURL_IMAGE" -s -m 10 "http://${VERIFY_ORIGIN}:${VERIFY_PORT}/count" | tr -cd '0-9'
}
verify_tunnel_lock() {
  local vid codes c1 c2
  # 先清上次可能留下的暫時資源；清不掉也先往下（真的還在，下面建隧道或設 DNS 會撞到而停）。
  cleanup_verify
  VERIFY_CLEANUP_FAILED=0
  as_deploy docker pull -q "$STATUS_IMAGE" >/dev/null || { bad "拉不到 ${STATUS_IMAGE}"; return 1; }
  docker pull -q "$CURL_IMAGE" >/dev/null || { bad "拉不到 ${CURL_IMAGE}"; return 1; }
  docker network create "$VERIFY_NET" >/dev/null || return 1
  docker run -d --name "$VERIFY_ORIGIN" --network "$VERIFY_NET" --memory 64m -e PORT="$VERIFY_PORT" \
    --pull never "$STATUS_IMAGE" node verify-origin.mjs >/dev/null || { bad "假 origin 起不來"; return 1; }
  cf create --credentials-file /cf/.cloudflared/verify.json "$VERIFY_TUNNEL" >/dev/null || { bad "建暫時隧道失敗"; return 1; }
  route_dns "$VERIFY_TUNNEL" "$VERIFY_HOST" || return 1
  vid=$(cred_tunnel_id "$LOGIN_DIR/verify.json") || { bad "讀不到暫時隧道的憑證"; return 1; }
  write_verify_configs "$vid" || return 1
  # 兩份設定先過第 10 步同一個檢查：有鎖那份必須過、拿掉 access 那份必須不過（檢查本身也分得出來）。
  check_cloudflared_config "$LOGIN_DIR/verify-locked.yml" "$(team_name)" "$ACCESS_AUD" "$VERIFY_HOST" >/dev/null \
    || { bad "有鎖的暫時設定沒通過檢查"; return 1; }
  if check_cloudflared_config "$LOGIN_DIR/verify-open.yml" "$(team_name)" "$ACCESS_AUD" "$VERIFY_HOST" >/dev/null; then
    bad "拿掉 access 的暫時設定竟然通過檢查"; return 1
  fi

  echo "  第一輪：有鎖（access.required: true）"
  start_verify_cf "$LOGIN_DIR/verify-locked.yml" || return 1
  wait_verify_ready 403 || return 1
  codes=$(probe3); c1=$(read_count); c2=$(read_count)
  echo "    /probe ×3 → ${codes}；/count → ${c1:-?}、${c2:-?}"
  [ "$codes" = "403 403 403" ] && [ "$c1" = 0 ] && [ "$c2" = 0 ] \
    || { bad "第一輪要三次都 403、計數兩次都 0"; return 1; }
  ok "三次都被隧道端擋下（403），假 origin 一個都沒收到"

  echo "  第二輪（突變）：同一份設定拿掉 originRequest.access"
  start_verify_cf "$LOGIN_DIR/verify-open.yml" || return 1
  wait_verify_ready 404 || return 1
  codes=$(probe3); c1=$(read_count); c2=$(read_count)
  echo "    /probe ×3 → ${codes}；/count → ${c1:-?}、${c2:-?}"
  [ "$c1" = 3 ] && [ "$c2" = 3 ] || { bad "第二輪計數要兩次都剛好 3"; return 1; }
  ok "拿掉鎖後假 origin 剛好收到 3 個：這個測試分得出有鎖沒鎖"
}
if [ "$DRY_RUN" = 1 ]; then
  if [ "$NEED_LOGIN" = 1 ]; then
    todo "會建暫時網路 ${VERIFY_NET}、假 origin（${STATUS_IMAGE} node verify-origin.mjs）、暫時隧道 ${VERIFY_TUNNEL}、DNS ${VERIFY_HOST}"
    todo "第一輪（有鎖）：從 VM 打 https://${VERIFY_HOST}/probe 三次要都是 403，暫時網路內（${CURL_IMAGE}）讀 /count 兩次要都是 0"
    todo "第二輪（拿掉 access）：再打 /probe 三次，/count 兩次要都是 3"
    todo "最後刪暫時容器、網路、隧道、DNS，再刪 cert.pem；任一不符就停在這一步、結束碼 1"
  else
    skip "已通過（$(sed -n 's/^at=//p' "$VERIFY_MARKER" 2>/dev/null)）"
  fi
  note "→" "（--dry-run）隔離驗證"
elif [ "$NEED_LOGIN" = 0 ]; then
  skip "已通過（$(sed -n 's/^at=//p' "$VERIFY_MARKER")，同 team／AUD／cloudflared 版本）"
  note "跳過" "隔離驗證先前已通過"
else
  vrc=0
  verify_tunnel_lock || vrc=1
  echo "  清理暫時資源："
  cleanup_verify
  if [ "$VERIFY_CLEANUP_FAILED" = 0 ]; then ok "暫時容器、網路、隧道 ${VERIFY_TUNNEL}、DNS ${VERIFY_HOST} 都確定不在了"; fi
  rm -rf "$LOGIN_DIR"
  ok "已刪 cert.pem"
  [ "$vrc" = 0 ] || halt 1 "隧道端 JWT 鎖驗證沒過：不起服務（暫時資源已清，沒清掉的上面有印）"
  # 四類暫時資源都確定不在了才寫通過紀錄；沒清乾淨就不寫，下次重跑會重新登入、重新核對殘留。
  [ "$VERIFY_CLEANUP_FAILED" = 0 ] \
    || halt 1 "驗證本身通過，但暫時資源沒確定清乾淨（上面有印）：不寫通過紀錄。手動刪掉後重跑同一行，會重新核對"
  { marker_body; printf 'at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"; } | write_file 600 root:root "$VERIFY_MARKER"
  note "✓" "有鎖 403×3／計數 0；拿掉鎖計數 3；四類暫時資源確定已清"
fi

# ---------------------------------------------------------------------------
# 步驟 8：systemd
# ---------------------------------------------------------------------------
step 8 "systemd：fju-status-update（每 10 分鐘）、fju-status-envcheck（每天）"
units_changed=0
units_missing=0
for u in $UNITS; do
  if [ ! -f "$UNIT_SRC/$u" ]; then
    [ "$DRY_RUN" = 1 ] || halt 1 "${UNIT_SRC}/${u} 不存在（S-4 還沒合併或 ops 沒送上 VM）"
    bad "${UNIT_SRC}/${u} 不存在"
    units_missing=1
  elif cmp -s "$UNIT_SRC/$u" "$UNIT_DIR/$u"; then
    skip "${u} 已是這個版本"
  else
    run install -o root -g root -m 644 "$UNIT_SRC/$u" "$UNIT_DIR/$u"
    units_changed=1
  fi
done
[ "$units_changed" = 0 ] || run systemctl daemon-reload
timer_on() { systemctl is-enabled --quiet "$1" 2>/dev/null && systemctl is-active --quiet "$1" 2>/dev/null; }
if timer_on fju-status-envcheck.timer; then skip "fju-status-envcheck.timer 已啟用"; else run systemctl enable --now fju-status-envcheck.timer; fi
# 自動更新會 up -d 把 cloudflared 起來，所以等第 10 步守門通過才啟用（守門沒過時它不能把門再打開）。
todo "fju-status-update.timer 等第 10 步守門通過才啟用"
if [ "$units_missing" = 1 ]; then note "✗" "systemd 檔還沒有（S-4）"; else note "✓" "兩組 unit；envcheck timer 已啟用"; fi

# ---------------------------------------------------------------------------
# 步驟 9：起服務
# ---------------------------------------------------------------------------
step 9 "起服務（以 ${DEPLOY_USER} 跑 status-up.sh），等 status-web /healthz"
(cd "$APP_DIR" 2>/dev/null || true; as_deploy bash "$STATUS_UP") || halt 1 "status-up.sh 失敗（看上面 docker compose 的輸出）"
healthz_ok() {
  local cid health net
  cid=$(svc_cids status-web | head -n 1)
  [ -n "$cid" ] || return 1
  health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$cid" 2>/dev/null || true)
  if [ -n "$health" ]; then [ "$health" = healthy ]; return; fi
  net=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$cid" | awk '{print $1}')
  [ "$(docker run --rm --network "$net" "$CURL_IMAGE" -s -m 5 http://status-web:3000/healthz 2>/dev/null)" = ok ]
}
if [ "$DRY_RUN" = 1 ]; then
  todo "會等 status-web 的 /healthz 回 ok（最多 2 分鐘）"
  note "→" "（--dry-run）起服務"
else
  up=0
  for _ in $(seq 1 24); do healthz_ok && { up=1; break; }; sleep 5; done
  [ "$up" = 1 ] || halt 1 "status-web 2 分鐘內沒有變 healthy（docker logs 看 status-web）"
  ok "status-web /healthz ok"
  note "✓" "服務已起、status-web 健康"
fi

# ---------------------------------------------------------------------------
# 步驟 10：Access 守門（失敗就關門）
# ---------------------------------------------------------------------------
step 10 "Access 守門：四個網址沒帶 cookie 都要被導到登入頁；容器裡實際掛載的設定要有 access 區塊"
close_gate() {
  bad "$*"
  close_door
  halt 1 "守門沒過：$*"
}
if [ "$DRY_RUN" = 1 ]; then
  for h in $STATUS_HOSTS; do todo "會打 curl -sI https://${h}：要 302、Location 開頭 https://${ACCESS_TEAM}/cdn-cgi/access/login"; done
  todo "會用 docker cp <cloudflared 容器>:/etc/cloudflared/config.yml - 取出實際掛載的設定，用 --check-cloudflared-config 同一個檢查核對"
  todo "任一不符：停 cloudflared、停 fju-status-update（timer 與 service）、結束碼 1"
  todo "通過才 systemctl enable --now fju-status-update.timer"
  note "→" "（--dry-run）守門"
else
  unguarded=""
  for h in $STATUS_HOSTS; do
    res=""
    # 隧道剛起、DNS 剛生效時會有 000／5xx，等一下；其他任何碼都直接算沒擋住。
    for _ in $(seq 1 12); do
      res=$(curl -sI -o /dev/null -m 15 -w '%{http_code} %{redirect_url}' "https://${h}/" || true)
      case "$res" in 000*|5*) sleep 10 ;; *) break ;; esac
    done
    case "$res" in
      "302 https://${ACCESS_TEAM}/cdn-cgi/access/login"*) ok "${h} → 302 Access 登入頁" ;;
      *) bad "${h} 沒被擋：${res}"; unguarded="${unguarded} ${h}" ;;
    esac
  done
  [ -z "$unguarded" ] || close_gate "這幾個網址沒被 Access 擋住：${unguarded# }"
  cf_cids=$(svc_cids cloudflared || true)
  [ -n "$cf_cids" ] || close_gate "找不到 fju-status 的 cloudflared 容器"
  for cf_cid in $cf_cids; do
    mounted=$(mktemp) || close_gate "mktemp 失敗"
    # cloudflared 映像是 distroless（沒有 cat）；docker cp 到 stdout 是 tar。
    if docker cp "${cf_cid}:/etc/cloudflared/config.yml" - 2>/dev/null | tar -xOf - >"$mounted" 2>/dev/null \
      && check_cloudflared_config "$mounted" "$(team_name)" "$ACCESS_AUD" "$STATUS_HOSTS"; then
      rm -f "$mounted"
      ok "cloudflared 容器 ${cf_cid} 裡實際掛載的設定：四條 ingress 都有 originRequest.access（required、teamName、audTag）"
    else
      rm -f "$mounted"
      close_gate "cloudflared 容器 ${cf_cid} 裡實際掛載的設定沒有每條都帶 originRequest.access"
    fi
  done
  GATE_ARMED=0
  systemctl enable --now fju-status-update.timer
  ok "守門通過，啟用 fju-status-update.timer（每 10 分鐘）"
  note "✓" "四個網址都 302 到 Access；實際設定有隧道端 JWT 鎖；自動更新已啟用"
fi

# ---------------------------------------------------------------------------
# 步驟 11：Beszel
# ---------------------------------------------------------------------------
step 11 "Beszel：把 hub 的公鑰寫進 beszel-agent.env、重起 agent"
if [ "$DRY_RUN" = 1 ]; then
  todo "會等 hub 產生 /beszel_data/id_ed25519，算出公鑰寫進 ${SECRETS}/beszel-agent.env（KEY=…），再跑一次 status-up.sh"
  todo "會印 Roy 在 Beszel「新增系統」要填的 socket 路徑 ${BESZEL_SOCKET} 與公鑰"
  note "→" "（--dry-run）Beszel"
else
  pub=""
  for _ in $(seq 1 12); do
    hub=$(svc_cids beszel | head -n 1)
    if [ -n "$hub" ]; then
      keytmp=$(mktemp)
      if docker cp "${hub}:/beszel_data/id_ed25519" - 2>/dev/null | tar -xOf - >"$keytmp" 2>/dev/null && [ -s "$keytmp" ]; then
        pub=$(ssh-keygen -y -f "$keytmp" 2>/dev/null || true)
      fi
      rm -f "$keytmp"
    fi
    [ -n "$pub" ] && break
    sleep 5
  done
  if [ -z "$pub" ]; then
    bad "1 分鐘內拿不到 Beszel hub 的公鑰：開 Beszel「新增系統」複製公鑰，寫進 ${SECRETS}/beszel-agent.env 的 KEY= 後重跑"
    note "✗" "Beszel agent 金鑰沒寫（不影響三頁）"
  else
    AGENT_ENV_BODY="KEY=\"${pub}\"
LISTEN=${BESZEL_SOCKET}"
    if [ "$(cat "$SECRETS/beszel-agent.env" 2>/dev/null || true)" = "$AGENT_ENV_BODY" ]; then
      skip "beszel-agent.env 已是 hub 的公鑰"
    else
      printf '%s\n' "$AGENT_ENV_BODY" | write_file 600 "${DEPLOY_USER}:${DEPLOY_USER}" "$SECRETS/beszel-agent.env"
    fi
    # 每次都跑（up -d 冪等）：上次重起失敗時，重跑才會真的把新金鑰套上去。
    if (cd "$APP_DIR"; as_deploy bash "$STATUS_UP"); then
      printf '\n  Roy 第一次開 https://fju-status-vm.roy422.dev 建帳號後，按「新增系統」：\n'
      printf '    Host / IP 填：\033[1m%s\033[0m（是 socket 路徑，不是網址）\n' "$BESZEL_SOCKET"
      printf '    公鑰：%s\n' "$pub"
      note "✓" "Beszel agent 金鑰；新增系統填 ${BESZEL_SOCKET}"
    else
      bad "金鑰寫好了，但 status-up.sh 重起 agent 失敗（看上面）：修好後重跑同一行"
      note "✗" "Beszel agent 重起失敗（金鑰已寫，agent 還沒套上）"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# 步驟 12：結尾
# ---------------------------------------------------------------------------
step 12 "結尾：記憶體與容器用量、摘要"
show_usage_snapshot | sed 's/^/    /'
note "✓" "印出安裝後的記憶體與容器用量"
printf '\n\033[1m摘要\033[0m\n%s' "$SUMMARY"
if [ "$DRY_RUN" = 1 ]; then
  [ "$FAILED" = 0 ] || printf '\n上面有 ✗：真的跑會停在那一步，先補齊。\n'
  printf '\n--dry-run 結束：沒有建立或改動任何東西。\n'
  exit 0
fi
if [ "$FAILED" = 1 ]; then
  printf '\n有 ✗ 的步驟要處理（看上面），處理完重跑同一行；已完成的步驟會跳過。\n'
  exit 3
fi
exit 0
