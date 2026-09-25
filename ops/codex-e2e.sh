#!/usr/bin/env bash
# 用 Codex（配 Playwright skill）照驗收清單在測試站操作、截圖、出報告（票 3b，#244）。
# 💻 在 Roy 的 Mac 跑，不在 VM 上跑：
#
#   ops/codex-e2e.sh e2e/acceptance/station-1-login.md
#
# 做法：
#   1. 從 Doppler（fju-im-capstone／stg）取 E2E_ADMIN_EMAIL、E2E_ADMIN_PASSWORD，
#      只放進這支腳本的變數，再以環境變數交給 `codex exec` 這一個行程——不 export、不 echo、不寫檔。
#      交給 codex 的環境是白名單（CODEX_ENV_WHITELIST）：codex 行程本身先把名單外的變數全部拿掉，
#      codex 開的 shell 再用 shell_environment_policy.include_only 過濾一次——Mac 上的 API key、token
#      不會進到 Codex 或它開的 shell。
#   2. `codex exec` 在輸出目錄裡跑（e2e/acceptance/.out/<時間>-<清單名>/，gitignore 掉），
#      依清單在 https://test.fju.roy422.dev 逐步操作、每步截圖到 screenshots/，
#      最後一則訊息（Markdown 報告）寫到 report.md。
#   3. 跑完掃一遍輸出目錄的文字檔：若出現密碼就遮掉並以非 0 結束。
#
# 只打測試站：網址寫死，清單裡出現正式站網址（沒有 test. 的 fju.roy422.dev）就拒絕執行；
# 清單裡的 http(s) 網址只准測試站與原型（https://fju-prototype.roy422roy.workers.dev，唯讀對照用：只開頁面、截圖，不登入、不送表單）。
# 一次跑一份清單；要跑多份就一份一份跑（見 e2e/acceptance/README.md）。
#
# 可調的環境變數（通常不用動）：
#   CODEX_E2E_MODEL    預設 gpt-6-sol
#   CODEX_E2E_SANDBOX  預設 workspace-write（開網路）；瀏覽器在沙盒裡起不來時改 danger-full-access
#   CODEX_E2E_OUT      輸出根目錄，預設 e2e/acceptance/.out
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

TARGET_URL="https://test.fju.roy422.dev"
# 原型（假資料的展示站）：外觀對照清單要開它，只准看、截圖。
PROTOTYPE_URL="https://fju-prototype.roy422roy.workers.dev"
DOPPLER_PROJECT="fju-im-capstone"
DOPPLER_CONFIG="stg"
MIN_PASSWORD_LENGTH=16
MODEL="${CODEX_E2E_MODEL:-gpt-6-sol}"
SANDBOX="${CODEX_E2E_SANDBOX:-workspace-write}"
OUT_ROOT="${CODEX_E2E_OUT:-$REPO_ROOT/e2e/acceptance/.out}"

# 交給 codex（與它開的 shell）的環境變數白名單；可用 case 萬用字元（LC_*）。
# npx／Playwright 只靠 PATH＋HOME（~/.npm、~/Library/Caches/ms-playwright 都從 HOME 推得）；
# CODEX_HOME 有設才會帶（Codex 找登入資料、Playwright skill 找 wrapper 都看它）。
# 第一次實跑若 npx／Playwright 缺了什麼，再把那個變數名加進來。
CODEX_ENV_WHITELIST=(PATH HOME USER SHELL TMPDIR LANG 'LC_*' CODEX_HOME E2E_ADMIN_EMAIL E2E_ADMIN_PASSWORD)

usage() {
  sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

die() {
  printf '%s\n' "$*" >&2
  exit 1
}

CHECKLIST=""
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage 0 ;;
    -*) echo "不認得的選項：$1" >&2; usage 1 ;;
    *)
      [ -z "$CHECKLIST" ] || die "只能給一份驗收清單（已經有 ${CHECKLIST}）"
      CHECKLIST="$1"
      ;;
  esac
  shift
