#!/usr/bin/env bash
# 測試站自動部署（2026-09-24）。由 systemd timer（fju-auto-deploy.timer，vm-setup.sh 安裝）
# 每 2 分鐘以 deploy 身分執行一次；也可以手動跑：sudo -u deploy /srv/fju/app/ops/auto-deploy.sh
#
# 做法：VM 自己去 GHCR 看 `ghcr.io/roy4222/fju-web:main`（image.yml 每次 main 合併後推的）。
#   - 對應的 commit SHA 跟上一次處理過的一樣 → 什麼都不做
#   - 有新的 SHA → 呼叫 ops/deploy.sh --site test <SHA> --execute（失敗會照 deploy.sh 自動回滾）
# GitHub 上不放任何 VM 的 SSH 金鑰；拉映像用 deploy 使用者既有的 GHCR 唯讀登入。
#
# **只會部署測試站。** 正式站 fju-prod 只能由人手動指定 tag 部署，這支腳本沒有任何參數能改站台。
#
# 什麼時候不動作（都 exit 0）：
#   - 暫停檔存在：/srv/fju/test/deploy/auto-deploy.paused（touch 就暫停、rm 就恢復）
#   - 測試站的 Doppler token 還沒貼
#   - 測試站還沒有**手動**成功部署過一次（第一次部署要人看著跑，見 ops/README.md）
#   - 上一輪還在跑（自己的鎖；systemd 本身也不會重疊啟動同一個 oneshot 服務）
#
# 失敗的 SHA 不會每 2 分鐘重試（避免一直重啟測試站）：同一個 SHA 只試一次，
# 下一次 main 有新映像才會再動。要重試同一個 SHA：rm /srv/fju/test/deploy/auto-deploy.last
# 紀錄：journalctl -u fju-auto-deploy.service，以及 /srv/fju/test/deploy/auto-deploy.log。
set -euo pipefail

APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_ROOT"
# shellcheck source-path=SCRIPTDIR source=lib/site.sh
. "$APP_ROOT/ops/lib/site.sh"

# 在 mkdir／鎖檔／寫紀錄之前擋掉非 deploy 身分（見 ops/lib/site.sh）。
require_deploy_user "$APP_ROOT/ops/auto-deploy.sh"

# 固定測試站，不接受參數。
site_setup test "$APP_ROOT"

IMAGE_REPO="${IMAGE_REPO:-ghcr.io/roy4222/fju-web}"
CHANNEL_TAG="${AUTO_DEPLOY_CHANNEL_TAG:-main}"
STATE_DIR="${DEPLOY_DIR:-$SITE_ROOT/deploy}"
PAUSE_FILE="$STATE_DIR/auto-deploy.paused"
LAST_FILE="$STATE_DIR/auto-deploy.last"
AUTO_LOG="$STATE_DIR/auto-deploy.log"
DEPLOY_LOG="$STATE_DIR/deploy_log"

say() { printf '[auto-deploy] %s\n' "$*"; }
record() { printf '%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$1" "$2" >> "$AUTO_LOG"; }

if [ -e "$PAUSE_FILE" ]; then
  say "暫停中（$PAUSE_FILE 存在），不檢查。"
  exit 0
fi
if [ ! -f "$SITE_TOKEN_FILE" ]; then
  say "測試站的 Doppler token 還沒貼（${SITE_TOKEN_FILE}），略過。"
  exit 0
fi
if ! grep -qE $'\t(deployed|rolled-back)\t' "$DEPLOY_LOG" 2>/dev/null; then
  say "測試站還沒有手動成功部署過（$DEPLOY_LOG 沒有 deployed 紀錄）；第一次請手動部署，之後才自動。"
  exit 0
fi

mkdir -p "$STATE_DIR"
exec 8>"$STATE_DIR/auto-deploy.lock"
if ! flock --nonblock 8; then
  say "上一輪還在跑，這輪略過。"
  exit 0
fi

# 只拉 manifest 有變的層；沒變時幾乎不花流量。
if ! docker pull --quiet "$IMAGE_REPO:$CHANNEL_TAG" >/dev/null; then
  say "拉不到 $IMAGE_REPO:${CHANNEL_TAG}（GHCR 登入過期或網路問題？）。"
  record pull-failed "$CHANNEL_TAG"
  exit 1
fi

# 這個映像是哪個 commit：先看 OCI label（image.yml 設的），沒有再看烤進去的 GIT_COMMIT。
sha="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
  "$IMAGE_REPO:$CHANNEL_TAG" 2>/dev/null || true)"
if ! printf '%s' "$sha" | grep -Eq '^[0-9a-f]{40}$'; then
  sha="$(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$IMAGE_REPO:$CHANNEL_TAG" \
    | sed -n 's/^GIT_COMMIT=//p' | head -1)"
fi
if ! printf '%s' "$sha" | grep -Eq '^[0-9a-f]{40}$'; then
  say "讀不出 $IMAGE_REPO:$CHANNEL_TAG 的 commit SHA，不部署。"
  record unknown-sha "$CHANNEL_TAG"
  exit 1
fi

last="$(cat "$LAST_FILE" 2>/dev/null || true)"
if [ "$sha" = "$last" ]; then
  say "已是最新（${sha}），不動作。"
  exit 0
fi

running="$(docker inspect --format '{{.Config.Image}}' "fju-test-app" 2>/dev/null || true)"
if [ "$running" = "$IMAGE_REPO:$sha" ]; then
  say "測試站已經在跑 ${sha}，只更新紀錄。"
  printf '%s\n' "$sha" > "$LAST_FILE"
  exit 0
fi

say "main 有新映像：${sha}（測試站目前：${running:-沒有在跑}），開始部署到 fju-test。"
extra=()
[ "${AUTO_DEPLOY_EXPECT_WORKER:-0}" = 1 ] && extra+=(--expect-worker)

rc=0
"$APP_ROOT/ops/deploy.sh" --site test "$sha" --execute ${extra[@]+"${extra[@]}"} || rc=$?

if [ "$rc" = 75 ]; then
  # 部署鎖被佔住（有人正在手動部署測試站）：這個 SHA 下一輪再試。
  say "測試站有另一次部署正在跑，$sha 下一輪再試。"
  record busy "$sha"
  exit 0
fi

# 成功或失敗都記下這個 SHA：失敗的版本不自動重試，等下一次 main 有新映像。
printf '%s\n' "$sha" > "$LAST_FILE"
if [ "$rc" = 0 ]; then
  say "部署成功：$sha"
  record deployed "$sha"
else
  say "部署失敗（exit ${rc}）：${sha}。deploy.sh 已依 previous_tag 回滾，細節看 ${DEPLOY_LOG}。"
  record failed "$sha"
fi
exit "$rc"
