#!/usr/bin/env bash
# SOP 01｜VM 設定（兩站版，2026-09-24；原票 #187 / S14-01）。
#
# 同一台 VM 跑兩站：正式 fju.roy422.dev（Compose project fju-prod）、
# 測試 test.fju.roy422.dev（fju-test），共用一個 Caddy（fju-edge）。
#
# 這支是**冪等**的：重跑不會動到既有資料，已經做過的步驟會印 ✓。
# 由 Roy 在 VM 上以 sudo 執行（agent 沒有 sudo 密碼，也不該有）。逐步說明見 ops/README.md。
#
#   # 只看現況、不改任何東西（先跑這個；零寫入）
#   sudo bash vm-setup.sh --check
#
#   # 實際設定
#   sudo bash vm-setup.sh
#
# 停止條件（SOP 01）：磁碟可用 < 20 GB，或任一步驟 15 分鐘內排不掉 → 停下來記錄。
#
# 這支**會**做：套件（Docker、Doppler CLI、node、ufw）、deploy 帳號、/srv/fju 目錄、
#   ufw、Docker 網路 fju-edge、測試站自動部署的 systemd timer。
# 這支**不會**做（Roy 親自做，見 ops/README.md）：貼 Doppler token、GHCR 登入、
#   放 app 檔、起 Caddy、第一次部署。它只檢查這些有沒有就緒。**它從不讀 token 的內容。**

set -euo pipefail

CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