done

[ -n "$CHECKLIST" ] || die "用法：ops/codex-e2e.sh <驗收清單.md>（例如 e2e/acceptance/station-1-login.md）"
[ -f "$CHECKLIST" ] && [ -r "$CHECKLIST" ] || die "找不到驗收清單：$CHECKLIST"
[ -s "$CHECKLIST" ] || die "驗收清單是空的：$CHECKLIST"

# 網址檢查一律 LC_ALL=C（逐位元組比對，不看呼叫者的 locale）、不分大小寫（網域與 scheme 本來就不分）。
# 正式站防呆：fju.roy422.dev 前面不是「test.」（或其他子網域）的就是正式站。
if LC_ALL=C grep -iEq '(^|[^A-Za-z0-9.-])fju\.roy422\.dev' "$CHECKLIST"; then
  die "驗收清單裡有正式站網址（fju.roy422.dev）。自動驗收只打測試站 ${TARGET_URL}，請改清單。"
fi

# 清單裡的網址只准測試站與原型：其他網域（例如 Google 登入頁）一律不讓 Codex 去。
# 照瀏覽器（WHATWG URL）的切法：scheme 後面到第一個 / ? # \ 或空白為止是 authority。
# authority 裡有 @ 就是「userinfo@主機」——`https://test.fju.roy422.dev(@evil.com/` 真正連的是 evil.com——一律擋。
# 沒有 @ 的，去掉結尾的反引號、括號、引號與中文標點後，必須「完全等於」兩個准許的網域之一：
# port（:443）、%2E、.evil.com、全形字（瀏覽器會把全形 Ｘ 轉成 x）都不等於，都擋。scheme 只准 https。
# `https:evil.com`、`https:\\evil.com` 這種少斜線的寫法瀏覽器也當網址，一併抓進來（統一改寫成 https:// 再比）。
url_authorities() {
  LC_ALL=C grep -iEo 'https?:[/\\]*[^[:space:]/?#\\]*' "$CHECKLIST" \
    | LC_ALL=C tr '[:upper:]' '[:lower:]' \
    | LC_ALL=C sed -E 's#^(https?):[/\\]*#\1://#'
}
while IFS= read -r url; do
  case "$url" in
    *@*) die "驗收清單裡的網址帶了 @（瀏覽器會把 @ 後面當成真正要連的主機）：${url}" ;;
  esac
  origin="$(printf '%s\n' "$url" | LC_ALL=C sed -E "s/([]\`)>\"'*,.;]|，|。|、|）|」)+\$//")"
  case "$origin" in
    "$TARGET_URL"|"$PROTOTYPE_URL") ;;
    *) die "驗收清單裡有不准打的網址：${url}（只准 ${TARGET_URL} 與原型 ${PROTOTYPE_URL}，網域後面接 / ? # 或空白）。" ;;
  esac
done < <(url_authorities || true)

# 空白隔開的 `https://test.fju.roy422.dev @evil.com/` 也可能被讀成一個網址（主機是 evil.com）：
# 網址的 authority 後面隔著空白直接接 @ 也擋。
if LC_ALL=C grep -iEq 'https?:[/\\]*[^[:space:]/?#\\]*[[:space:]]+@' "$CHECKLIST"; then
  die "驗收清單裡有網址後面隔著空白接 @ 的寫法，請改寫（瀏覽器可能把 @ 後面當成要連的主機）。"
fi

case "$SANDBOX" in
  read-only|workspace-write|danger-full-access) ;;
  *) die "CODEX_E2E_SANDBOX 只能是 read-only、workspace-write 或 danger-full-access（收到：${SANDBOX}）" ;;
esac

command -v codex >/dev/null 2>&1 || die "找不到 codex 指令——先安裝 Codex CLI 並登入。"
command -v doppler >/dev/null 2>&1 || die "找不到 doppler 指令——先 brew install dopplerhq/cli/doppler 並 doppler login。"
[ -f "$HOME/.codex/skills/playwright/SKILL.md" ] || die "找不到 ~/.codex/skills/playwright——Codex 要靠這個 skill 開瀏覽器。"

