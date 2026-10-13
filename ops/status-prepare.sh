#!/usr/bin/env bash
# 開發者後台｜Mac mini 的準備腳本（設計方案 §3.11；票 S-9）。不用 sudo，由工程主腦在 repo 根目錄跑。
#
#   ops/status-prepare.sh --access-team <team>.cloudflareaccess.com --access-aud <AUD>
#   ops/status-prepare.sh --dry-run --access-team … --access-aud …   # 只印不做：不產金鑰、不連 VM
#   ops/status-prepare.sh --keep-site-compose --access-team … --access-aud …
#       # 印的 VM 那一行不換主站的 docker-compose.vm.yml／edge.yml（VM 還沒做兩站網路拆分、今晚只裝後台時用）
#
# 做四件事：
#   1. 產驗收結果推送金鑰 ~/.ssh/fju_status_publish（ed25519、無密碼；已有就沿用）
#   2. 把 compose 檔與 ops/ 送到 VM 的 /tmp/fju-app/（只開一次 rsync 連線）
#   3. 印兩支重置腳本的 sha256（VM 安裝第 4 步會印同樣兩行，要一樣）
#   4. 印 Roy 在 VM 要做的兩段：第 5 步「同步／搬遷」（備份核對→rsync→Doppler 探針→網路搬遷→恢復自動部署）、
#      第 6 步「安裝後台」那一行（搬遷全部 ✓ 才貼）
#
# 其他參數：--vm-host <ssh 主機名>（預設 fju-vm，見 ops/ssh-config.example）、
#           --key <私鑰路徑>（預設 ~/.ssh/fju_status_publish）
# --keep-site-compose：VM 那一行的 rsync 多 --exclude 兩個主站 compose（不傳也不刪，VM 留舊版）。VM 上 `docker network ls`
#   還沒有 fju-edge-test 時，換成拆分版 compose 會讓下一次自動部署失敗（外部網路不存在）；要嘛先照
#   ops/README.md〈兩站網路拆分上線步驟〉搬遷，要嘛帶這個旗標只裝後台、搬遷另找時間。
# team 網域與 AUD 是 Roy 從 Zero Trust 貼到對話的兩個值（不是秘密）；還沒拿到就先不帶，那一行會留空格讓你補。

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

VM_HOST=fju-vm
KEY=${HOME}/.ssh/fju_status_publish
KEY_COMMENT=fju-status-publish
DRY_RUN=0
KEEP_SITE_COMPOSE=0
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
    --keep-site-compose) KEEP_SITE_COMPOSE=1 ;;
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
  || todo "\${HOME}/.ssh/config 還沒有 Host fju-status-publish：照 ops/ssh-config.example 那段貼上（驗收結果推送用，S-8）"

step "3. 送 ops 與 compose 到 ${VM_HOST}:/tmp/fju-app/（一次連線）"
# shellcheck disable=SC2086 # SEND 是刻意分詞的檔案清單
run rsync -a --delete $SEND "${VM_HOST}:/tmp/fju-app/"
[ "$DRY_RUN" = 1 ] || ok "送好了"

step "4. 兩支重置腳本的 sha256（VM 安裝第 4 步會印同樣兩行）"
# RESET_SCRIPTS 是刻意用空白分開的兩個檔名。
# shellcheck disable=SC2086
(cd ops && shasum -a 256 $RESET_SCRIPTS) | sed 's/^/    /'
grep -q 'seed-demo' ops/fju-test-reset 2>/dev/null \
  || todo "重置腳本還沒有 seed-demo（S-7 還沒合併）：VM 第 4 步會印「跳過」"

