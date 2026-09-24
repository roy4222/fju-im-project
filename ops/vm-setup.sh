#!/usr/bin/env bash
# SOP 01｜VM 首次設定（票 #187 / S14-01）。
#
# 這支是**冪等**的：重跑不會動到既有資料，已經做過的步驟會印「已就緒」。
# 由 Roy 在 VM 上以 sudo 執行（Fable 沒有 sudo 密碼，也不該有）。
#
#   # 只看現況、不改任何東西（先跑這個）
#   sudo bash vm-setup.sh --check
#
#   # 實際設定
#   sudo bash vm-setup.sh
#
# 停止條件（SOP 01）：磁碟可用 < 20 GB，或任一步驟 15 分鐘內排不掉 → 停下來記錄。
# 本腳本自己會在磁碟不足時直接中止。
#
# 不在本腳本範圍：
#   - 三份 .env 的值、GHCR 登入、Google／Turnstile（SOP 02 / #188）
#   - app 與 worker 啟動、第一次真部署（SOP 03 / #189）
#   - DNS 三筆 A 記錄（Roy 在 Cloudflare dashboard 做；本腳本只驗證）

set -euo pipefail

CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

DEPLOY_USER=deploy
# 容器裡的 app 使用者（web/Dockerfile：`adduser -u 1001 -S nextjs -G nodejs`）。
CONTAINER_UID=1001
CONTAINER_GID=1001
SRV_ROOT=/srv/fju
SRV_DIRS=(files tmp backups postgres app branches)
MIN_FREE_GB=20
DOMAINS=(fju.roy422.dev b1.fju.roy422.dev b2.fju.roy422.dev)
VM_IP=140.136.155.167

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

step "步驟 1：Docker 與 ufw"
#
# 套件來源只用 Ubuntu 24.04 自己的（2026-09-16 review Standards 2）。
# 原本寫 `docker.io docker-compose-plugin`，但 `docker-compose-plugin` 是 **Docker 官方 repo**
# 的套件名，Ubuntu 的來源裡叫 `docker-compose-v2`——乾淨的機器會在這一步直接失敗。
# 兩種做法都可行，這裡選「單一來源」：不額外加 repo、不引入 GPG 金鑰管理，升級跟著系統走。
# 若日後需要 Docker 官方的新版，改成官方安裝程序時要**整組**換（repo＋金鑰＋五個套件名）。
DOCKER_PACKAGES="docker.io docker-compose-v2 ufw"
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  ok "docker 已安裝：$(docker --version)"
  ok "compose plugin：$(docker compose version)"
else
  todo "docker 或 compose plugin 尚未安裝（將安裝：$DOCKER_PACKAGES）"
  run apt-get update
  # shellcheck disable=SC2086
  run apt-get install -y $DOCKER_PACKAGES
fi
if [ "$CHECK_ONLY" = 0 ]; then
  systemctl enable --now docker
  ok "docker 服務已啟用"
fi

step "步驟 2：部署帳號 ${DEPLOY_USER}（屬於 docker 群組）"
if id "$DEPLOY_USER" >/dev/null 2>&1; then
  ok "${DEPLOY_USER} 已存在"
else
  todo "${DEPLOY_USER} 不存在"
  run useradd --create-home --shell /bin/bash "$DEPLOY_USER"
fi
if [ "$CHECK_ONLY" = 0 ]; then
  usermod -aG docker "$DEPLOY_USER"
  # 執行這支腳本的人（Roy）也加進 docker 群組，重新登入後 docker ps 不用 sudo。
  [ -n "${SUDO_USER:-}" ] && usermod -aG docker "$SUDO_USER"
  install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"
  touch "/home/$DEPLOY_USER/.ssh/authorized_keys"
  chown "$DEPLOY_USER:$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh/authorized_keys"
  chmod 600 "/home/$DEPLOY_USER/.ssh/authorized_keys"
  ok "${DEPLOY_USER} 在 docker 群組，~/.ssh/authorized_keys 已就位（公鑰由 Roy 貼上）"
fi
if [ ! -s "/home/$DEPLOY_USER/.ssh/authorized_keys" ] 2>/dev/null; then
  todo "待 Roy：把部署用公鑰貼進 /home/${DEPLOY_USER}/.ssh/authorized_keys（SOP 02 §3.6）"
fi

step "步驟 3：目錄 ${SRV_ROOT}"
for dir in "${SRV_DIRS[@]}"; do
  if [ -d "$SRV_ROOT/$dir" ]; then
    ok "$SRV_ROOT/$dir 已存在"
  else
    todo "$SRV_ROOT/$dir 不存在"
    run mkdir -p "$SRV_ROOT/$dir"
  fi
