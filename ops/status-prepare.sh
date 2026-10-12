#!/usr/bin/env bash
# 開發者後台｜Mac mini 的準備腳本（設計方案 §3.11；票 S-9）。不用 sudo，由工程主腦在 repo 根目錄跑。
#
#   ops/status-prepare.sh --access-team <team>.cloudflareaccess.com --access-aud <AUD>
#   ops/status-prepare.sh --dry-run --access-team … --access-aud …   # 只印不做：不產金鑰、不連 VM
#
# 做四件事：
#   1. 產驗收結果推送金鑰 ~/.ssh/fju_status_publish（ed25519、無密碼；已有就沿用）
#   2. 把 compose 檔與 ops/ 送到 VM 的 /tmp/fju-app/（只開一次 rsync 連線）
#   3. 印兩支重置腳本的 sha256（VM 安裝第 4 步會印同樣兩行，要一樣）
#   4. 印 Roy 在 VM 要貼的那一行（/tmp/fju-app 放進 /srv/fju/app，再跑 status-install.sh）
#
# 其他參數：--vm-host <ssh 主機名>（預設 fju-vm，見 ops/ssh-config.example）、
#           --key <私鑰路徑>（預設 ~/.ssh/fju_status_publish）
# team 網域與 AUD 是 Roy 從 Zero Trust 貼到對話的兩個值（不是秘密）；還沒拿到就先不帶，那一行會留空格讓你補。

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

