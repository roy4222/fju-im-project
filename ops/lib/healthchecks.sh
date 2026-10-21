#!/usr/bin/env bash
# Healthchecks.io 打卡（⑤-06）：給 ops/auto-deploy.sh、ops/backup-daily.sh source 用。
#
#   hc_ping <url-file> [start|fail] [body]
#
# - <url-file>：一行 ping 網址（例如 /srv/fju/secrets/healthchecks-deploy.url，deploy 擁有、600）。
#   網址等同密碼：只從檔案讀、不印出來、不放進指令列（經 stdin 的 curl 設定檔交給 curl）。
# - 檔案不存在或是空的 → 什麼都不做（不呼叫 curl）、回 0。本機、CI、還沒設定的站都走這條。
# - 第二個參數：start → 打 <網址>/start；fail → 打 <網址>/fail；省略或空字串 → 打 <網址>（成功）。
# - body：有給就用 POST 帶上去（Healthchecks.io 會把它顯示在事件與 Discord 通知裡），例如「磁碟 85%」。
# - curl 失敗（網路、Healthchecks.io 掛了）只印一行，**一律回 0**，不改呼叫端的結果。

hc_ping() {
  local file="$1" kind="${2:-}" body="${3:-}" url label
  if [ ! -e "$file" ]; then
    return 0
  fi
  if [ ! -r "$file" ]; then
    printf '[healthchecks] 讀不到 %s（權限？），這次不打卡。\n' "$file"
    return 0
  fi
  url="$(head -n 1 "$file" | tr -d '[:space:]')"
  [ -n "$url" ] || return 0
  case "$kind" in
    start) url="$url/start"; label="開始" ;;
    fail) url="$url/fail"; label="失敗" ;;
    '') label="成功" ;;
    *) printf '[healthchecks] 不認得的打卡種類：%s（只能是 start 或 fail）\n' "$kind"; return 0 ;;
  esac
  local args=(-fsS -m 10 --retry 3 -o /dev/null)
  [ -z "$body" ] || args+=(--data-raw "$body")
  # 網址不進指令列（`ps` 看得到，--retry 時會留好幾十秒）：用 curl 設定檔從 stdin 交進去（-K -）。
  # 設定檔的雙引號字串裡 \ 與 " 前面要加 \（用 sed，不靠各版 bash 不一致的 ${//} 替換規則）。
  local quoted
  quoted="$(printf '%s' "$url" | sed -e 's/[\\"]/\\&/g')"
  if printf 'url = "%s"\n' "$quoted" | curl -K - "${args[@]}" 2>/dev/null; then
    printf '[healthchecks] ping 已送（%s）\n' "$label"
  else
    printf '[healthchecks] ping 沒送出（%s；curl 失敗），不影響本次結果。\n' "$label"
  fi
  return 0
}
