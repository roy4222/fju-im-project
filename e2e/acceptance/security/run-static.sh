#!/usr/bin/env bash
# 驗收夜資安靜態掃描：對「測試站回報的那個 commit」跑 semgrep、pnpm audit、osv-scanner、gitleaks，
# 產出各工具原始輸出與一份照報告合約（設計方案 §5）寫的 report.md。
#
#   e2e/acceptance/security/run-static.sh <輸出目錄> [commit]
#
# - commit 沒給：讀 https://test.fju.roy422.dev/api/health 的 commit（整支唯一一次對網站的請求）。
# - commit 只在本機解析（不 fetch）；用 `git archive` 解到暫存目錄再掃，不動任何現有工作樹，掃完刪暫存。
# - gitleaks 掃 repo 的 git 歷史（到該 commit 為止），一律 --redact，原始輸出不含秘密本文。
# - 工具沒裝：印 `brew install …`、該項記「做不到（環境）」、其他照跑、報告照產，最後非 0 結束。
# - 嚴重度：高＝擋上線、中＝要修、低＝建議（對映寫在 report.md「注意」）。
#
# 輸出：<輸出目錄>/semgrep.json、audit.json、osv.json、gitleaks.json、report.md（＋ *.stderr.txt 工具訊息）。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HEALTH_URL="https://test.fju.roy422.dev/api/health"