VM_HOST=fju-vm
KEY=${HOME}/.ssh/fju_status_publish
KEY_COMMENT=fju-status-publish
DRY_RUN=0
ACCESS_TEAM=""
ACCESS_AUD=""
# 跟 ops/README.md「repo 的 ops／compose 檔改了之後」同一組，再加後台的 compose 檔。
# VM 那一行用 rsync --delete 放進 /srv/fju/app，所以少列一個檔，VM 上那個檔就會被刪。
SEND="docker-compose.yml docker-compose.vm.yml docker-compose.edge.yml docker-compose.drill.yml docker-compose.status.yml ops"
RESET_SCRIPTS="fju-test-reset fju-test-reset-gate"

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
skip() { printf '  \033[36m跳過\033[0m %s\n' "$*"; }
todo() { printf '  \033[33m→\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die()  { echo "$*" >&2; exit 1; }
usage() { sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
run() {
  if [ "$DRY_RUN" = 1 ]; then todo "會執行：$*"; else "$@"; fi
}

need_val() { [ $# -ge 2 ] && [ -n "$2" ] || die "$1 後面要接值（--help 看用法）"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --access-team) need_val "$@"; ACCESS_TEAM=$2; shift ;;
    --access-team=*) ACCESS_TEAM=${1#*=} ;;
    --access-aud) need_val "$@"; ACCESS_AUD=$2; shift ;;
    --access-aud=*) ACCESS_AUD=${1#*=} ;;
    --vm-host) need_val "$@"; VM_HOST=$2; shift ;;
    --key) need_val "$@"; KEY=$2; shift ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "不認得的參數：$1（--help 看用法）" ;;
  esac
  shift
done
if [ "$(id -u)" -eq 0 ]; then
  die "不要用 sudo 跑這支：金鑰要產在你自己的 ~/.ssh"
fi
if [ -n "$ACCESS_TEAM" ] && ! [[ "$ACCESS_TEAM" =~ ^[a-z0-9][a-z0-9-]*\.cloudflareaccess\.com$ ]]; then
  die "--access-team 要是 <team>.cloudflareaccess.com，收到：「${ACCESS_TEAM}」"
fi
if [ -n "$ACCESS_AUD" ] && ! [[ "$ACCESS_AUD" =~ ^[A-Za-z0-9]{32,128}$ ]]; then
  die "--access-aud 要是 Access 應用程式的 AUD tag（32–128 個英數字）"
fi
[ "$DRY_RUN" = 1 ] && printf '\033[1m--dry-run：只印不做，不產金鑰、不連 VM。\033[0m\n'

step "1. 版本與檔案"
echo "  分支 $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')，commit $(git rev-parse HEAD 2>/dev/null || echo '?')"
[ -z "$(git status --porcelain 2>/dev/null)" ] || bad "工作目錄有沒 commit 的改動：送上 VM 的會是現在這份檔案"
missing=""
for f in $SEND ops/status-install.sh ops/status-up.sh ops/status-render-cloudflared.sh; do
  [ -e "$f" ] || missing="${missing} ${f}"
done
if [ -n "$missing" ]; then
  bad "缺：${missing# }（S-4 還沒合併時只能 --dry-run）"
  [ "$DRY_RUN" = 1 ] || exit 1
else
  ok "要送的檔都在"
fi

step "2. 推送金鑰 ${KEY}"
if [ -s "$KEY" ] && [ -s "${KEY}.pub" ]; then
  skip "已有，沿用"
else
  run ssh-keygen -q -t ed25519 -N '' -f "$KEY" -C "$KEY_COMMENT"
  [ "$DRY_RUN" = 1 ] || ok "產好了（無密碼；只能用 rrsync 寫 VM 的 /srv/fju/status/inbox）"
fi
if [ -s "${KEY}.pub" ]; then
  PUBKEY=$(cat "${KEY}.pub")
else
  PUBKEY="<--dry-run：金鑰還沒產，${KEY}.pub>"
fi
grep -q '^Host fju-status-publish$' "${HOME}/.ssh/config" 2>/dev/null \
  || todo "~/.ssh/config 還沒有 Host fju-status-publish：照 ops/ssh-config.example 那段貼上（驗收結果推送用，S-8）"

step "3. 送 ops 與 compose 到 ${VM_HOST}:/tmp/fju-app/（一次連線）"
# shellcheck disable=SC2086 # SEND 是刻意分詞的檔案清單
run rsync -a --delete $SEND "${VM_HOST}:/tmp/fju-app/"
[ "$DRY_RUN" = 1 ] || ok "送好了"

step "4. 兩支重置腳本的 sha256（VM 安裝第 4 步會印同樣兩行）"
(cd ops && shasum -a 256 $RESET_SCRIPTS) | sed 's/^/    /'
grep -q 'seed-demo' ops/fju-test-reset 2>/dev/null \
  || todo "重置腳本還沒有 seed-demo（S-7 還沒合併）：VM 第 4 步會印「跳過」"

step "5. Roy 在 VM 貼的那一行（ssh ${VM_HOST} 之後整行貼上；sudo 問一次密碼，中途點一次 Cloudflare 授權網址）"
TEAM_SHOWN=${ACCESS_TEAM:-<team>.cloudflareaccess.com}
AUD_SHOWN=${ACCESS_AUD:-<AUD>}
# protect：安裝第 7 步產生的 ops/status/cloudflared.yml 不在 repo 裡，--delete 不能把它刪掉。
printf '\n'
printf "sudo rsync -a --delete --filter='P /ops/status/cloudflared.yml' --chown=deploy:deploy /tmp/fju-app/ /srv/fju/app/ && sudo bash /srv/fju/app/ops/status-install.sh --access-team %s --access-aud %s --publish-pubkey '%s'\n" \
  "$TEAM_SHOWN" "$AUD_SHOWN" "$PUBKEY"
printf '\n'
if [ -z "$ACCESS_TEAM" ] || [ -z "$ACCESS_AUD" ]; then
  todo "還沒帶 --access-team／--access-aud：Roy 貼來 team 網域與 AUD 後重跑這支（金鑰沿用、rsync 只補差異）"
fi
echo "  貼之前想先看一遍會做什麼（不用 sudo、不寫任何東西）：在 VM 跑"
echo "    FJU_STATUS_APP_DIR=/tmp/fju-app bash /tmp/fju-app/ops/status-install.sh --dry-run --access-team … --access-aud … --publish-pubkey '…'"
