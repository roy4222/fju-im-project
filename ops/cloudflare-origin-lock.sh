#!/usr/bin/env bash
# 只讓 Cloudflare 連到這台 VM 的 80／443（切橘雲「之後」才跑）。
#
# 為什麼不用 ufw：Caddy 的 80／443 是 Docker 發布埠，封包走 FORWARD 鏈，不經 ufw 的 INPUT 規則
# （見 ops/vm-setup.sh 的說明），ufw 寫了也擋不到。這支改在 Docker 留給管理員的 DOCKER-USER 鏈
# 第一條 jump 到自建鏈 FJU-CF-ORIGIN（iptables 與 ip6tables 各一）：
#   外網介面進來、tcp、目的埠 80／443、新連線，來源在 Cloudflare 清單 → 放行，其餘 → 丟棄。
# 容器之間、VM 自己對外（Let's Encrypt、GHCR、Doppler）都不經過這條。
#
# 用法：
#   ops/cloudflare-origin-lock.sh              只印偵測結果與將執行的指令（任何人都能跑，不改任何東西）
#   sudo ops/cloudflare-origin-lock.sh --execute   真的套用（可重跑：先清自建鏈再重建），
#                                              並寫 systemd oneshot fju-cf-origin-lock.service 讓重開機後補回
#   sudo ops/cloudflare-origin-lock.sh --release   拿掉 jump 與自建鏈，停用並刪掉單元
#
# 環境變數（測試與特殊網卡用）：
#   FJU_CF_IFACE      外網介面（預設取預設路由的介面）
#   FJU_CF_UNIT_DIR   systemd 單元目錄（預設 /etc/systemd/system）
#
# Cloudflare 範圍清單抓取日期 2026-10-19，來源 https://www.cloudflare.com/ips-v4 與 /ips-v6。
# 與 ops/Caddyfile.vm 的 trusted_proxies 是同一份；更新清單＝兩個檔一起改、重跑 --execute。
set -euo pipefail

CHAIN="FJU-CF-ORIGIN"
UNIT_NAME="fju-cf-origin-lock.service"
UNIT_DIR="${FJU_CF_UNIT_DIR:-/etc/systemd/system}"
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

CF_V4=(
  173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18
  108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17
  162.158.0.0/15 104.16.0.0/13 104.24.0.0/14 172.64.0.0/13 131.0.72.0/22
)
CF_V6=(
  2400:cb00::/32 2606:4700::/32 2803:f800::/32 2405:b500::/32 2405:8100::/32
  2a06:98c0::/29 2c0f:f248::/32
)

MODE=print
case "${1:-}" in
  "") ;;
  --execute) MODE=execute ;;
  --release) MODE=release ;;
  -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
  *) echo "不認得的參數：$1（可用：--execute、--release、--help）" >&2; exit 2 ;;
esac

is_root() { [[ "$(id -u 2>/dev/null || echo 1)" == "0" ]]; }

# 真的要動手：--execute／--release 且是 root。其餘一律只印。
APPLY=0
if [[ "${MODE}" != print ]]; then
  if is_root; then
    APPLY=1
  else
    echo "（不是 root：只印不做。要套用請用 sudo。）"
  fi
fi

IFACE="${FJU_CF_IFACE:-$(ip -4 route show default 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit }}')}"
if [[ -z "${IFACE}" ]]; then
  if [[ "${APPLY}" == 1 ]]; then
    echo "找不到外網介面（預設路由）。請用 FJU_CF_IFACE=<介面名> 指定後重跑。" >&2
    exit 1
  fi
  IFACE="<外網介面>"
fi

# 執行或只印同一份指令序列，所以「只印」看到的就是 --execute 會做的事。
step() {
  if [[ "${APPLY}" == 1 ]]; then
    "$@"
  else
    echo "  + $*"
  fi
}
# 允許失敗的步驟（鏈不存在、規則不存在）。
step_soft() { step "$@" || true; }

