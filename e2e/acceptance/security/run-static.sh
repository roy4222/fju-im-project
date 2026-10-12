#!/usr/bin/env bash
# 驗收夜資安靜態掃描：對「測試站回報的那個 commit」跑 semgrep、pnpm audit、osv-scanner、gitleaks，
# 產出各工具原始輸出與一份照報告合約（設計方案 §5）寫的 report.md。
#
#   e2e/acceptance/security/run-static.sh <輸出目錄> [commit]
#
# - commit 沒給：讀 https://test.fju.roy422.dev/api/health 的 commit（整支唯一一次對網站的請求）。
# - commit 只在本機解析（不 fetch）；用 `git archive` 解到暫存目錄再掃，不動任何現有工作樹，掃完刪暫存。
# - gitleaks 掃 repo 的 git 歷史（到該 commit 為止），一律 --redact，原始輸出不含秘密本文；
#   以 --config 套 gitleaks-allowlist.toml（已確認的誤報），剩下的才算擋上線。
# - 工具沒裝：印 `brew install …`、該項記「做不到（環境）」、其他照跑、報告照產，最後非 0 結束。
# - 報告分三類（設計方案 §13.2 教訓 3）：套件升級每個套件一列、自訂規則待人工分類（不進四級）、
#   gitleaks 剩下的＋官方 semgrep 規則進問題清單（嚴重度對映寫在 report.md「注意」）。
#
# 輸出：<輸出目錄>/semgrep.json、audit.json、osv.json、gitleaks.json、report.md（＋ *.stderr.txt 工具訊息）。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HEALTH_URL="https://test.fju.roy422.dev/api/health"
# 已確認的誤報（雜湊檔、臨時密碼字母表）；沿用 gitleaks 內建規則
GITLEAKS_CONFIG="$HERE/gitleaks-allowlist.toml"

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
    gitleaks git --no-banner --redact --exit-code 0 --config "$GITLEAKS_CONFIG" --log-opts="$SHA" \
      --gitleaks-ignore-path "$REPO/.gitleaksignore" \
      --report-format json --report-path "$OUT/gitleaks.json" "$REPO" 2> "$OUT/gitleaks.stderr.txt"
  else
    gitleaks detect --no-banner --redact --exit-code 0 --config "$GITLEAKS_CONFIG" --log-opts="$SHA" --source "$REPO" \
      --gitleaks-ignore-path "$REPO/.gitleaksignore" \
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
    # macOS 的 /tmp 是 /private/tmp 的連結：semgrep 可能回任一種寫法，兩種都剝掉
    p = str(p)
    for pre in sorted(PREFIXES, key=len, reverse=True):
        if p.startswith(pre): return p[len(pre):]
    return p

_abs = os.path.abspath(src).rstrip('/') + '/'
PREFIXES = {_abs, src_prefix, '/private' + _abs}

CUSTOM = ('fju-query-template-interpolation', 'fju-write-without-authorize')
rows = []     # 問題清單（9 欄）：gitleaks 套允許清單後剩下的＋官方 semgrep 規則
custom = []   # 自訂規則命中（待人工分類，不進四級）：(規則, 檔案:行)
pkgs = {}     # 套件名 → {'cur': {版本: 目標版本或 None}, 'sev': 嚴重度, 'ids': set()}
counts = {}

def ver(s):
    return tuple(int(x) for x in re.findall(r'\d+', str(s).split('-')[0])[:3]) or (0,)

def target(patched, cur):
    # patched_versions 例：">=7.29.1"、">=1.1.20 <2.0.0 || >=5.0.11"、"<0.0.0"（沒有修正版）
    ups = [v for v in re.findall(r'>=\s*([0-9][0-9A-Za-z.+-]*)', str(patched or '')) if ver(v) > ver(cur)]
    return min(ups, key=ver) if ups else None

SEV_RANK = {'critical': 4, 'high': 3, 'moderate': 2, 'medium': 2, 'low': 1, 'info': 0}

def add_pkg(name, cur, sev, vid, fix):
    # 同一版本有多個漏洞：目標版本取「有修正版的」裡最高的；沒有修正版的漏洞另記，不能被別的修正版蓋掉
    p = pkgs.setdefault(name, {'cur': {}, 'sev': 'info', 'ids': set(), 'unfixed': {}})
    old = p['cur'].get(cur)
    p['cur'][cur] = max([x for x in (old, fix) if x], key=ver) if (old or fix) else None
    if not fix: p['unfixed'].setdefault(cur, set()).add(vid or '?')
    if SEV_RANK.get(sev, 0) > SEV_RANK.get(p['sev'], 0): p['sev'] = sev
    if vid: p['ids'].add(vid)

d = load('semgrep.json') if status.get('semgrep', ('',))[0] == 'ran' else None
if d is not None:
    sev = {'ERROR': '擋上線', 'WARNING': '要修', 'INFO': '建議'}
    res = d.get('results') or []
    counts['semgrep'] = len(res)
    for r in res:
        rule = r.get('check_id', '?').split('.')[-1]
        where = f"{rel(r.get('path', '?'))}:{(r.get('start') or {}).get('line', '?')}"
        if rule in CUSTOM:
            custom.append((rule, where)); continue
        msg = (r.get('extra') or {}).get('message', '')
        level = sev.get(((r.get('extra') or {}).get('severity') or '').upper(), '要修')
        rows.append((level, f'[{rule}] {msg}', 'semgrep', where))

