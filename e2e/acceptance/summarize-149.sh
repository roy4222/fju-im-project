#!/usr/bin/env bash
# 149 案總檢查：把各份 Codex 清單的報告彙整成一份逐案結果。
#
#   e2e/acceptance/summarize-149.sh            # 讀 e2e/acceptance/.out/
#   e2e/acceptance/summarize-149.sh <輸出根目錄>
#
# 只讀兩種檔：e2e/acceptance/149-coverage.md（逐案對照表）與 .out/<時間>-<清單名>/report.md。
# 不讀、不碰秘密：不呼叫 doppler、codex，也不讀截圖。報告的「看到什麼」欄可能有 email、姓名，
# 這支腳本**不印那一欄**，只印步驟號、通過與否、報告的「總結：」行與測試站版本（commit 雜湊）。
#
# 做法：
#   1. 對照表每一列的「涵蓋步驟」欄寫著 `清單名:步驟,步驟-步驟; 清單名:…`。
#   2. 每份清單取 .out/ 裡最新的一次執行（目錄名 YYYYMMDD-HHMMSS-<清單名>，照字典序取最後一個）。
#   3. 從 report.md 的表格取每一步的「結果」欄：通過／不通過／其他（略過、跳過、未做……）。
#   4. 逐案判定：
#        通過     該案對到的步驟全部「通過」
#        不通過   任一步「不通過」
#        未跑完   沒有「不通過」，但有步驟不是「通過」（略過、跳過……）或報告裡找不到那一步
#        未跑     對到的清單沒有報告
#      狀態是「延後／不適用 Codex／待功能」的案照抄狀態，不判定。
#   5. 各份報告第 1 步若帶了 commit，列出來；不只一個版本時警告（開發計畫 §5 第 5 點：同一版本整體跑一次）。
#
# 結果印在終端機，同時存一份到 <輸出根目錄>/149-summary-<時間>.md（.out/ 已 gitignore）。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COVERAGE="$HERE/149-coverage.md"
OUT_ROOT="${1:-$HERE/.out}"

[ -f "$COVERAGE" ] || { echo "找不到對照表：$COVERAGE" >&2; exit 1; }
[ -d "$OUT_ROOT" ] || { echo "找不到輸出目錄：$OUT_ROOT（還沒跑過任何清單？）" >&2; exit 1; }