detect() {
  echo "== 偵測結果 =="
  echo "iptables 後端：$(iptables -V 2>/dev/null || echo '找不到 iptables（這台不是要套用的 VM）')"
  echo "外網介面：${IFACE}"
  echo "現有 DOCKER-USER 鏈（v4）："
  { iptables -S DOCKER-USER 2>&1 || true; } | sed 's/^/  /'
  if ip6tables -S DOCKER-USER >/dev/null 2>&1; then
    echo "Docker ip6tables：已開（DOCKER-USER 鏈存在於 ip6tables）"
    V6_CHAIN=1
  else
    echo "Docker ip6tables：沒看到 v6 的 DOCKER-USER 鏈（沒開，或不是 root 看不到）"
    V6_CHAIN=0
  fi
  local v6addr
  v6addr="$(ip -6 addr show scope global 2>/dev/null | awk '$1 == "inet6" {print $2}' | paste -sd, -)"
  echo "VM 的全域 v6 位址：${v6addr:-無}"
  if [[ -n "${v6addr}" && "${V6_CHAIN}" == 0 ]]; then
    echo "注意：VM 有公開 v6 但 Docker 的 ip6tables 沒開，v6 流量不會經過 DOCKER-USER。"
    echo "      先在 /etc/docker/daemon.json 開 ip6tables，或拿掉 AAAA 記錄，不能放著不管。"
  fi
  echo
}

lock_family() {
  local ipt="$1"; shift
  local ranges=("$@")
  echo "-- ${ipt} --"
  # 先拿掉舊的 jump，才清得掉自建鏈；再重建。
  step_soft "${ipt}" -D DOCKER-USER -j "${CHAIN}"
  step_soft "${ipt}" -F "${CHAIN}"
  step_soft "${ipt}" -N "${CHAIN}"
  # 不是我們要管的封包一律 RETURN（順序重要：先排除，才輪到來源判斷）。
  step "${ipt}" -A "${CHAIN}" ! -p tcp -j RETURN
  step "${ipt}" -A "${CHAIN}" ! -i "${IFACE}" -j RETURN
  step "${ipt}" -A "${CHAIN}" -p tcp -m multiport ! --dports 80,443 -j RETURN
  step "${ipt}" -A "${CHAIN}" -m conntrack ! --ctstate NEW -j RETURN
  local r
  for r in "${ranges[@]}"; do
    step "${ipt}" -A "${CHAIN}" -s "${r}" -j RETURN
  done
  step "${ipt}" -A "${CHAIN}" -j DROP
  step "${ipt}" -I DOCKER-USER 1 -j "${CHAIN}"
}

unit_text() {
  cat <<UNIT
[Unit]
Description=只讓 Cloudflare 連到 80/443（fju）
After=docker.service
Wants=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=${SELF} --execute

[Install]
WantedBy=multi-user.target
UNIT
}

write_unit() {
  if [[ "${APPLY}" == 1 ]]; then
    mkdir -p "${UNIT_DIR}"
    unit_text > "${UNIT_DIR}/${UNIT_NAME}"
  else
    echo "  + 寫入 ${UNIT_DIR}/${UNIT_NAME}："
    unit_text | sed 's/^/      /'
  fi
}

if [[ "${MODE}" == release ]]; then
  echo "== 解除限制 =="
  for ipt in iptables ip6tables; do
    echo "-- ${ipt} --"
    step_soft "${ipt}" -D DOCKER-USER -j "${CHAIN}"
    step_soft "${ipt}" -F "${CHAIN}"
    step_soft "${ipt}" -X "${CHAIN}"
  done
  step_soft systemctl disable "${UNIT_NAME}"
  if [[ "${APPLY}" == 1 ]]; then rm -f "${UNIT_DIR}/${UNIT_NAME}"; else echo "  + 刪除 ${UNIT_DIR}/${UNIT_NAME}"; fi
  step systemctl daemon-reload
  [[ "${APPLY}" == 1 ]] && echo "已解除。解除期間的憑證續期不算「只讓 Cloudflare 連進來」通過。"
  exit 0
fi

V6_CHAIN=0
detect
echo "== 將執行的指令 =="
lock_family iptables "${CF_V4[@]}"
if [[ "${APPLY}" == 1 && "${V6_CHAIN}" == 0 ]]; then
  echo "-- ip6tables --"
  echo "略過 v6：Docker 的 ip6tables 沒開（沒有 v6 的 DOCKER-USER 鏈）。"
else
  lock_family ip6tables "${CF_V6[@]}"
fi
echo "-- systemd --"
write_unit
step systemctl daemon-reload
step systemctl enable "${UNIT_NAME}"
if [[ "${APPLY}" == 1 ]]; then
  echo "已套用。驗證：sudo iptables -S DOCKER-USER | awk '\$1==\"-A\" && \$2==\"DOCKER-USER\" {print; exit}'"
  echo "預期：-A DOCKER-USER -j ${CHAIN}"
else
  echo
  echo "這是預覽，什麼都沒有執行。要套用：sudo $0 --execute"
fi