done
# 擁有者分兩種，不能一把 `chown -R` 掃掉整個 $SRV_ROOT：
#   - files／tmp／postgres：容器裡的 app 寫進去的，給 CONTAINER_UID（web/Dockerfile 的 1001）。
#   - app／backups／branches：deploy 用 SSH 放檔與跑 deploy.sh，給 deploy。
# app/ 裡有 mode-600 的 .env／.env.migrate／.env.backup。之前整包 chown 成 1000:1000 會把
# 這些秘密檔改成別人的，重跑一次腳本就讓 deploy 讀不到自己的秘密（腳本是冪等的，會重跑）。
for dir in "${SRV_DIRS[@]}"; do
  case "$dir" in
    files|tmp|postgres) owner="$CONTAINER_UID:$CONTAINER_GID" ;;
    *)                  owner="$DEPLOY_USER:$DEPLOY_USER" ;;
  esac
  run chown -R "$owner" "$SRV_ROOT/$dir"
done
[ "$CHECK_ONLY" = 0 ] && ls -ld "$SRV_ROOT"/* | sed 's/^/    /'

step "步驟 4：防火牆只開 22 / 80 / 443"
if command -v ufw >/dev/null 2>&1; then
  if [ "$CHECK_ONLY" = 1 ]; then
    ufw status | sed 's/^/    /'
    todo "會執行：ufw allow 22,80,443/tcp 並 ufw --force enable"
  else
    ufw allow 22/tcp
    ufw allow 80/tcp
    ufw allow 443/tcp
    ufw --force enable
    ufw status | sed 's/^/    /'
    ok "ufw 已啟用"
  fi
else
  bad "ufw 沒裝（步驟 1 應該會裝）"
fi

step "步驟 5：三份 .env（SOP 02 / #188，本腳本只檢查存在與權限）"
for f in .env .env.migrate .env.backup; do
  path="$SRV_ROOT/app/$f"
  if [ -f "$path" ]; then
    mode=$(stat -c '%a %U:%G' "$path")
    if [ "${mode%% *}" = "600" ]; then ok "$path（$mode）"; else bad "$path 權限是 $mode，應該是 600"; fi
  else
    todo "$path 還沒建立 → SOP 02 / #188"
  fi
done

step "步驟 6：Compose 與 Caddy 設定檔"
for f in docker-compose.yml docker-compose.vm.yml Caddyfile deploy.sh; do
  if [ -f "$SRV_ROOT/app/$f" ]; then ok "$SRV_ROOT/app/$f"; else todo "$SRV_ROOT/app/$f 還沒放（見下方「Roy 要做的事」）"; fi
done
[ -x "$SRV_ROOT/app/deploy.sh" ] && ok "deploy.sh 可執行" || todo "deploy.sh 還要 chmod +x"

# 驗「帶上 VM 覆蓋檔之後，80／443 真的有被發布」。
#
# 這件事要在 .env 還沒建立時就驗得出來：本腳本（SOP 01）跑完才輪到 SOP 02／#188 填秘密，
# 而 `docker compose config` 會去讀 app／migrate／backup 的 `env_file`，檔案不存在就整個失敗。
# 所以複製兩份 compose 到暫存目錄、補上「空的」佔位 env 檔再解析——只是要看 ports 合併結果，
# 不需要任何真實值，也不會碰到 $SRV_ROOT/app 裡既有的秘密檔。
#
# **這個預檢不能代替正式目錄的 config／up**：那兩個會讀真正的 env_file，所以仍然要等
# SOP 02／#188 把三份 .env 建好（見步驟 5 與下方「接下來 Roy 要做的事」第 5 點）。
if [ -f "$SRV_ROOT/app/docker-compose.yml" ] && [ -f "$SRV_ROOT/app/docker-compose.vm.yml" ] \
   && command -v docker >/dev/null 2>&1; then
  probe=$(mktemp -d)
  cp "$SRV_ROOT/app/docker-compose.yml" "$SRV_ROOT/app/docker-compose.vm.yml" "$probe/"
  : > "$probe/.env"; : > "$probe/.env.migrate"; : > "$probe/.env.backup"
  resolved=""
  config_rc=0
  resolved=$(cd "$probe" \
    && docker compose -f docker-compose.yml -f docker-compose.vm.yml config 2>&1) || config_rc=$?
  rm -rf "$probe"
  if [ "$config_rc" -ne 0 ]; then
    # 解析本身失敗（compose 檔語法壞掉、docker daemon 不在……），不是「port 沒開」。
    bad "docker compose config 解析失敗（exit $config_rc），先看這個錯誤："
    printf '%s\n' "$resolved" | sed 's/^/      /' | head -20
  else
    published=$(printf '%s\n' "$resolved" \
      | grep -cE "published: *\"?(80|443)\"?$" || true)
    if [ "${published:-0}" -ge 2 ]; then
      ok "resolved config 有發布 80 與 443（HTTPS 走得通）"
    else
      bad "resolved config 沒有同時發布 80 與 443——Caddy 拿不到憑證。檢查 docker-compose.vm.yml 有沒有被帶上"
    fi
  fi
fi

step "步驟 7：DNS（Roy 在 Cloudflare 做；這裡只驗證）"
for d in "${DOMAINS[@]}"; do
  got=$(getent hosts "$d" 2>/dev/null | awk '{print $1}' | head -1 || true)
  if [ "$got" = "$VM_IP" ]; then
    ok "$d → $got"
  elif [ -n "$got" ]; then
    bad "$d → $got（預期 $VM_IP）"
  else
    todo "$d 還沒有 A 記錄 → 前置清單 §3.1（type A、灰雲、content $VM_IP）"
  fi
done

step "步驟 8：對外連線（Let's Encrypt 與 GHCR 都要通）"
#
# 依 curl 的 exit status 判斷，不要用字串比對（2026-09-16 review Standards 4）。
# 原本失敗時 `-w` 會輸出 `000`、再接 `echo FAIL` 變成 `000FAIL`，兩個失敗條件都不等於它，
# 於是連不到也印成 OK。這裡先看 exit code，再看 HTTP 狀態。
for url in https://ghcr.io https://accounts.google.com https://acme-v02.api.letsencrypt.org/directory; do
  if code=$(curl -sS -m 10 -o /dev/null -w '%{http_code}' "$url" 2>/dev/null); then
    if [ "$code" = "000" ]; then bad "$url 連不到（沒有回應）"; else ok "$url → HTTP $code"; fi
  else
    bad "$url 連不到（curl 失敗）"
  fi
done

cat <<'NOTE'

──────────────────────────────────────────────────────────────
接下來 Roy 要做的事（本腳本不做，也做不到）
──────────────────────────────────────────────────────────────
1. 如果剛剛第一次把自己加進 docker 群組：登出再登入，然後確認
      docker ps            # 不需要 sudo
2. Cloudflare 加三筆 A 記錄（灰雲、TTL auto、content 140.136.155.167）：
      fju / b1 / b2        # 前置清單 §3.1
3. 向校方申請對這台機器開放 Internet 端的 80 與 443（HTTP-01 簽憑證要用）。
4. 把 repo 的檔案放到 /srv/fju/app/（在自己的機器上執行）：
      scp docker-compose.yml docker-compose.vm.yml ops/Caddyfile.vm ops/deploy.sh \
          <你>@140.136.155.167:/tmp/
      sudo install -o deploy -g deploy -m 644 /tmp/docker-compose.yml    /srv/fju/app/docker-compose.yml
      sudo install -o deploy -g deploy -m 644 /tmp/docker-compose.vm.yml /srv/fju/app/docker-compose.vm.yml
      sudo install -o deploy -g deploy -m 644 /tmp/Caddyfile.vm          /srv/fju/app/Caddyfile
      sudo install -o deploy -g deploy -m 755 /tmp/deploy.sh             /srv/fju/app/deploy.sh
5. 三份 .env 的值（SOP 02 / #188）——秘密只在 VM 上輸入，不經聊天、issue、repo。

   ⛔ 這是第 6 步的「前置」，不是可以晚點補的東西。/srv/fju/app 裡的每一個
      docker compose 指令（config 也算）都會先解析所有服務的 env_file：
      app/worker 的 .env、migrate 的 .env.migrate、backup 的 .env.backup。
      少一份就整個指令失敗，--no-deps 也擋不住（它只決定啟動哪些服務，
      不影響設定檔怎麼解析）。.env 還身兼 Compose 的變數插值來源。
      重跑 `vm-setup.sh --check`，步驟 5 三行全 ✓ 再往下。

6. 起資料庫與 Caddy，確認三個網域都拿到憑證：
      cd /srv/fju/app
      # 先看 resolved config：caddy 必須同時發布 80 與 443，不然憑證簽不下來
      sudo -u deploy docker compose -f docker-compose.yml -f docker-compose.vm.yml config \
        | grep -A6 "^  caddy:"
      # --no-deps：這一步只要基礎設施，不要 depends_on 把 app／migrate 一起拉起來
      #（映像與 migration 是 SOP 03 / #189 的事）
      sudo -u deploy docker compose -f docker-compose.yml -f docker-compose.vm.yml \
        up -d --no-deps postgres caddy
      sudo -u deploy docker compose -f docker-compose.yml -f docker-compose.vm.yml \
        logs caddy | grep -i "certificate obtained"
   預期：resolved config 裡看得到 80:80 與 443:443；三個網域各出現一行 certificate obtained。
   如果看到 `env file /srv/fju/app/.env not found`，那是第 5 步還沒做完，
   不是校方 port 沒開——兩者不要混為一談。
7. 把上面每一段輸出貼進 steps/S14/S14-01/ 與 SOP 01 的執行紀錄表。
NOTE