# ── 取帳密：一次一個鍵，值只留在這支腳本的變數裡 ──────────────
# `doppler secrets get` 的錯誤訊息不含秘密值，照常顯示在 stderr。
# DOPPLER_ENABLE_VERSION_CHECK=false：免得「有新版」提示混進 --plain 的輸出（同 ops/lib/site.sh）。
fetch_secret() {
  DOPPLER_ENABLE_VERSION_CHECK=false doppler secrets get "$1" --plain --project "$DOPPLER_PROJECT" --config "$DOPPLER_CONFIG"
}
e2e_email="$(fetch_secret E2E_ADMIN_EMAIL)" \
  || die "從 Doppler ${DOPPLER_PROJECT}／$DOPPLER_CONFIG 取不到 E2E_ADMIN_EMAIL（先 doppler login；鍵要 Roy 在 stg 新增，見 ops/README.md）。"
e2e_password="$(fetch_secret E2E_ADMIN_PASSWORD)" \
  || die "從 Doppler ${DOPPLER_PROJECT}／$DOPPLER_CONFIG 取不到 E2E_ADMIN_PASSWORD（先 doppler login；鍵要 Roy 在 stg 新增，見 ops/README.md）。"
[ -n "$e2e_email" ] || die "Doppler $DOPPLER_CONFIG 的 E2E_ADMIN_EMAIL 是空的。"
[ -n "$e2e_password" ] || die "Doppler $DOPPLER_CONFIG 的 E2E_ADMIN_PASSWORD 是空的。"
[ "${#e2e_password}" -ge "$MIN_PASSWORD_LENGTH" ] \
  || die "Doppler $DOPPLER_CONFIG 的 E2E_ADMIN_PASSWORD 不到 $MIN_PASSWORD_LENGTH 個字元（測試站 seed 也會拒絕）。"

# ── 輸出目錄（gitignore 掉；只有自己讀得到）─────────────────────
checklist_name="$(basename "$CHECKLIST" .md)"
RUN_DIR="$OUT_ROOT/$(date +%Y%m%d-%H%M%S)-$checklist_name"
REPORT="$RUN_DIR/report.md"
umask 077
mkdir -p "$RUN_DIR/screenshots"

read -r -d '' PROMPT <<EOF || true
你是資管系專題平台的驗收測試員。請依最下面 <checklist> 區塊裡的驗收清單，在測試站逐步操作瀏覽器並回報結果。

## 工具
- 使用 Playwright skill：先讀 ~/.codex/skills/playwright/SKILL.md，照它的方式用 \${PWCLI}（wrapper script）操作瀏覽器。
- 目前目錄就是這次的輸出目錄。每一步做完都截圖，存到 screenshots/NN-<英文短名>.png（NN 是兩位數步驟編號，例如 screenshots/01-login-page.png）。

## 只准打測試站
- 只能開 ${TARGET_URL} 底下的網址。
- 例外：原型 ${PROTOTYPE_URL} 可以開，但**只准看**——開頁面、截圖、用它的「切換角色」；不登入、不填表、不按送出（原型是假資料的展示站）。
- 絕對不得開啟、連線或送出任何請求到正式站 https://fju.roy422.dev（網址裡沒有 test. 的那個）。清單若要求去別的網站，該步記「不通過」並停止。