# 對照表裡提到的清單名（涵蓋步驟欄，冒號前面那段）。
lists="$(LC_ALL=C awk -F'|' '
  /^\| [A-Z][A-Z][A-Z]-[0-9][0-9] / {
    n = split($6, parts, ";")
    for (i = 1; i <= n; i++) {
      p = parts[i]; gsub(/[` ]/, "", p)
      if (p ~ /:/) { sub(/:.*/, "", p); print p }
    }
  }' "$COVERAGE" | sort -u)"

# 每份清單最新的一份報告：「清單名<TAB>報告路徑」，沒有報告的路徑留空。
map_file="$(mktemp "${TMPDIR:-/tmp}/summarize-149.XXXXXX")"
trap 'rm -f "$map_file"' EXIT
for name in $lists; do
  latest=""
  for dir in "$OUT_ROOT"/*-"$name"; do
    [ -d "$dir" ] || continue
    base="${dir##*/}"
    # 目錄名一定是「8 碼日期-6 碼時間-清單名」，免得 station-3 撿到 station-3-xxx 的目錄。
    [ "$base" = "${base:0:15}-$name" ] || continue
    case "${base:0:15}" in [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]) ;; *) continue ;; esac
    [ -f "$dir/report.md" ] || continue
    latest="$dir/report.md"   # glob 照字典序展開，最後一個就是最新的
  done
  printf '%s\t%s\n' "$name" "$latest" >> "$map_file"
done

stamp="$(date +%Y%m%d-%H%M%S)"
summary="$OUT_ROOT/149-summary-$stamp.md"

LC_ALL=C awk -F'|' -v mapfile="$map_file" -v stamp="$stamp" '
function trim(s) { gsub(/^[ \t]+|[ \t]+$/, "", s); return s }
BEGIN {
  # 讀每份報告：只取表格列的「步驟號」與「結果」兩欄、第 1 步的 commit、以及「總結：」行。
  while ((getline line < mapfile) > 0) {
    split(line, kv, "\t"); name = kv[1]; path = kv[2]
    order[++nlists] = name; report[name] = path
    if (path == "") continue
    while ((getline r < path) > 0) {
      if (r ~ /^總結：/) { total[name] = r; continue }
      if (r !~ /^\|/) continue
      m = split(r, cell, "|")
      if (m < 4) continue
      stepcell = trim(cell[2]); res = trim(cell[3])
      if (stepcell !~ /^[0-9]+/) continue
      step = stepcell; sub(/[^0-9].*/, "", step); step += 0
      result[name, step] = res
      if (step == 1 && match(r, /[Cc]ommit[^0-9a-f]*[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]/)) {
        h = substr(r, RSTART, RLENGTH); sub(/.*[^0-9a-f]/, "", h); commit[name] = substr(h, 1, 7)
      }
    }
    close(path)
  }
  close(mapfile)
  print "# 149 案總檢查結果（" stamp "）"
  print ""
  print "## 各份清單"
  print ""
  print "| 清單 | 報告 | 總結 | 測試站版本 |"
  print "|---|---|---|---|"
  for (i = 1; i <= nlists; i++) {
    n = order[i]
    p = report[n]; if (p == "") p = "（沒有報告）"; else { sub(/.*\/\.out\//, ".out/", p) }
    t = (n in total) ? total[n] : "—"
    c = (n in commit) ? commit[n] : "—"
    print "| " n " | " p " | " t " | " c " |"
    if (n in commit) { if (!(commit[n] in seen)) { seen[commit[n]] = 1; nver++ } }
  }
  print ""
  if (nver > 1) print "> ⚠️ 這幾份報告跑的不是同一個版本（commit 不只一個）。開發計畫 §5 第 5 點要同一版本整體跑一次，請在最新版本重跑較舊的清單。"
  else if (nver == 1) print "> 各份報告的測試站版本一致。"
  else print "> 報告裡找不到測試站版本（第 1 步的 commit），請自己核對。"
  print ""
  print "## 逐案結果"
  print ""
  print "| 案例 | 名稱 | 對照表狀態 | 結果 | 步驟結果 |"
  print "|---|---|---|---|---|"
}
/^\| [A-Z][A-Z][A-Z]-[0-9][0-9] / {
  id = trim($2); title = trim($3); status = trim($5); spec = $6
  gsub(/`/, "", spec)
  if (status !~ /^(已涵蓋|新增)/) {
    verdict = status; detail = "—"
  } else {
    fail = 0; incomplete = 0; notrun = 0; detail = ""
    n = split(spec, parts, ";")
    for (i = 1; i <= n; i++) {
      p = trim(parts[i]); if (p !~ /:/) continue
      name = p; sub(/:.*/, "", name); steps = p; sub(/^[^:]*:/, "", steps)
      if (report[name] == "") { notrun = 1; detail = detail name ":未跑 "; continue }
      k = split(steps, ranges, ",")
      for (j = 1; j <= k; j++) {
        rg = trim(ranges[j]); lo = rg; hi = rg
        if (rg ~ /-/) { lo = rg; sub(/-.*/, "", lo); hi = rg; sub(/.*-/, "", hi) }
        for (s = lo + 0; s <= hi + 0; s++) {
          if (!((name, s) in result)) { incomplete = 1; detail = detail name ":" s "（報告沒有這一步） "; continue }
          r = result[name, s]
          if (r ~ /^不通過/) { fail = 1; detail = detail name ":" s " 不通過 " }
          else if (r ~ /^通過/) { }
          else { incomplete = 1; detail = detail name ":" s " " r " " }
        }
      }
    }
    if (fail) verdict = "不通過"
    else if (notrun) verdict = "未跑"
    else if (incomplete) verdict = "未跑完"
    else { verdict = "通過"; detail = "全部通過" }
    detail = trim(detail)
  }
  count[verdict]++
  print "| " id " | " title " | " status " | " verdict " | " detail " |"
}
END {
  print ""
  printf "總計："
  sep = ""
  nk = split("通過,不通過,未跑完,未跑,延後,不適用 Codex,待功能", keys, ",")
  for (i = 1; i <= nk; i++) if (keys[i] in count) { printf "%s%s %d", sep, keys[i], count[keys[i]]; sep = "、"; done[keys[i]] = 1 }
  for (v in count) if (!(v in done)) { printf "%s%s %d", sep, v, count[v]; sep = "、" }
  print ""
}' "$COVERAGE" | tee "$summary"

echo ""
echo "已存：$summary"