step "5. 同步／搬遷（Roy 在 VM 貼；一個 ssh 視窗做完，每一步印 ✓ 才做下一步）"
TEAM_SHOWN=${ACCESS_TEAM:-<team>.cloudflareaccess.com}
AUD_SHOWN=${ACCESS_AUD:-<AUD>}
# protect：安裝第 7 步產生的 ops/status/cloudflared.yml 不在 repo 裡，--delete 不能把它刪掉。
# --keep-site-compose：exclude 的檔 rsync 不傳也不刪（沒帶 --delete-excluded），VM 的主站 compose 維持原樣。
RSYNC_FILTERS="--filter='P /ops/status/cloudflared.yml'"
DIFF_EXCLUDES="--exclude=cloudflared.yml"
if [ "$KEEP_SITE_COMPOSE" = 1 ]; then
  RSYNC_FILTERS="$RSYNC_FILTERS --exclude='/docker-compose.vm.yml' --exclude='/docker-compose.edge.yml'"
  DIFF_EXCLUDES="$DIFF_EXCLUDES --exclude=docker-compose.vm.yml --exclude=docker-compose.edge.yml"
fi
VM_RSYNC="sudo rsync -a --delete $RSYNC_FILTERS --chown=deploy:deploy /tmp/fju-app/ /srv/fju/app/"
INSTALL_LINE="sudo bash /srv/fju/app/ops/status-install.sh --access-team $TEAM_SHOWN --access-aud $AUD_SHOWN --publish-pubkey '$PUBKEY'"
# 備份→核對完整→同步→核對一致：一條 && 鏈（貼進去是一個指令），任一步失敗就停、不往下寫，
# 並印出停在哪一步與還原指令。$BAK 在 VM 上取時間戳；之後的還原指令用 ${BAK:?}，變數不在就拒跑。
SYNC_BLOCK="BAK=/srv/fju/app.bak-\$(date +%Y%m%d-%H%M%S) \\
&& { sudo cp -a /srv/fju/app \"\$BAK\" && sudo diff -r /srv/fju/app \"\$BAK\" && echo \"✓ 備份完整：\${BAK}（\$(sudo find \"\$BAK\" -type f | wc -l) 個檔）\" || { echo \"✗ 停在備份：\${BAK} 複製失敗或不完整——/srv/fju/app 沒動、不要同步，把輸出交給主腦\"; false; }; } \\
&& { $VM_RSYNC && sudo diff -r $DIFF_EXCLUDES /tmp/fju-app /srv/fju/app && echo \"✓ 已同步：/srv/fju/app 與 /tmp/fju-app 一致（還原點 \${BAK}）\" || { echo \"✗ 停在同步：還原 → sudo rsync -a --delete \${BAK:?}/ /srv/fju/app/ ，再把輸出交給主腦\"; false; }; }"

echo "  先看會變哪些檔（不用 sudo、不寫任何東西；清單裡不該有 *deleting）："
echo "    rsync -n -ai --delete $RSYNC_FILTERS /tmp/fju-app/ /srv/fju/app/"
if [ "$KEEP_SITE_COMPOSE" = 1 ]; then
  todo "--keep-site-compose：VM 的 docker-compose.vm.yml／edge.yml 不會被換（留舊版）。搬遷網路時照 ops/README.md〈兩站網路拆分上線步驟〉重做，那時 rsync 不帶 --exclude；搬遷前不要在 VM 跑 vm-setup.sh（它會對舊 compose 印 ✗）"
  echo "  5-1 B1 暫停自動部署、等正在跑的那次結束（ops/README.md〈兩站網路拆分上線步驟〉B1 框）"
  echo "  5-2 備份並核對完整，通過才同步（主站 compose 不換）："
  printf '\n%s\n\n' "$SYNC_BLOCK"
  echo "  5-3 恢復自動部署（主站 compose 沒換，不必等後台）：sudo -u deploy rm /srv/fju/test/deploy/auto-deploy.paused"
else
  todo "VM 上 docker network ls 若還沒有 fju-edge-test／fju-edge-prod：同步會把主站 compose 換成拆分版，網路還沒建、Caddy 還沒接之前恢復自動部署會讓下一個新 SHA 部署失敗或測試站 502。所以照下面順序做完搬遷才恢復；今晚只想裝後台就改帶 --keep-site-compose"
  echo "  代號＝ops/README.md〈兩站網路拆分上線步驟〉的框；B3 的 rsync 用下面這段（帶備份核對與 cloudflared.yml 保護），不要用 README 那一行。"
  echo "  5-1 B1 暫停自動部署、等正在跑的那次結束"
  echo "  5-2 B2 記下目前版本 \${SHA}（同一個 shell 裡要記得住）"
  echo "  5-3 備份並核對完整，通過才同步："
  printf '\n%s\n\n' "$SYNC_BLOCK"
  echo "  5-4 關卡：Doppler stg 探針（不印值）——印 REGISTRATION_OPEN：other 才往下，Roy 再到 Doppler 網頁確認值剛好是 true；印 absent／false 就停、改走 --keep-site-compose："
  echo "        sudo -u deploy /srv/fju/app/ops/status-envcheck.sh test --out /tmp/envcheck-test.json"
  echo "        停下來的還原（主站 compose 放回舊版、恢復自動部署；忘了 \$BAK 就 ls -d /srv/fju/app.bak-*）："
  echo "        sudo cp -a \"\${BAK:?}/docker-compose.vm.yml\" \"\${BAK:?}/docker-compose.edge.yml\" /srv/fju/app/ && sudo -u deploy rm /srv/fju/test/deploy/auto-deploy.paused"
  echo "  5-5 B3 建網路：先 sudo timeout 300 bash /srv/fju/app/ops/vm-setup.sh --check 2>&1 | tee /tmp/vm-setup-check.log"
  echo "        輸出沒有任何 ✗ 才跑 sudo timeout 300 bash /srv/fju/app/ops/vm-setup.sh（--check 印 ✗ 時結束碼仍是 0，要用 grep 或眼睛看；方案 B5 有守門版）；有 ✗ 就停、把 /tmp/vm-setup-check.log 交給主腦"
  echo "  5-6 C1a 過渡版 Caddy（三個網路）→ C1b 用 \$SHA 重部署測試站 → C2 確認 app 網路 → C3 三項關卡（印 ✗ 就停在過渡版、暫停檔留著、回報主腦）"
  echo "        到 D 之前自動部署都要維持暫停；中間任何一步 docker ps 看到 fju-test-app 被重建、或它的網路變 fju-edge-test 而 Caddy 還沒接 → 停、回報主腦（還原同 5-4 那行＋過渡版 Caddy up）"
  echo "  5-7 D 最終版 Caddy：Caddy 只接兩個新網路且測試站 200 才刪過渡設定、刪舊網路、恢復自動部署；失敗保留過渡版、印回退指令"
  echo "  5-8 E 驗證兩站互相看不到"
fi

step "6. 安裝開發者後台（第 5 步全部 ✓、自動部署已恢復之後才貼；sudo 問一次密碼，中途點一次 Cloudflare 授權網址）"
printf '\n%s\n\n' "$INSTALL_LINE"
if [ -z "$ACCESS_TEAM" ] || [ -z "$ACCESS_AUD" ]; then
  todo "還沒帶 --access-team／--access-aud：Roy 貼來 team 網域與 AUD 後重跑這支（金鑰沿用、rsync 只補差異）"
fi
echo "  貼之前想先看一遍會做什麼（不用 sudo、不寫任何東西）：在 VM 跑"
echo "    FJU_STATUS_APP_DIR=/srv/fju/app bash /srv/fju/app/ops/status-install.sh --dry-run --access-team … --access-aud … --publish-pubkey '…'"
echo "  第 7b 步（暫時隧道、刪暫時 DNS）在真帳號上沒試過：卡住或非 0 結束時腳本會自己關門（主站不受影響），看 sudo tail /srv/fju/status/.install/exit.log，先回報主腦再決定重貼。"