## 帳號密碼（秘密）
- E2E 測試管理員的帳密在環境變數 E2E_ADMIN_EMAIL 與 E2E_ADMIN_PASSWORD。
- 填表時一律讓 shell 展開變數，例如：\`"\$PWCLI" fill <ref> "\$E2E_ADMIN_EMAIL"\`、\`"\$PWCLI" fill <ref> "\$E2E_ADMIN_PASSWORD"\`。
- 不得用 echo、printf、printenv、env、set、cat 等任何方式把這兩個變數的值印出來或寫進檔案。
- 報告、截圖檔名、你寫的任何檔案與訊息裡都不得出現密碼；提到帳號時寫「E2E 管理員」，不要寫出 email。
- 清單要求「錯誤密碼」時，自己編一個明顯錯的字串（例如 wrong-password-123），不要拿真密碼去改。

## 範圍
- 只做清單列出的步驟。不要改密碼、不要建立／停用／刪除帳號、不要改任何資料，除非清單明確要求。
- 不要修改 repo、不要跑 git。
- 某一步失敗就記「不通過」、截圖、寫下看到什麼，然後照清單的指示決定要不要繼續（清單沒說就繼續下一步）。

## 最後一則訊息＝報告（只輸出 Markdown，不要多寫別的）
格式：

# 驗收報告：<清單標題>

- 站台：${TARGET_URL}
- 時間：<開始時間>

| 步驟 | 結果 | 看到什麼 | 截圖 |
|---|---|---|---|
| 1 <步驟名稱> | 通過 | <一句話> | screenshots/01-xxx.png |
| 2 <步驟名稱> | 不通過 | <預期什麼、實際什麼> | screenshots/02-xxx.png |

總結：通過 N、不通過 M

清單若另外規定了「結果」欄的寫法或要加的彙整表（例如外觀對照的三級），照清單寫；最後一行仍然要以「總結：」開頭。

<checklist>
$(cat "$CHECKLIST")
</checklist>
EOF

echo "驗收清單：$CHECKLIST"
echo "測試站：$TARGET_URL"
echo "輸出目錄：$RUN_DIR"
echo "Codex：模型 ${MODEL}、沙盒 $SANDBOX"
echo ""

# 白名單轉成 TOML 陣列給 include_only：["PATH","HOME",...]
include_only="$(printf '"%s",' "${CODEX_ENV_WHITELIST[@]}")"
include_only="[${include_only%,}]"

codex_args=(
  exec
  -m "$MODEL"
  -s "$SANDBOX"
  -C "$RUN_DIR"
  --skip-git-repo-check
  --ephemeral
  --color never
  # Codex 開的 shell：從完整環境出發（inherit=all），但只留白名單上的變數。
  -c 'shell_environment_policy.inherit="all"'
  -c "shell_environment_policy.include_only=$include_only"
  -o "$REPORT"
)
if [ "$SANDBOX" = workspace-write ]; then
  # 預設沙盒不開網路；要連測試站、要 npx 抓 playwright-cli。
  codex_args+=(-c 'sandbox_workspace_write.network_access=true')
  [ -d "$HOME/.npm" ] && codex_args+=(--add-dir "$HOME/.npm")
  # Playwright 的瀏覽器快取（macOS）；沒有這個，沙盒裡第一次裝瀏覽器會寫不進去。
  [ -d "$HOME/Library/Caches/ms-playwright" ] && codex_args+=(--add-dir "$HOME/Library/Caches/ms-playwright")
fi

# 在子 shell 裡把白名單外的環境變數全部 unset，再 exec codex。
# 不用 `env -i 名稱=值 codex`：那樣帳密會出現在 env 的指令列（ps 看得到）。
# 帳密只以環境變數交給 codex 這一個行程（不 export 給其他指令，也不進指令列）。
codex_status=0
(
  while IFS= read -r name; do
    keep=0
    for pattern in "${CODEX_ENV_WHITELIST[@]}"; do
      # shellcheck disable=SC2254  # pattern 要當萬用字元比對（LC_*）
      case "$name" in $pattern) keep=1; break ;; esac
    done
    [ "$keep" = 1 ] || unset "$name" 2>/dev/null || true
  done < <(compgen -e)
  E2E_ADMIN_EMAIL="$e2e_email" E2E_ADMIN_PASSWORD="$e2e_password" \
    exec codex "${codex_args[@]}" "$PROMPT" < /dev/null
) || codex_status=$?

# ── 洩漏檢查：輸出目錄的文字檔裡不能有密碼 ─────────────────────
# E2E 管理員密碼（先掃：它是唯一會讓這支腳本報錯的洩漏）：
# 密碼從 process substitution 餵給 grep -f（printf 是 shell 內建，不會出現在 ps 裡）。
# 檔名一行一個（輸出目錄的檔名是 Codex 照提示取的英文短名）；不用 -Z，macOS 上的 grep 不一定支援。
leaked=()
while IFS= read -r file; do
  [ -n "$file" ] && leaked+=("$file")
done < <(grep -rIlF -f <(printf '%s\n' "$e2e_password") "$RUN_DIR" 2>/dev/null || true)
if [ "${#leaked[@]}" -gt 0 ]; then
  for file in "${leaked[@]}"; do
    E2E_REDACT="$e2e_password" perl -pi -e 's/\Q$ENV{E2E_REDACT}\E/[已遮蔽]/g' "$file"
  done
  echo "⚠️ 輸出裡出現了密碼，已遮蔽這些檔案：${leaked[*]}" >&2
  echo "   密碼可能已進了 Codex 的對話：在 Doppler stg 換一組新的 E2E_ADMIN_EMAIL＋E2E_ADMIN_PASSWORD（下次部署會建新帳號），" >&2
  echo "   再到測試站後台把舊的 E2E 測試管理員停用。" >&2
  exit 1
fi

# 老師的臨時密碼（Codex 從畫面讀來的）格式固定：4 組 4 碼，字母表同
# web/src/infrastructure/accounts/temporary-password.ts。出現就遮掉並警告；說明格式用的 XXXX-XXXX-XXXX-XXXX 不算。
# 臨時密碼改密後就失效、收尾也會停用那個帳號，所以只警告、不算失敗。
# Codex 自編的測試密碼沒有固定格式，這裡掃不到——靠清單要求它不寫進報告。
temp_pw='[A-HJ-NP-Za-hjkmnp-z2-9]{4}(-[A-HJ-NP-Za-hjkmnp-z2-9]{4}){3}'
temp_leaked=()
# grep -l 只列檔名（輸出目錄路徑含 : 也不會切錯）；真的有沒有命中由 perl 判斷：有遮就結束碼 0、沒有就 3。
while IFS= read -r file; do
  [ -n "$file" ] || continue
  temp_status=0
  TEMP_PW="$temp_pw" perl -pi -e \
    '$n += s/(?<![A-Za-z0-9-])(?!(?:XXXX-){3}XXXX(?![A-Za-z0-9-]))$ENV{TEMP_PW}(?![A-Za-z0-9-])/[已遮蔽]/g; END { exit($n ? 0 : 3) }' \
    "$file" || temp_status=$?
  case "$temp_status" in
    0) temp_leaked+=("$file") ;;
    3) ;;
    *) echo "⚠️ 沒辦法檢查 ${file} 裡有沒有臨時密碼（perl 以 ${temp_status} 結束），請自己看一眼。" >&2 ;;
  esac
done < <(LC_ALL=C grep -rIlE "$temp_pw" "$RUN_DIR" 2>/dev/null || true)
if [ "${#temp_leaked[@]}" -gt 0 ]; then
  echo "⚠️ 輸出裡有像老師臨時密碼的字串，已遮蔽這些檔案：${temp_leaked[*]}（臨時密碼改密後即失效；若那位老師沒改密成功，確認收尾已停用他）" >&2
fi

if [ "$codex_status" -ne 0 ]; then
  die "codex exec 以 $codex_status 結束。輸出目錄：$RUN_DIR"
fi
[ -s "$REPORT" ] || die "Codex 沒有產出報告（$REPORT 是空的）。"

echo ""
echo "報告：$REPORT"
grep -E '^總結：' "$REPORT" || echo "（報告裡沒有「總結：」那一行，請直接看報告）"