[ $# -ge 1 ] && [ $# -le 2 ] || { echo "用法：$0 <輸出目錄> [commit]" >&2; exit 2; }
umask 077
mkdir -p "$1"
OUT="$(cd "$1" && pwd)"
COMMIT="${2:-}"
REPO="$(git -C "$HERE" rev-parse --show-toplevel)"
STARTED="$(date '+%Y-%m-%d %H:%M')"

if [ -z "$COMMIT" ]; then
  COMMIT="$(curl -fsS --max-time 20 "$HEALTH_URL" | python3 -I -c 'import json,sys; print(json.load(sys.stdin).get("commit") or "")' || true)"
  [ -n "$COMMIT" ] || { echo "讀不到測試站 commit（$HEALTH_URL）；請直接給 commit 參數" >&2; exit 1; }
fi
SHA="$(git -C "$REPO" rev-parse --verify --quiet "${COMMIT}^{commit}" || true)"
[ -n "$SHA" ] || { echo "本機 repo 沒有 commit $COMMIT（不會自動 fetch；請先在 repo 取得它）" >&2; exit 1; }
echo "掃描 commit $SHA"

TMP="$(mktemp -d /tmp/fju-static.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
mkdir "$TMP/src"
git -C "$REPO" archive "$SHA" | tar -x -C "$TMP/src"

STATUS_FILE="$OUT/.tool-status"
: > "$STATUS_FILE"
# 每個工具一行：名稱｜ran／missing／error｜說明
note() { printf '%s|%s|%s\n' "$1" "$2" "$3" >> "$STATUS_FILE"; }
missing() {
  echo "缺 $1：brew install $2" >&2
  printf '{"skipped": true, "reason": "未安裝 %s（brew install %s）"}\n' "$1" "$2" > "$OUT/$3"
  note "$1" missing "未安裝（brew install $2）"
}
broken() {
  printf '{"skipped": true, "reason": "%s 執行失敗（退出碼 %s）"}\n' "$1" "$2" > "$OUT/$3"
  note "$1" error "執行失敗（退出碼 $2），訊息見 $4"
}

# ---------- semgrep ----------
if command -v semgrep >/dev/null 2>&1; then
  echo "semgrep …"
  set +e
  semgrep scan --metrics=off --disable-version-check --quiet \
    --config p/typescript --config p/javascript --config p/nextjs --config "$HERE/semgrep-custom.yml" \
    --exclude prototype --exclude node_modules --exclude docs \
    --json --output "$OUT/semgrep.json" "$TMP/src" 2> "$OUT/semgrep.stderr.txt"
  rc=$?
  set -e
  # 0＝沒發現、1＝有發現；其他＝規則下載或執行錯誤
  if [ "$rc" -le 1 ] && [ -s "$OUT/semgrep.json" ]; then note semgrep ran ""
  else broken semgrep "$rc" semgrep.json semgrep.stderr.txt; fi
else
  missing semgrep semgrep semgrep.json
fi

# ---------- pnpm audit ----------
if command -v pnpm >/dev/null 2>&1; then
  echo "pnpm audit …"
  set +e
  (cd "$TMP/src" && pnpm audit --json) > "$OUT/audit.json" 2> "$OUT/audit.stderr.txt"
  rc=$?
  set -e
  if python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(1 if "error" in d else 0)' "$OUT/audit.json" 2>/dev/null; then
    note "pnpm audit" ran ""
  else broken "pnpm audit" "$rc" audit.json audit.stderr.txt; fi
else
  missing "pnpm audit" pnpm audit.json
fi

# ---------- osv-scanner ----------
if command -v osv-scanner >/dev/null 2>&1; then
  echo "osv-scanner …"
  set +e
  if osv-scanner scan source --help >/dev/null 2>&1; then
    osv-scanner scan source --format json -L "$TMP/src/pnpm-lock.yaml" > "$OUT/osv.json" 2> "$OUT/osv.stderr.txt"
  else
    osv-scanner --format json --lockfile "$TMP/src/pnpm-lock.yaml" > "$OUT/osv.json" 2> "$OUT/osv.stderr.txt"
  fi
  rc=$?
  set -e
  if [ "$rc" -le 1 ] && [ -s "$OUT/osv.json" ]; then note osv-scanner ran ""
  else broken osv-scanner "$rc" osv.json osv.stderr.txt; fi
else
  missing osv-scanner osv-scanner osv.json
fi

# ---------- gitleaks（git 歷史，到該 commit 為止）----------
if command -v gitleaks >/dev/null 2>&1; then
  echo "gitleaks …"
  set +e
  if gitleaks git --help >/dev/null 2>&1; then
    gitleaks git --no-banner --redact --exit-code 0 --log-opts="$SHA" \
      --report-format json --report-path "$OUT/gitleaks.json" "$REPO" 2> "$OUT/gitleaks.stderr.txt"
  else
    gitleaks detect --no-banner --redact --exit-code 0 --log-opts="$SHA" --source "$REPO" \
      --report-format json --report-path "$OUT/gitleaks.json" 2> "$OUT/gitleaks.stderr.txt"
  fi
  rc=$?
  set -e
  if [ "$rc" -eq 0 ] && [ -s "$OUT/gitleaks.json" ]; then note gitleaks ran ""
  else broken gitleaks "$rc" gitleaks.json gitleaks.stderr.txt; fi
else
  missing gitleaks gitleaks gitleaks.json
fi

# ---------- report.md ----------
FINISHED="$(date '+%H:%M')"
set +e
python3 -I - "$OUT" "$SHA" "$STARTED" "$FINISHED" "$TMP/src" "$STATUS_FILE" <<'PY'
import json, os, re, sys

out, sha, started, finished, src, status_file = sys.argv[1:7]
src_prefix = os.path.realpath(src).rstrip('/') + '/'

def load(name):
    try:
        with open(os.path.join(out, name), encoding='utf-8') as f: return json.load(f)
    except Exception: return None

status = {}
with open(status_file, encoding='utf-8') as f:
    for line in f:
        name, st, why = line.rstrip('\n').split('|', 2)
        status[name] = (st, why)

def esc(s, limit=None):
    s = re.sub(r'\s+', ' ', str(s)).strip().replace('|', '\\|')
    return s[:limit - 1] + '…' if limit and len(s) > limit else s

def rel(p):
    p = str(p)
    for pre in (src_prefix, os.path.realpath(src_prefix) + '/', '/private' + src_prefix):
        if p.startswith(pre): return p[len(pre):]
    return p

rows = []   # (嚴重度, 一句話, 工具, 頁面)
counts = {}

d = load('semgrep.json') if status.get('semgrep', ('',))[0] == 'ran' else None
if d is not None:
    sev = {'ERROR': '擋上線', 'WARNING': '要修', 'INFO': '建議'}
    res = d.get('results') or []
    counts['semgrep'] = len(res)
    for r in res:
        rule = r.get('check_id', '?').split('.')[-1]
        msg = (r.get('extra') or {}).get('message', '')
        level = sev.get(((r.get('extra') or {}).get('severity') or '').upper(), '要修')
        rows.append((level, f'[{rule}] {msg}', 'semgrep', f"{rel(r.get('path', '?'))}:{(r.get('start') or {}).get('line', '?')}"))

seen_ghsa = set()
d = load('audit.json') if status.get('pnpm audit', ('',))[0] == 'ran' else None
if d is not None:
    sev = {'critical': '擋上線', 'high': '擋上線', 'moderate': '要修', 'low': '建議', 'info': '建議'}
    adv = d.get('advisories') or {}
    counts['pnpm audit'] = len(adv)
    for a in adv.values():
        ghsa = a.get('github_advisory_id') or ''
        if ghsa: seen_ghsa.add(ghsa)
        vers = sorted({f.get('version', '?') for f in a.get('findings') or []})
        rows.append((sev.get(a.get('severity', ''), '要修'),
                     f"[{ghsa or a.get('id', '?')}] {a.get('title', '')}（受影響 {a.get('vulnerable_versions', '?')}）",
                     'pnpm audit', f"{a.get('module_name', '?')}@{'、'.join(vers) or '?'}"))

d = load('osv.json') if status.get('osv-scanner', ('',))[0] == 'ran' else None
if d is not None:
    n = 0
    for res in d.get('results') or []:
        for p in res.get('packages') or []:
            pkg = p.get('package') or {}
            vulns = {v.get('id'): v for v in p.get('vulnerabilities') or []}
            for g in p.get('groups') or []:
                ids = (g.get('ids') or []) + (g.get('aliases') or [])
                n += 1
                if seen_ghsa & set(ids): continue    # pnpm audit 已列過同一個 GHSA
                try: score = float(g.get('max_severity') or 0)
                except ValueError: score = 0
                level = '擋上線' if score >= 7 else '要修' if score >= 4 else '建議' if score > 0 else '要修'
                first = (g.get('ids') or ['?'])[0]
                summ = (vulns.get(first) or {}).get('summary', '')
                rows.append((level, f'[{first}] {summ}', 'osv-scanner', f"{pkg.get('name', '?')}@{pkg.get('version', '?')}"))
    counts['osv-scanner'] = n

d = load('gitleaks.json') if status.get('gitleaks', ('',))[0] == 'ran' else None
if d is not None:
    d = d if isinstance(d, list) else []
    counts['gitleaks'] = len(d)
    for r in d:   # 不讀 Secret／Match 欄
        rows.append(('擋上線', f"[{r.get('RuleID', '?')}] git 歷史裡疑似有秘密（commit {str(r.get('Commit', ''))[:8]}）",
                     'gitleaks', f"{r.get('File', '?')}:{r.get('StartLine', '?')}"))

LEVELS = ['擋上線', '要修', '建議', '待 Roy 決定']
rows.sort(key=lambda r: LEVELS.index(r[0]))
by = {lv: sum(1 for r in rows if r[0] == lv) for lv in LEVELS}
tools = ['semgrep', 'pnpm audit', 'osv-scanner', 'gitleaks']
raw = {'semgrep': 'semgrep.json', 'pnpm audit': 'audit.json', 'osv-scanner': 'osv.json', 'gitleaks': 'gitleaks.json'}
ran = [t for t in tools if status.get(t, ('',))[0] == 'ran']
clean = [t for t in ran if not counts.get(t)]
dirty = [t for t in ran if counts.get(t)]
cant = [t for t in tools if t not in ran]

L = []
L.append('# 資安報告：靜態全掃（semgrep、pnpm audit、osv-scanner、gitleaks）')
L.append('- 項目：security-static')
L.append('- 站台：https://test.fju.roy422.dev')
L.append(f'- 時間：{started}–{finished}')
L.append(f'- 測試站版本：commit={sha[:8]}')
L.append('- 本項改到的資料：沒有')
L.append('')
L.append('## 各工具')
L.append('')
L.append('| 工具 | 狀態 | 發現 | 原始輸出 |')
L.append('|---|---|---|---|')
for t in tools:
    st, why = status.get(t, ('missing', '沒有執行'))
    label = '跑完' if st == 'ran' else f'做不到（環境：{why}）'
    L.append(f"| {t} | {esc(label)} | {counts.get(t, '—') if st == 'ran' else '—'} | {raw[t]} |")
L.append('')
L.append('## 注意')
L.append('')
L.append(f'- 掃的是 commit {sha[:8]} 的 `git archive` 快照（不含 prototype／docs）；gitleaks 掃 git 歷史到這個 commit 為止，輸出已 redact。')
L.append('- 嚴重度對映：semgrep ERROR／WARNING／INFO → 擋上線／要修／建議；pnpm audit critical、high → 擋上線，moderate → 要修，low → 建議；osv-scanner CVSS ≥7 → 擋上線、≥4 → 要修、其他 → 建議（沒有分數記要修）；gitleaks 一律擋上線。')
L.append('- osv-scanner 與 pnpm audit 同一個 GHSA 只列一次（列在 pnpm audit）。')
L.append('- 自訂規則 `fju-query-template-interpolation`、`fju-write-without-authorize` 是粗篩，會有誤報：插入寫死的常數、權限檢查寫在方法第 4 行以後或交給呼叫端，都會被報；白天看過再決定要不要開票。')
L.append('- 這支腳本對網站最多只送一次 `/api/health`（沒給 commit 時）；semgrep 會向 semgrep.dev 下載官方規則集（已關 metrics），pnpm audit 與 osv-scanner 會查 npm／osv.dev 的漏洞資料庫，都不碰測試站。')
L.append('')
L.append('## 做不到（環境）')
L.append('')
if cant:
    for t in cant:
        L.append(f'- {t}：{status.get(t, ("", "沒有執行"))[1]}；未重試')
else:
    L.append('沒有。')
L.append('')
L.append('## 問題清單（彙整用，不要改欄位）')
L.append('')
L.append('| 編號 | 嚴重度 | 一句話 | 角色 | 頁面 | 步驟 | 截圖 | 已知 | 可開票 |')
L.append('|---|---|---|---|---|---|---|---|---|')
for i, (lv, text, tool, page) in enumerate(rows, 1):
    L.append(f'| P-{i:02d} | {lv} | {esc(text, 140)} | {tool} | {esc(page)} | — | — | — | 是 |')
L.append('')
L.append(f"總結：通過 {len(clean)}、不通過 {len(dirty)}、做不到 {len(cant)}（環境 {len(cant)}）、問題 {len(rows)}（擋上線 {by['擋上線']}／要修 {by['要修']}／建議 {by['建議']}／待 Roy 決定 {by['待 Roy 決定']}）")
text = '\n'.join(L) + '\n'

# 遮蔽：Email（TLD 要是字母，避免吃掉 pkg@1.2.3）與常見 token 格式
EMAIL = re.compile(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b')
TOKENS = [re.compile(p) for p in (
    r'\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}', r'\bsk-[A-Za-z0-9_-]{20,}',
    r'\bxox[abprs]-[A-Za-z0-9-]{10,}', r'\bAKIA[0-9A-Z]{16}\b', r'\bdp\.(?:st|pt|ct|sa|scim)\.[A-Za-z0-9_.-]{20,}',
    r'\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}', r'-----BEGIN [A-Z ]*PRIVATE KEY-----')]
text = EMAIL.sub('[Email 已遮蔽]', text)
for p in TOKENS: text = p.sub('[token 已遮蔽]', text)
if EMAIL.search(text) or any(p.search(text) for p in TOKENS):
    sys.exit('report.md 遮蔽後仍有疑似秘密，不寫出')
with open(os.path.join(out, 'report.md'), 'w', encoding='utf-8') as f: f.write(text)
print(f"report.md：問題 {len(rows)}（擋上線 {by['擋上線']}／要修 {by['要修']}／建議 {by['建議']}）；做不到 {len(cant)}")
sys.exit(3 if cant else 0)
PY
rc=$?
set -e
rm -f "$STATUS_FILE"
echo "輸出：$OUT"
[ "$rc" -eq 0 ] || { echo "有工具沒跑成（見 report.md「做不到（環境）」）" >&2; exit 1; }