DEPLOY_USER=deploy
# 容器裡的 app 使用者（web/Dockerfile：`adduser -u 1001 -S nextjs -G nodejs`）。
CONTAINER_UID=1001
CONTAINER_GID=1001
SRV_ROOT=/srv/fju
APP_DIR=$SRV_ROOT/app
SECRETS_DIR=$SRV_ROOT/secrets
SITES=(test prod)
EDGE_NETWORK=fju-edge
MIN_FREE_GB=20
DOMAINS=(fju.roy422.dev test.fju.roy422.dev)
VM_IP=140.136.155.167
# Doppler 官方 apt 來源（https://docs.doppler.com/docs/install-cli）。金鑰指紋尾碼寫死，下載後核對。
DOPPLER_KEY_URL='https://packages.doppler.com/public/cli/gpg.DE2A7741A397C129.key'
DOPPLER_KEY_ID=DE2A7741A397C129
DOPPLER_KEYRING=/usr/share/keyrings/doppler-archive-keyring.gpg
DOPPLER_LIST=/etc/apt/sources.list.d/doppler-cli.list
UNIT_DIR=/etc/systemd/system
TIMER=fju-auto-deploy.timer
SERVICE=fju-auto-deploy.service

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
todo() { printf '  \033[33m→\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# 在 --check 模式下只印出「會做什麼」，不執行。
run() {
  if [ "$CHECK_ONLY" = 1 ]; then
    todo "會執行：$*"
  else
    "$@"
  fi
}

if [ "$(id -u)" -ne 0 ]; then
  echo "要用 sudo 執行：sudo bash $0 ${1:-}" >&2
  exit 1
fi
[ "$CHECK_ONLY" = 1 ] && printf '\033[1m--check：只看不改，這一輪不會寫入任何東西。\033[0m\n'

step "步驟 0：停止條件（磁碟可用 < ${MIN_FREE_GB} GB 就停）"
FREE_KB=$(df -Pk / | awk 'NR==2{print $4}')
FREE_GB=$((FREE_KB / 1024 / 1024))
if [ "$FREE_GB" -lt "$MIN_FREE_GB" ]; then
  bad "根目錄只剩 ${FREE_GB} GB，低於 ${MIN_FREE_GB} GB 門檻 → 依 SOP 01 停止並記錄。"
  exit 2
fi
ok "根目錄可用 ${FREE_GB} GB"
df -h / | sed 's/^/    /'
free -m | sed 's/^/    /'
printf '    nproc: %s\n' "$(nproc)"

step "步驟 1：套件（Docker、Compose、ufw、node、Doppler CLI）"
#
# Docker 只用 Ubuntu 24.04 自己的來源（2026-09-16 review Standards 2）：Ubuntu 裡叫
# `docker-compose-v2`（`docker-compose-plugin` 是 Docker 官方 repo 的名字，乾淨機器會裝不起來）。
# node：deploy.sh 用它跑 ops/check-health.mjs；Ubuntu 的 nodejs 18 就夠（只用 JSON.parse／Date）。
UBUNTU_PACKAGES="docker.io docker-compose-v2 ufw nodejs rsync curl gnupg ca-certificates"
missing_pkgs=()
for pkg in $UBUNTU_PACKAGES; do
  dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q 'install ok installed' || missing_pkgs+=("$pkg")
done
if [ "${#missing_pkgs[@]}" -eq 0 ]; then
  ok "Ubuntu 套件都已安裝"
else
  todo "還沒安裝：${missing_pkgs[*]}"
  run apt-get update
  run apt-get install -y "${missing_pkgs[@]}"
fi
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  ok "$(docker --version)"
  ok "$(docker compose version)"
  # docker-compose.vm.yml 用了 `!reset`，要 Compose 2.24 以上。
  cv=$(docker compose version --short 2>/dev/null | sed 's/^v//')
  if [ -n "$cv" ] && [ "$(printf '%s\n2.24.0\n' "$cv" | sort -V | head -1)" != "2.24.0" ]; then
    bad "Compose $cv 太舊，docker-compose.vm.yml 需要 2.24 以上（apt-get upgrade docker-compose-v2）"
  fi
fi
if [ "$CHECK_ONLY" = 0 ]; then
  systemctl enable --now docker
  ok "docker 服務已啟用"
fi

# Doppler CLI：秘密的唯一來源。這是本腳本**唯一**額外加的 apt 來源——Ubuntu 沒有這個套件，
# 用官方簽章的 apt 來源比「curl | sh」安裝腳本好（升級跟著 apt 走、有簽章驗證）。
if command -v doppler >/dev/null 2>&1; then
  ok "doppler 已安裝：$(doppler --version 2>/dev/null | head -1)"
else
  todo "doppler 尚未安裝（會加官方 apt 來源 packages.doppler.com 並安裝）"
  if [ "$CHECK_ONLY" = 0 ]; then
    if [ ! -s "$DOPPLER_KEYRING" ]; then
      key_tmp=$(mktemp)
      curl -sLf --retry 3 --tlsv1.2 --proto '=https' "$DOPPLER_KEY_URL" -o "$key_tmp"
      gpg --batch --yes --dearmor -o "$DOPPLER_KEYRING" "$key_tmp"
      rm -f "$key_tmp"
    fi
    if ! gpg --batch --show-keys --with-colons "$DOPPLER_KEYRING" 2>/dev/null \
        | awk -F: '$1=="fpr"{print $10}' | grep -q "${DOPPLER_KEY_ID}\$"; then
      bad "Doppler 金鑰指紋對不上 $DOPPLER_KEY_ID，停止（不安裝來路不明的套件）。"
      rm -f "$DOPPLER_KEYRING"
      exit 3
    fi
    echo "deb [signed-by=$DOPPLER_KEYRING] https://packages.doppler.com/public/cli/deb/debian any-version main" \
      > "$DOPPLER_LIST"
    apt-get update
    apt-get install -y doppler
    ok "doppler 已安裝：$(doppler --version 2>/dev/null | head -1)"
  fi
fi

step "步驟 2：部署帳號 ${DEPLOY_USER}（屬於 docker 群組）"
if id "$DEPLOY_USER" >/dev/null 2>&1; then
  ok "${DEPLOY_USER} 已存在"
else
  todo "${DEPLOY_USER} 不存在"
  run useradd --create-home --shell /bin/bash "$DEPLOY_USER"
fi
if id -nG "$DEPLOY_USER" 2>/dev/null | tr ' ' '\n' | grep -qx docker; then
  ok "${DEPLOY_USER} 在 docker 群組"
else
  run usermod -aG docker "$DEPLOY_USER"
fi
# 執行這支腳本的人（Roy）也加進 docker 群組，重新登入後 docker ps 不用 sudo。
if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ]; then
  if id -nG "$SUDO_USER" | tr ' ' '\n' | grep -qx docker; then
    ok "$SUDO_USER 在 docker 群組"
  else
    run usermod -aG docker "$SUDO_USER"
  fi
fi