seen_ghsa = set()
d = load('audit.json') if status.get('pnpm audit', ('',))[0] == 'ran' else None
if d is not None:
    adv = d.get('advisories') or {}
    counts['pnpm audit'] = len(adv)
    for a in adv.values():
        ghsa = a.get('github_advisory_id') or ''
        if ghsa: seen_ghsa.add(ghsa)
        for v in sorted({f.get('version', '?') for f in a.get('findings') or []}, key=ver):
            add_pkg(a.get('module_name', '?'), v, a.get('severity', ''), ghsa or str(a.get('id', '')),
                    target(a.get('patched_versions'), v))

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
                sev = 'critical' if score >= 9 else 'high' if score >= 7 else 'moderate' if score >= 4 else 'low' if score > 0 else 'moderate'
                vid = next((i for i in ids if i.startswith('GHSA-')), (g.get('ids') or ['?'])[0])
                fixes = [e.get('fixed') for v in (vulns.get(i) for i in g.get('ids') or []) if v
                         for a in v.get('affected') or [] for rg in a.get('ranges') or []
                         for e in rg.get('events') or [] if e.get('fixed')]
                cur = pkg.get('version', '?')
                ups = [f for f in fixes if ver(f) > ver(cur)]
                add_pkg(pkg.get('name', '?'), cur, sev, vid, min(ups, key=ver) if ups else None)
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
SEV_LABEL = {'critical': '嚴重', 'high': '高', 'moderate': '中', 'medium': '中', 'low': '低', 'info': '資訊'}
plist = sorted(pkgs.items(), key=lambda kv: (-SEV_RANK.get(kv[1]['sev'], 0), kv[0]))

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
L.append('- 問題分三類：相依套件 → 「套件升級」每個套件一列；自訂規則 → 「自訂規則待人工分類」只列清單，不進四級、不算擋上線；gitleaks（套用允許清單後）與官方 semgrep 規則 → 下面的問題清單。')
L.append('- gitleaks 允許清單：`e2e/acceptance/security/gitleaks-allowlist.toml`（以 `--config` 明傳，沿用內建規則；只放已確認的雜湊檔與臨時密碼字母表，每條都是路徑＋內容特徵同時成立）。問題清單裡的 gitleaks 一律擋上線。')
L.append('- 問題清單嚴重度：semgrep ERROR／WARNING／INFO → 擋上線／要修／建議。套件的「最高嚴重度」取 pnpm audit 的 severity；osv-scanner 只補 pnpm audit 沒列到的漏洞（CVSS ≥9 嚴重、≥7 高、≥4 中、其他低，沒分數記中）。')
L.append('- 自訂規則 `fju-query-template-interpolation`、`fju-write-without-authorize` 是粗篩：插入寫死的常數、權限檢查全交給呼叫端，都會被報；白天看過再決定要不要開票。')
L.append('- 這支腳本對網站最多只送一次 `/api/health`（沒給 commit 時）；semgrep 會向 semgrep.dev 下載官方規則集（已關 metrics），pnpm audit 與 osv-scanner 會查 npm／osv.dev 的漏洞資料庫，都不碰測試站。')
L.append('')
L.append('## 套件升級')
L.append('')
if plist:
    L.append('| 套件 | 現版 | 目標版本 | 最高嚴重度 | 漏洞編號 |')
    L.append('|---|---|---|---|---|')
    for name, p in plist:
        curs = sorted(p['cur'], key=ver)
        tgts = [p['cur'][c] or '' for c in curs]
        tgt = (tgts[0] if len(set(tgts)) == 1 else '、'.join(t or '—' for t in tgts)) or '—'
        nofix = sorted(set().union(*p['unfixed'].values())) if p['unfixed'] else []
        if nofix:
            tgt = f"{tgt}（尚無完整修正版：{', '.join(nofix)} 沒有修正版）" if any(tgts) else f"尚無完整修正版（{', '.join(nofix)} 沒有修正版）"
        L.append(f"| {esc(name)} | {esc('、'.join(curs))} | {esc(tgt)} | {SEV_LABEL.get(p['sev'], p['sev'])} | {esc(', '.join(sorted(p['ids'])))} |")
else:
    L.append('沒有。')
L.append('')
L.append('## 自訂規則待人工分類')
L.append('')
L.append(f'待人工分類 {len(custom)} 條。')
L.append('')
if custom:
    L.append('| 規則 | 位置 |')
    L.append('|---|---|')
    for rule, where in sorted(custom):
        L.append(f'| {rule} | {esc(where)} |')
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
L.append(f"總結：通過 {len(clean)}、不通過 {len(dirty)}、做不到 {len(cant)}（環境 {len(cant)}）、問題 {len(rows)}（擋上線 {by['擋上線']}／要修 {by['要修']}／建議 {by['建議']}／待 Roy 決定 {by['待 Roy 決定']}）；套件 {len(plist)} 個、自訂規則待分類 {len(custom)} 條")
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
print(f"report.md：問題 {len(rows)}（擋上線 {by['擋上線']}／要修 {by['要修']}／建議 {by['建議']}）；套件 {len(plist)}、自訂規則待分類 {len(custom)}；做不到 {len(cant)}")
sys.exit(3 if cant else 0)
PY
rc=$?
set -e
rm -f "$STATUS_FILE"
echo "輸出：$OUT"
[ "$rc" -eq 0 ] || { echo "有工具沒跑成（見 report.md「做不到（環境）」）" >&2; exit 1; }