step "步驟 3：目錄 ${SRV_ROOT}（兩站各一份）"
# 每一列：路徑 擁有者 權限。用 `install -d` 只設定目錄本身，不遞迴——重跑不會動到裡面的檔案。
#   files/     容器裡的 app（1001）寫附件
#   backups/   ops/backup.sh 的 dump（只有 deploy 看得到）
#   deploy/    部署鎖、previous_tag、deploy_log、auto-deploy 的紀錄
#   secrets/   兩把 Doppler token（只有 deploy 看得到）
# 資料庫用 Compose 的 named volume（fju-test-pgdata／fju-prod-pgdata），不在這裡，
# 所以不會碰到 postgres 映像 uid 70 的擁有者問題。
DIR_SPECS=(
  "$SRV_ROOT root:root 755"
  "$APP_DIR $DEPLOY_USER:$DEPLOY_USER 755"
  "$SECRETS_DIR $DEPLOY_USER:$DEPLOY_USER 700"
)
for site in "${SITES[@]}"; do
  DIR_SPECS+=(
    "$SRV_ROOT/$site $DEPLOY_USER:$DEPLOY_USER 755"
    "$SRV_ROOT/$site/files $CONTAINER_UID:$CONTAINER_GID 750"
    "$SRV_ROOT/$site/backups $DEPLOY_USER:$DEPLOY_USER 700"
    "$SRV_ROOT/$site/deploy $DEPLOY_USER:$DEPLOY_USER 700"
  )
done
for spec in "${DIR_SPECS[@]}"; do
  read -r dir owner mode <<<"$spec"
  if [ -d "$dir" ]; then
    now="$(stat -c '%u:%g %a' "$dir")"
    want_uid=$(id -u "${owner%%:*}" 2>/dev/null || echo "${owner%%:*}")
    want_gid=$(getent group "${owner##*:}" | cut -d: -f3 || true)
    [ -n "$want_gid" ] || want_gid="${owner##*:}"
    if [ "$now" = "$want_uid:$want_gid $mode" ]; then
      ok "$dir（$owner $mode）"
      continue
    fi
    todo "$dir 目前是 $now，要改成 $owner $mode"
  else
    todo "$dir 不存在"
  fi
  run install -d -o "${owner%%:*}" -g "${owner##*:}" -m "$mode" "$dir"
done

step "步驟 4：防火牆只開 22（限速）／80／443，全部 TCP"
# 443 只開 TCP：docker-compose.edge.yml 不發布 443/udp，Caddyfile.vm 也關掉了 HTTP/3。
# 注意：Docker 發布的 port 走 FORWARD 鏈、不經過 ufw；真正決定對外開什麼的是 compose 的 ports。
if command -v ufw >/dev/null 2>&1; then
  if [ "$CHECK_ONLY" = 1 ]; then
    ufw status verbose | sed 's/^/    /'
    todo "會執行：ufw limit 22/tcp、ufw allow 80/tcp、ufw allow 443/tcp、ufw --force enable"
  else
    # 先處理 22 再 enable，不會把自己鎖在外面。limit：30 秒內同一 IP 超過 6 次連線就擋。
    ufw limit 22/tcp
    ufw allow 80/tcp
    ufw allow 443/tcp
    ufw --force enable
    ufw status verbose | sed 's/^/    /'
    ok "ufw 已啟用"
  fi
elif [ "$CHECK_ONLY" = 1 ]; then
  todo "ufw 還沒裝（實際執行時步驟 1 會裝），會執行：ufw limit 22/tcp、allow 80/tcp、allow 443/tcp、enable"
else
  bad "ufw 沒裝（步驟 1 應該會裝）"
fi

step "步驟 5：Docker 網路 ${EDGE_NETWORK}（共用 Caddy 找到兩站 app 用）"
if command -v docker >/dev/null 2>&1 && docker network inspect "$EDGE_NETWORK" >/dev/null 2>&1; then
  ok "網路 $EDGE_NETWORK 已存在"
else
  todo "網路 $EDGE_NETWORK 不存在"
  run docker network create "$EDGE_NETWORK"
fi

step "步驟 6：Doppler token（Roy 親自貼；這裡只看存在、權限、擁有者，不讀內容）"
for site in "${SITES[@]}"; do
  f="$SECRETS_DIR/doppler-$site.token"
  config=$([ "$site" = test ] && echo stg || echo prd)
  if [ -f "$f" ]; then
    meta=$(stat -c '%a %U:%G %s' "$f")
    read -r fmode fowner fsize <<<"$meta"
    if [ "$fmode" = 600 ] && [ "$fowner" = "$DEPLOY_USER:$DEPLOY_USER" ] && [ "$fsize" -gt 0 ]; then
      ok "$f（600 $fowner）"
    else
      bad "$f 是 $fmode $fowner、$fsize bytes；要 600、$DEPLOY_USER:$DEPLOY_USER、非空"
    fi
  else
    todo "$f 還沒貼 → ops/README.md 第 5 步（Doppler $config 的唯讀 service token）"
  fi
done

step "步驟 7：GHCR 登入（deploy 拉私有映像用；Roy 親自登入）"
docker_cfg="/home/$DEPLOY_USER/.docker/config.json"
# 只找「有沒有 ghcr.io 這個鍵」，不印檔案內容。
if [ -f "$docker_cfg" ] && grep -q '"ghcr.io"' "$docker_cfg"; then
  ok "deploy 已登入 ghcr.io"
else
  todo "deploy 還沒登入 ghcr.io → ops/README.md 第 6 步（classic PAT，只勾 read:packages）"
fi

step "步驟 8：app 檔案（${APP_DIR}）與 Compose 設定預檢"
APP_FILES=(docker-compose.yml docker-compose.vm.yml docker-compose.edge.yml
  ops/Caddyfile.vm ops/check-health.mjs ops/lib/site.sh
  ops/deploy.sh ops/site.sh ops/backup.sh ops/auto-deploy.sh)
app_ready=1
for f in "${APP_FILES[@]}"; do
  if [ -f "$APP_DIR/$f" ]; then
    ok "$APP_DIR/$f"
  else
    todo "$APP_DIR/$f 還沒放 → ops/README.md 第 4 步"
    app_ready=0
  fi
done
for f in ops/deploy.sh ops/site.sh ops/backup.sh ops/auto-deploy.sh; do
  if [ -f "$APP_DIR/$f" ] && [ ! -x "$APP_DIR/$f" ]; then
    bad "$APP_DIR/$f 不能執行（rsync 應該保留 +x；或 chmod +x）"
  fi
done

# 用**假值**解析兩站與 edge 的設定：`docker compose config` 只讀不寫，所以 --check 也照跑。
# 真秘密絕不拿來跑 config——它會把值印出來。
if [ "$app_ready" = 1 ] && command -v docker >/dev/null 2>&1; then
  fake_env=(
    POSTGRES_USER=fake POSTGRES_PASSWORD=fake POSTGRES_DB=fake
    DATABASE_URL=postgres://fake@postgres/fake DATABASE_URL_OWNER=postgres://fake@postgres/fake
    BETTER_AUTH_SECRET=fake BETTER_AUTH_URL=https://fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake
    FILES_ROOT=/srv/fju/files FILE_MAX_BYTES=1 BUSINESS_CLOCK_OVERRIDE_ENABLED=false
  )
  for site in "${SITES[@]}"; do
    resolved=""
    rc=0
    resolved=$(cd "$APP_DIR" && env -i PATH="$PATH" HOME=/root "${fake_env[@]}" \
      FJU_SITE="$site" COMPOSE_PROJECT_NAME="fju-$site" \
      COMPOSE_FILE="$APP_DIR/docker-compose.yml:$APP_DIR/docker-compose.vm.yml" \
      docker compose config --format json 2>&1) || rc=$?
    if [ "$rc" -ne 0 ]; then
      bad "fju-$site 的 compose 設定解析失敗（exit $rc）："
      printf '%s\n' "$resolved" | sed 's/^/      /' | head -20
      continue
    fi
    if printf '%s' "$resolved" | grep -q '"published"'; then
      bad "fju-$site 有服務對宿主機發布 port——站台 project 不該有，對外只能經過 fju-edge 的 Caddy"
    else
      ok "fju-$site：沒有發布任何 port"
    fi
    if printf '%s' "$resolved" | grep -q "\"name\": \"fju-$site-pgdata\""; then
      ok "fju-$site：資料庫 volume 是 fju-$site-pgdata"
    else
      bad "fju-$site：資料庫 volume 名稱不是 fju-$site-pgdata——兩站可能共用資料庫，停下來檢查"
    fi
  done
  edge=""
  rc=0
  edge=$(cd "$APP_DIR" && docker compose -f docker-compose.edge.yml config --format json 2>&1) || rc=$?
  if [ "$rc" -ne 0 ]; then
    bad "fju-edge 的 compose 設定解析失敗："
    printf '%s\n' "$edge" | sed 's/^/      /' | head -20
  else
    published=$(printf '%s' "$edge" | grep -oE '"published": "[0-9]+"' | grep -oE '[0-9]+' | sort -n | tr '\n' ' ')
    if [ "$published" = "80 443 " ] && ! printf '%s' "$edge" | grep -q '"protocol": "udp"'; then
      ok "fju-edge：只發布 80、443（TCP）"
    else
      bad "fju-edge 發布的是「${published}」（應該只有 80 443 TCP）"
    fi
  fi
fi

step "步驟 9：測試站自動部署（systemd timer，每 2 分鐘看一次 GHCR 的 :main）"
# 只部署 fju-test；正式站永遠手動。暫停：sudo -u deploy touch /srv/fju/test/deploy/auto-deploy.paused
SERVICE_UNIT="[Unit]
Description=FJU 測試站自動部署（GHCR :main 有新映像就部署到 fju-test）
After=docker.service network-online.target
Wants=network-online.target docker.service

[Service]
Type=oneshot
User=$DEPLOY_USER
Group=$DEPLOY_USER
ExecStart=$APP_DIR/ops/auto-deploy.sh
TimeoutStartSec=20min
SyslogIdentifier=fju-auto-deploy
"
TIMER_UNIT="[Unit]
Description=每 2 分鐘檢查一次 FJU 測試站有沒有新映像

[Timer]
OnActiveSec=1min
OnUnitInactiveSec=2min
RandomizedDelaySec=15s

[Install]
WantedBy=timers.target
"
units_changed=0
# install_unit <檔名> <內容>：內容一樣就不動（冪等）；--check 只報告。
install_unit() {
  local unit="$1" content="$2"
  # $(cat) 會吃掉結尾換行，所以兩邊都比「去掉結尾換行」的版本。
  if [ -f "$UNIT_DIR/$unit" ] && [ "$(cat "$UNIT_DIR/$unit")" = "${content%$'\n'}" ]; then
    ok "$UNIT_DIR/$unit 已是最新"
    return 0
  fi
  todo "$UNIT_DIR/$unit 要寫入／更新"
  if [ "$CHECK_ONLY" = 0 ]; then
    printf '%s' "$content" > "$UNIT_DIR/$unit"
    chmod 644 "$UNIT_DIR/$unit"
    units_changed=1
  fi
}
install_unit "$SERVICE" "$SERVICE_UNIT"
install_unit "$TIMER" "$TIMER_UNIT"
if [ "$units_changed" = 1 ]; then
  systemctl daemon-reload
fi
if [ -x "$APP_DIR/ops/auto-deploy.sh" ]; then
  if systemctl is-enabled --quiet "$TIMER" 2>/dev/null && systemctl is-active --quiet "$TIMER" 2>/dev/null; then
    ok "$TIMER 已啟用並在跑"
  else
    todo "$TIMER 還沒啟用"
    run systemctl enable --now "$TIMER"
  fi
  if [ -e "$SRV_ROOT/test/deploy/auto-deploy.paused" ]; then
    todo "自動部署目前是暫停的（$SRV_ROOT/test/deploy/auto-deploy.paused 存在）"
  fi
else
  todo "app 檔還沒放（$APP_DIR/ops/auto-deploy.sh），timer 先不啟用；放好後重跑本腳本"
fi

step "步驟 10：DNS（Roy 在 Cloudflare 做；這裡只驗證）"
for d in "${DOMAINS[@]}"; do
  got=$(getent hosts "$d" 2>/dev/null | awk '{print $1}' | head -1 || true)
  if [ "$got" = "$VM_IP" ]; then
    ok "$d → $got"
  elif [ -n "$got" ]; then
    bad "$d → $got（預期 $VM_IP）"
  else
    todo "$d 還沒有 A 記錄（Cloudflare：type A、僅 DNS、content $VM_IP）"
  fi
done

step "步驟 11：對外連線（Let's Encrypt、GHCR、Google、Doppler 都要通）"
#
# 依 curl 的 exit status 判斷，不要用字串比對（2026-09-16 review Standards 4）。
for url in https://ghcr.io https://accounts.google.com https://acme-v02.api.letsencrypt.org/directory \
           https://api.doppler.com https://packages.doppler.com; do
  if code=$(curl -sS -m 10 -o /dev/null -w '%{http_code}' "$url" 2>/dev/null); then
    if [ "$code" = "000" ]; then bad "$url 連不到（沒有回應）"; else ok "$url → HTTP $code"; fi
  else
    bad "$url 連不到（curl 失敗）"
  fi
done

cat <<'NOTE'

──────────────────────────────────────────────────────────────
接下來照 ops/README.md 的步驟走（貼 token、GHCR 登入、起 Caddy、
第一次部署測試站、再推正式站）。每做完一步可以重跑
    sudo bash /srv/fju/app/ops/vm-setup.sh --check
看哪些 → 變成 ✓。
──────────────────────────────────────────────────────────────
NOTE
