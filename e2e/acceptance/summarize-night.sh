#!/usr/bin/env bash
# 整夜驗收彙整：把一個 run 目錄拼成一頁總覽 summary.md（設計方案 §3.5），可選擇複製進 Vault（§3.6）。
# 同時在 run 目錄寫 summary.json（給開發者後台讀：run 基本資料、各項目步驟列與問題清單、人設分數；不進 Vault）。
#
#   e2e/acceptance/summarize-night.sh <RUN_DIR>                         # 只寫 <RUN_DIR>/summary.md
#   e2e/acceptance/summarize-night.sh <RUN_DIR> --vault                 # 另寫進預設 Vault 的 🧪 驗收報告/<日期>/
#   e2e/acceptance/summarize-night.sh <RUN_DIR> --vault <工程開發目錄>  # 指到別處（例如 /tmp/vault-test 先試）
#   e2e/acceptance/summarize-night.sh <RUN_DIR> --vault --date 0000-00-00-test   # 指定日期子目錄（測試用）
#   e2e/acceptance/summarize-night.sh <RUN_DIR> --vault --polish        # 另請 codex 在最上面加一段白話（可失敗）
#
# 只讀：run.json、run.log（找 dependency-not-met）、各項目的 report.md／progress.md、被引用的截圖。
# 每份報告只解析 §5.3 問題表、`## 做不到（環境）` 清單與 §5.5 結尾兩行；格式不合就原文貼進「未解析」節，
# 總覽照樣產出。沒有 report.md 只有 progress.md 的項目用進度檔。
#
# 總覽順序（§13.2 教訓 3）：一眼看 → 網站的 擋上線／要修／建議／待 Roy 決定 → 做不到（環境）→ 資安 → 可開票 → 附。
# 四級的數字只算網站問題；資安報告（標題「# 資安報告」或項目 id 以 security 開頭）不進四級，
# 收成「## 資安」一節：問題清單剩下的（gitleaks 套允許清單後、官方規則）、套件升級每個套件一列、
# 自訂規則待人工分類只給數字與連結。
#
# 去重（§3.5）：`已知` 欄同代號 → 合一條（取最嚴重的那級）；否則 頁面＋嚴重度＋一句話前 12 字相同 → 合一條，
# 保留第一張截圖，其他來源寫「也出現在：…」。
#
# 遮蔽：寫出的總覽與複製進 Vault 的報告都先遮掉 Email、常見 token 格式與 `密碼：…` 這類寫法；
# 寫完再掃一次，還有殘留就非 0 結束。
#
# --polish（§13.2 教訓 4）：總覽產好後，把它交給唯讀 `codex exec`（-s read-only、工作目錄是空的暫存目錄、
# web_search 關閉、5 分鐘，逾時整個行程群組殺掉），請它寫「今晚一句話」＋每級前三條的白話版。不改數字與表格的保證：
# 模型輸出只會被插在標題兩行之後的「## 今晚一句話」這一節；寫入前檢查輸出沒有表格列、沒有標題、
# 不超過 20 行，而且裡面出現的每個數字都在原總覽出現過；插入後再確認「拿掉這一節＝原總覽」逐字相同。
# 任何一項不成立、codex 失敗或逾時，就略過潤稿，總覽照原樣產出。
# 旋鈕：SUMMARIZE_POLISH_BIN（預設 codex，測試換假程式）、SUMMARIZE_POLISH_MODEL（預設 gpt-6.1-sol）、
#       SUMMARIZE_POLISH_TIMEOUT（秒，預設 300）。
#
# Vault：只寫 <工程開發目錄>/🧪 驗收報告/<日期>/ 這一層；資料夾不存在就建，同名檔覆蓋、不刪多出來的檔。
# 日期預設取 run.json 的 startedAt（整夜跨午夜仍算開始那天），沒有就取 runId／今天。
set -euo pipefail

DEFAULT_VAULT_BASE="/Users/lubaiyu/Documents/roy422的人生online/專案/🌐 網站與互動/📁 輔大資管系專題網站/🛠️ 工程開發"

usage() { echo "用法：$0 <RUN_DIR> [--vault [<工程開發目錄>]] [--date <YYYY-MM-DD[-標籤]>] [--polish]" >&2; exit 2; }

[ $# -ge 1 ] || usage
RUN_DIR="$1"; shift
[ -d "$RUN_DIR" ] || { echo "找不到 run 目錄：$RUN_DIR" >&2; exit 1; }

VAULT_BASE=""
DATE_LABEL=""
POLISH=""
while [ $# -gt 0 ]; do
  case "$1" in
    --vault)
      if [ $# -ge 2 ] && [ "${2#--}" = "$2" ]; then VAULT_BASE="$2"; shift 2
      else VAULT_BASE="$DEFAULT_VAULT_BASE"; shift; fi ;;
    --date)
      [ $# -ge 2 ] || usage
      DATE_LABEL="$2"; shift 2 ;;
    --polish) POLISH=1; shift ;;
    *) usage ;;
  esac
done

if [ -n "$DATE_LABEL" ] && ! printf '%s' "$DATE_LABEL" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}(-[A-Za-z0-9]+)*$'; then
  echo "--date 只接受 YYYY-MM-DD 或 YYYY-MM-DD-<英數標籤>：$DATE_LABEL" >&2; exit 2
fi
if [ -n "$VAULT_BASE" ] && [ ! -d "$VAULT_BASE" ]; then
  echo "找不到 Vault 工程開發目錄：$VAULT_BASE" >&2; exit 1
fi

umask 077
exec python3 -I - "$RUN_DIR" "$VAULT_BASE" "$DATE_LABEL" "$POLISH" <<'PY'
import json, os, re, shutil, signal, subprocess, sys, tempfile
from datetime import datetime

run_dir, vault_base, date_label, polish = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] == '1'
run_dir = os.path.realpath(run_dir)

LEVELS = ['擋上線', '要修', '建議', '待 Roy 決定']
COLS = ['編號', '嚴重度', '一句話', '角色', '頁面', '步驟', '截圖', '已知', '可開票']
EMPTY = {'', '—', '-', '無'}

# ---------- 遮蔽 ----------
EMAIL = re.compile(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b')
TOKENS = [
    re.compile(r'\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}'),
    re.compile(r'\bsk-[A-Za-z0-9_-]{20,}'),
    re.compile(r'\bxox[abprs]-[A-Za-z0-9-]{10,}'),
    re.compile(r'\bAKIA[0-9A-Z]{16}\b'),
    re.compile(r'\bdp\.(?:st|pt|ct|sa|scim)\.[A-Za-z0-9_.-]{20,}'),
    re.compile(r'\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}'),
    re.compile(r'-----BEGIN [A-Z ]*PRIVATE KEY-----'),
]
PW = re.compile(r'((?:密碼|password|passwd|pwd|token|secret)\s*[:：=]\s*)([^\s`|，。、）)]{6,})', re.I)
PW_OK = re.compile(r'^(?:\$\{?[A-Z_]+\}?|\[已遮蔽\]|已遮蔽|沒有|不記錄.*|由.*|\*+)$')
leaks = []

def scrub(text, where):
    def em(m):
        leaks.append((where, 'Email')); return '[Email 已遮蔽]'
    text = EMAIL.sub(em, text)
    for pat in TOKENS:
        def tk(m):
            leaks.append((where, 'token')); return '[token 已遮蔽]'
        text = pat.sub(tk, text)
    def pw(m):
        if PW_OK.match(m.group(2)): return m.group(0)
        leaks.append((where, '密碼')); return m.group(1) + '[已遮蔽]'
    return PW.sub(pw, text)

def residual(text):
    if EMAIL.search(text): return True
    if any(p.search(text) for p in TOKENS): return True
    return any(not PW_OK.match(m.group(2)) for m in PW.finditer(text))

# ---------- 讀 run.json／run.log ----------
def read(path):
    with open(path, encoding='utf-8', errors='replace') as f: return f.read()

run = {}
rj = os.path.join(run_dir, 'run.json')
run_json_problem = None
if os.path.isfile(rj):
    try: run = json.loads(read(rj))
    except Exception as e: run_json_problem = f'run.json 讀不懂：{e}'
else:
    run_json_problem = '沒有 run.json'

# run.log 一行：`YYYY-MM-DD HH:MM:SS  <事件>  <項目或 ->  <說明>`（ops/acceptance-night.sh 的 log()）
LOG_LINE = re.compile(r'^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}):\d{2}\s+(\S+)\s+(\S+)\s*(.*)$')
dep_notes = {}
snap_events = []   # (事件, 時間, 說明)：snapshot／snapshot-failed／restore／restore-failed
log_commits = []   # (標籤, commit 前 8 碼)：每章開頭量到的
rl = os.path.join(run_dir, 'run.log')
if os.path.isfile(rl):
    for line in read(rl).splitlines():
        m = LOG_LINE.match(line)
        if not m:
            if 'dependency-not-met' in line:   # 舊格式：用｜分欄
                parts = [p.strip() for p in re.split(r'[｜|]', line)]
                dep_notes[parts[2] if len(parts) > 2 else '?'] = 'dependency-not-met'
            continue
        _, t, ev, item, msg = m.groups()
        if ev == 'dependency-not-met': dep_notes[item] = ev
        elif ev in ('snapshot', 'snapshot-failed', 'restore', 'restore-failed'): snap_events.append((ev, t, msg))
        elif ev in ('commit', 'commit-changed'):
            c = re.search(r'(?:commit|now)=([0-9a-f]{7,40})', msg)
            if c: log_commits.append((item, c.group(1)[:8]))

def hhmm(ts):
    if not ts: return '—'
    m = re.search(r'(\d{2}):(\d{2})', str(ts))
    return f'{m.group(1)}:{m.group(2)}' if m else str(ts)

if date_label:
    date = date_label
else:
    s = str(run.get('startedAt') or '')
    m = re.match(r'(\d{4}-\d{2}-\d{2})', s)
    m2 = re.search(r'night-(\d{4})(\d{2})(\d{2})', str(run.get('runId') or os.path.basename(run_dir)))
    date = m.group(1) if m else (f'{m2.group(1)}-{m2.group(2)}-{m2.group(3)}' if m2 else datetime.now().strftime('%Y-%m-%d'))

# ---------- 項目清單 ----------
run_items = {}
order = []
for it in run.get('items') or []:
    if isinstance(it, dict) and it.get('id'):
        run_items[it['id']] = it; order.append(it['id'])
for name in sorted(os.listdir(run_dir)):
    p = os.path.join(run_dir, name)
    if os.path.isdir(p) and name not in order and (
            os.path.isfile(os.path.join(p, 'report.md')) or os.path.isfile(os.path.join(p, 'progress.md'))):
        order.append(name)

# ---------- 解析一份報告 ----------
def cells(line):
    s = line.strip()
    if not (s.startswith('|') and s.endswith('|')): return None
    s = s[1:-1]
    return [c.strip().replace('\\|', '|') for c in re.split(r'(?<!\\)\|', s)]

def section(lines, title_re):
    start = None
    for i, l in enumerate(lines):
        if start is None and re.match(title_re, l): start = i + 1; continue
        if start is not None and re.match(r'^#{1,2} ', l): return lines[start:i]
    return lines[start:] if start is not None else None

def parse_report(text):
    lines = text.splitlines()
    errs = []
    nonblank = [l.strip() for l in lines if l.strip()]
    summary = next((l for l in reversed(nonblank[-3:]) if l.startswith('總結：')), None)
    relay = next((l for l in nonblank[-2:] if l.startswith('接力：')), None)
    if not summary: errs.append('結尾找不到「總結：」行（§5.5）')
    sec = section(lines, r'^## 問題清單')
    rows, env = [], []
    if sec is None:
        errs.append('找不到「## 問題清單」節（§5.3）')
    else:
        tbl = [l for l in sec if l.strip().startswith('|')]
        if not tbl or cells(tbl[0]) != COLS:
            errs.append('問題表欄位不是固定 9 欄：' + (tbl[0].strip() if tbl else '（沒有表格）'))
        else:
            for l in tbl[2:]:
                c = cells(l)
                if c is None or len(c) != 9:
                    errs.append(f'問題表有一列不是 9 欄：{l.strip()}'); continue
                if c[1] not in LEVELS and '環境' in c[1]:
                    # 問題表裡標成環境的列：不算網站問題，改列進環境節
                    env.append(f"第 {c[5]} 步：{c[2]}（{c[1]}）" if c[5] not in EMPTY else f"{c[2]}（{c[1]}）")
                    continue
                if c[1] not in LEVELS:
                    errs.append(f'嚴重度不是四級之一：{c[1]}'); continue
                rows.append(dict(zip(COLS, c)))
    esec = section(lines, r'^## 做不到（環境）')
    for l in esec or []:
        if re.match(r'^\s*[-*] ', l): env.append(re.sub(r'^\s*[-*] ', '', l).strip())
        else:
            c = cells(l)   # 也接受表格寫法；略過表頭與分隔列
            if c and not all(re.fullmatch(r':?-{3,}:?', x) for x in c) and c[0] not in ('步驟', '編號'):
                env.append('、'.join(x for x in c if x))
    # 資安報告多兩節（run-static.sh）：套件升級表、自訂規則待人工分類的數字
    pkgs = []
    psec = section(lines, r'^## 套件升級')
    for l in psec or []:
        c = cells(l)
        if c and len(c) == 5 and c[0] != '套件' and not all(re.fullmatch(r':?-{3,}:?', x) for x in c):
            pkgs.append(dict(zip(['套件', '現版', '目標版本', '最高嚴重度', '漏洞編號'], c)))
    csec = section(lines, r'^## 自訂規則待人工分類')
    cm = re.search(r'待人工分類\s*(\d+)\s*條', '\n'.join(csec or []))
    # 人設報告（§5.7）：「## 任務」底下每個「### 任務 N：…」的完成與分數
    tasks = []
    for l in section(lines, r'^## 任務\s*$') or []:
        if re.match(r'^###\s*任務', l): tasks.append({'done': None, 'score': None})
        elif tasks:
            m = re.match(r'^\s*[-*]\s*完成[:：]\s*(\S+)', l)
            if m: tasks[-1]['done'] = m.group(1)
            m = re.match(r'^\s*[-*]\s*分數[:：]\s*([1-5])\b', l)
            if m: tasks[-1]['score'] = m.group(1)
    tm = re.match(r'^#\s*.*?報告[:：]\s*(.+)$', lines[0]) if lines else None
    return {'ok': not errs, 'errs': errs, 'rows': rows, 'env': env, 'summary': summary, 'relay': relay,
            'tasks': tasks, 'title': tm.group(1).strip() if tm else None,
            'pkgs': pkgs if psec is not None else None, 'custom': int(cm.group(1)) if cm else None}

def parse_progress(text):
    steps, env, last = 0, [], None
    for l in text.splitlines():
        c = cells(l)
        if not c or len(c) < 2 or not re.match(r'^\d+$', c[0]): continue
        steps += 1; last = c
        if '做不到（環境' in c[1]: env.append(f'第 {c[0]} 步：{c[1]}（取自 progress.md）')
    return steps, env, last

SHOT = re.compile(r'(?:\./)?(screenshots/[A-Za-z0-9._/-]+\.(?:png|jpe?g|webp|gif))', re.I)

items = []
for iid in order:
    d = os.path.join(run_dir, iid)
    info = {'id': iid, 'meta': run_items.get(iid, {}), 'report': None, 'progress': None,
            'parsed': None, 'line': '', 'shots': set()}
    rp, pp = os.path.join(d, 'report.md'), os.path.join(d, 'progress.md')
    info['security'] = iid.startswith('security')
    if os.path.isfile(rp):
        info['report'] = read(rp)
        info['security'] = info['security'] or info['report'].lstrip().startswith('# 資安報告')
        info['parsed'] = parse_report(info['report'])
        info['shots'].update(SHOT.findall(info['report']))
    if os.path.isfile(pp):
        info['progress'] = read(pp)
    items.append(info)

# ---------- 去重 ----------
RANK = {lv: i for i, lv in enumerate(LEVELS)}
KNOWN_CODE = re.compile(r'(?<![\w-])((?:訪|系)\d+|D-\d+)(?![\w-])')
merged = []
index = {}
for info in items:
    p = info['parsed']
    if not p or not p['ok'] or info['security']: continue
    for r in p['rows']:
        # 只有正式代號（known-issues.md 的 訪N／系N／D-N）能合併；「第二段」這類值只顯示，不當去重鍵
        kc = KNOWN_CODE.search(r['已知'])
        known = r['已知'] if r['已知'] not in EMPTY else None
        keys = ([('known', kc.group(1))] if kc else []) + [('text', r['頁面'], r['嚴重度'], r['一句話'][:12])]
        step = r['步驟'] if r['步驟'] not in EMPTY else None
        src = f"{info['id']} 第 {step} 步" if step else info['id']
        shots = SHOT.findall(r['截圖'])
        shot = (info['id'], shots[0]) if shots else None
        hit = next((index[k] for k in keys if k in index), None)
        if hit:
            m = hit
            if RANK[r['嚴重度']] < RANK[m['level']]:
                # 較嚴重的那條當主條，原主條改列「也出現在」
                m['also'].insert(0, m['src'])
                m.update(level=r['嚴重度'], text=r['一句話'], page=r['頁面'], src=src, shot=shot or m['shot'])
            else:
                m['also'].append(src)
                m['shot'] = m['shot'] or shot
            m['known'] = m['known'] or known
            m['ticket'] = m['ticket'] or r['可開票'] == '是'
        else:
            m = {'level': r['嚴重度'], 'text': r['一句話'], 'page': r['頁面'], 'src': src, 'also': [],
                 'shot': shot, 'known': known, 'ticket': r['可開票'] == '是'}
            merged.append(m)
        for k in keys: index.setdefault(k, m)

n = 0
for lv in LEVELS:
    for m in merged:
        if m['level'] == lv:
            n += 1; m['no'] = f'N-{n:02d}'

# 資安：不進四級，另成一節
sec_rows, sec_pkgs, sec_custom, sec_items = [], [], [], []
for info in items:
    p = info['parsed']
    if not info['security'] or not p or not p['ok']: continue
    sec_items.append(info)
    for r in p['rows']:
        step = r['步驟'] if r['步驟'] not in EMPTY else None
        sec_rows.append({'level': r['嚴重度'], 'text': r['一句話'], 'page': r['頁面'],
                         'src': f"{info['id']} 第 {step} 步" if step else info['id'], 'ticket': r['可開票'] == '是'})
    sec_pkgs += p['pkgs'] or []
    if p['custom'] is not None: sec_custom.append((info, p['custom']))
sec_rows.sort(key=lambda m: RANK[m['level']])
for i, m in enumerate(sec_rows, 1): m['no'] = f'S-{i:02d}'

env_all = []
for info in items:
    p = info['parsed']
    if p and p['ok']:
        env_all += [(info['id'], e) for e in p['env']]
    elif info['progress'] is not None and not info['report']:
        env_all += [(info['id'], e) for e in parse_progress(info['progress'])[1]]

# ---------- 輸出 ----------
def esc(s): return str(s).replace('|', '\\|').replace('\n', ' ')

def link(path, label):
    return f'[{label}](<{path}>)' if ' ' in path else f'[{label}]({path})'

def shot_path(item, shot, mode):
    return f'{item}/{shot}' if mode == 'run' else f'附件/{item}/{os.path.basename(shot)}'

def report_path(info, mode):
    if mode == 'run':
        return f"{info['id']}/report.md" if info['report'] else f"{info['id']}/progress.md"
    return f"{info['id']}.md" if info['report'] else f"{info['id']}-progress.md"

def render_personas():
    ps = [i for i in items if i['parsed'] and i['parsed']['ok'] and i['parsed'].get('tasks')]
    if not ps: return []
    n = max(len(i['parsed']['tasks']) for i in ps)
    out = ['### 人設 × 任務（分數 1–5／完成）', '']
    out.append('| 人設 | ' + ' | '.join(f'任務 {k}' for k in range(1, n + 1)) + ' | 平均 |')
    out.append('|---|' + '---|' * (n + 1))
    for i in ps:
        ts = i['parsed']['tasks']
        cells = [f"{t['score'] or '—'}／{t['done'] or '—'}" for t in ts] + ['—'] * (n - len(ts))
        sc = [int(t['score']) for t in ts if t['score']]
        avg = f'{sum(sc) / len(sc):.1f}' if sc else '—'
        name = i['parsed'].get('title') or i['id']
        out.append(f"| {esc(name)}（{esc(i['id'])}） | " + ' | '.join(esc(c) for c in cells) + f' | {avg} |')
    out.append('')
    return out

def security_count():
    if not sec_items: return '—'
    lv = {l: sum(1 for m in sec_rows if m['level'] == l) for l in LEVELS}
    head = f"擋上線 {lv['擋上線']}" + ''.join(f'、{l} {lv[l]}' for l in LEVELS[1:] if lv[l])
    old = any(i['parsed']['pkgs'] is None for i in sec_items)
    pk = '套件 —（舊格式）' if old and not sec_pkgs else f'套件 {len(sec_pkgs)}'
    cu = f'待分類 {sum(n for _, n in sec_custom)}' if sec_custom else '待分類 —'
    return f"{head}；{pk}；{cu}"

def render_security(mode):
    out = ['## 資安', '']
    if not sec_items:
        out += ['這次沒有資安報告（或報告格式不合約，見「未解析」）。', '']
        return out
    out.append('靜態掃描的結果，不算進上面網站問題的四級數字。')
    out.append('')
    out.append('### 要處理的資安問題（gitleaks 套允許清單後、官方規則）')
    out.append('')
    if sec_rows:
        out.append('| 編號 | 嚴重度 | 一句話 | 位置 | 來源 |')
        out.append('|---|---|---|---|---|')
        for m in sec_rows:
            out.append(f"| {m['no']} | {m['level']} | {esc(m['text'])} | {esc(m['page'])} | {esc(m['src'])} |")
    else:
        out.append('沒有。')
    out.append('')
    out.append(f'### 套件升級（{len(sec_pkgs)} 個套件）')
    out.append('')
    if sec_pkgs:
        out.append('| 套件 | 目前版本 → 建議版本 | 最高嚴重度 | 相關 GHSA |')
        out.append('|---|---|---|---|')
        for k in sec_pkgs:
            out.append(f"| {esc(k['套件'])} | {esc(k['現版'])} → {esc(k['目標版本'])} | {esc(k['最高嚴重度'])} | {esc(k['漏洞編號'])} |")
    elif any(i['parsed']['pkgs'] is None for i in sec_items):
        out.append('資安報告是舊格式（沒有「套件升級」節），套件漏洞若有，列在上面的問題表；請用新版 run-static.sh 重產。')
    else:
        out.append('沒有。')
    out.append('')
    n = sum(c for _, c in sec_custom)
    links = '、'.join(link(report_path(i, mode), report_path(i, mode)) for i, _ in sec_custom)
    out.append('### 自訂規則待人工分類')
    out.append('')
    if sec_custom:
        out.append(f'待人工分類 {n} 條（粗篩，不算擋上線）；檔案清單見 {links}「自訂規則待人工分類」。')
    else:
        out.append('報告沒有這一節（舊格式或沒跑 semgrep）。')
    out.append('')
    return out

def render(mode):
    out = []
    cs, ce = run.get('commitStart'), run.get('commitEnd')
    s8 = (cs or '未記錄')[:8]; e8 = (ce or '未記錄')[:8]
    # 開始、各章開頭（run.log）、中途（run.json commitMidway）、結束：任何一次和開始不同就算換版
    seen = [('開始', cs[:8])] if cs else []
    seen += [(f'{i} 開頭', c) for i, c in log_commits]
    # commitMidway：舊 run 是字串；G1 e83e1ad 起是陣列 [{item, commit, at}]，沒換版時沒有這個鍵
    mid = run.get('commitMidway')
    if isinstance(mid, str): mid = [{'item': None, 'commit': mid}]
    for e in mid if isinstance(mid, list) else []:
        c = str((e or {}).get('commit') or '')[:8] if isinstance(e, dict) else ''
        if not c: continue
        it = e.get('item')
        label = f'{it} 開頭' if it else '中途'
        # 同一章同一 commit run.log 已列過就不重複；字串版沒有章名，只要任何一次出現過就不列
        if any(c == sc and (it is None or sl == label) for sl, sc in seen): continue
        seen.append((label, c))
    if ce: seen.append(('結束', ce[:8]))
    seen = [(l, c) for l, c in seen if re.fullmatch(r'[0-9a-f]{7,40}', c)]   # 量不到（unknown）不算換版
    changed = len({c for _, c in seen}) > 1
    title = f'# 網站驗收總覽 {date}'
    if changed: title += ' ⚠️ 測試站中途換版'
    out.append(title)
    if changed:
        steps, last = [], None
        for label, c in seen:
            if c != last: steps.append(f'{label} {c}'); last = c
        commit_txt = f"⚠️ 測試站中途換版：{' → '.join(steps)}，以下結果可能混到不同版本"
    elif cs and ce and all(re.fullmatch(r'[0-9a-f]{7,40}', x) for x in (cs, ce)):
        commit_txt = f'測試站 commit {s8} → {e8}（未變）'
    else:
        commit_txt = f'測試站 commit {s8} → {e8}（無法比對）'
    out.append(f"計畫 {run.get('plan') or '—'}｜開始 {hhmm(run.get('startedAt'))}｜結束 {hhmm(run.get('finishedAt'))}｜{commit_txt}")
    if snap_events:
        # 括號裡是補充（例如快照密碼另存的路徑），不進總覽
        out.append('快照：' + '｜'.join(f"{t} {re.sub(r'（.*$', '', msg).strip()}" for _, t, msg in snap_events))
    if leaks:
        kinds = sorted({k for _, k in leaks})
        tail = '；請更換相關密碼／token' if set(kinds) - {'Email'} else ''
        out.append(f"⚠️ 報告裡出現疑似{'、'.join(kinds)}，已遮蔽{tail}")
    if run_json_problem:
        out.append(f'（{run_json_problem}，狀態與 commit 欄位留空）')
    out.append('')

    counts = {lv: sum(1 for m in merged if m['level'] == lv) for lv in LEVELS}
    out.append('## 一眼看')
    out.append('')
    out.append('| 擋上線 | 要修 | 建議 | 待 Roy 決定 | 做不到（環境） | 資安 |')
    out.append('|---|---|---|---|---|---|')
    out.append(f"| {counts['擋上線']} | {counts['要修']} | {counts['建議']} | {counts['待 Roy 決定']} | {len(env_all)} | {esc(security_count())} |")
    out.append('')
    out.append('| 項目 | 狀態 | 總結 |')
    out.append('|---|---|---|')
    for info in sorted(items, key=lambda i: i['security']):   # 網站項目在前、資安在後
        meta = info['meta']
        st = meta.get('status') or '—'
        if meta.get('resumed') and st != 'resumed': st += '（resumed）'
        if info['id'] in dep_notes: st += '｜dependency-not-met'
        p = info['parsed']
        if p and p['ok']:
            line = p['summary'] or ''
            if p['relay']: line += f"　{p['relay']}"
        elif p:
            line = '報告格式不合約，見「未解析」'
        elif info['progress'] is not None:
            steps, _, last = parse_progress(info['progress'])
            lt = f"，最後一步：第 {last[0]} 步 {last[1]}" if last else ''
            line = f'沒有報告，只有進度檔（progress.md，{steps} 步{lt}）'
        else:
            line = '沒有報告也沒有進度檔'
        out.append(f"| {esc(info['id'])} | {esc(st)} | {esc(line)} |")
    out.append('')
    out += render_personas()

    for lv in LEVELS:
        out.append(f'## {lv}')
        out.append('')
        rows = [m for m in merged if m['level'] == lv]
        if not rows:
            out.append('沒有。'); out.append(''); continue
        out.append('| 編號 | 一句話 | 頁面 | 來源 | 截圖 | 已知 |')
        out.append('|---|---|---|---|---|---|')
        for m in rows:
            src = m['src'] + (f"；也出現在：{'、'.join(m['also'])}" if m['also'] else '')
            shot = link(shot_path(*m['shot'], mode), '截圖') if m['shot'] else '—'
            out.append(f"| {m['no']} | {esc(m['text'])} | {esc(m['page'])} | {esc(src)} | {shot} | {esc(m['known'] or '—')} |")
        out.append('')

    out.append('## 做不到（環境）')
    out.append('')
    out.append('環境問題（網路、限速、session 死掉、工具）不算進上面四級。')
    out.append('')
    if env_all:
        for iid, e in env_all: out.append(f'- {iid}：{e}')
    else:
        out.append('沒有。')
    out.append('')

    out += render_security(mode)

    out.append('## 可開票清單')
    out.append('')
    tix = [m for m in merged if m['ticket'] and m['level'] != '待 Roy 決定']
    stix = [m for m in sec_rows if m['ticket'] and m['level'] != '待 Roy 決定']
    for m in tix: out.append(f"- [{m['level']}] {m['text']}｜{m['page']}｜{m['no']}")
    for m in stix: out.append(f"- [資安‧{m['level']}] {m['text']}｜{m['page']}｜{m['no']}")
    if sec_pkgs: out.append(f'- [資安] 升級 {len(sec_pkgs)} 個有已知漏洞的相依套件｜pnpm-lock.yaml｜資安節「套件升級」')
    if not (tix or stix or sec_pkgs):
        out.append('沒有。')
    out.append('')

    bad = [i for i in items if i['parsed'] and not i['parsed']['ok']]
    if bad:
        out.append('## 未解析')
        out.append('')
        out.append('下列報告不符合報告合約（§5），沒有算進上面的數字；原文照貼。')
        out.append('')
        for info in bad:
            out.append(f"### {info['id']}")
            out.append('')
            for e in info['parsed']['errs'][:5]: out.append(f'- {e}')
            out.append('')
            for l in info['report'].splitlines(): out.append('> ' + l if l else '>')
            out.append('')

    out.append('## 附')
    out.append('')
    for info in items:
        if info['report'] or info['progress'] is not None:
            out.append(f"- {info['id']}：{link(report_path(info, mode), report_path(info, mode))}")
    out.append('')
    return '\n'.join(out)

# 先遮蔽各份報告（遮蔽紀錄要進總覽的警告行），再產總覽
for info in items:
    if info['report']: info['report'] = scrub(info['report'], info['id'])
    if info['progress'] is not None: info['progress'] = scrub(info['progress'], info['id'])
for m in merged + sec_rows:
    m['text'] = scrub(m['text'], 'summary'); m['page'] = scrub(m['page'], 'summary')
env_all = [(i, scrub(e, i)) for i, e in env_all]

written = []
def write(path, text):
    text = scrub(text, os.path.basename(path))
    with open(path, 'w', encoding='utf-8') as f: f.write(text)
    written.append(path)

# ---------- 潤稿（--polish；失敗就略過）----------
POLISH_TITLE = '## 今晚一句話'

def polish_text(base):
    bin_ = os.environ.get('SUMMARIZE_POLISH_BIN') or 'codex'
    model = os.environ.get('SUMMARIZE_POLISH_MODEL') or 'gpt-6.1-sol'
    try: limit = int(os.environ.get('SUMMARIZE_POLISH_TIMEOUT') or 300)
    except ValueError: limit = 300
    prompt = (
        '你是驗收報告的潤稿員。下面是一份網站驗收總覽（Markdown）。請只用繁體中文寫一段給系辦主任看的白話：\n'
        '第一行以「今晚一句話：」開頭，一句話講今晚網站整體狀況；接著擋上線、要修、建議、待 Roy 決定 四級，'
        '每級有問題才寫，最多挑前三條，每條一行、以「- 」開頭、用白話重講（保留編號，例如 N-01）。\n'
        '規則：不要表格、不要標題（# 開頭）、不要程式碼區塊；不可新增或改動任何數字，只能引用總覽裡已有的數字與編號；'
        '資安只用一句話帶過；不要寫檔案路徑或連結；全部不超過 15 行。不要讀任何檔案、不要執行任何指令，只根據下面的內容回答。\n\n'
        '----- 總覽開始 -----\n' + base + '\n----- 總覽結束 -----\n')
    work = tempfile.mkdtemp(prefix='fju-polish-')
    outf = os.path.join(work, 'last-message.txt')
    try:
        proc = subprocess.Popen(
            # web_search 明確關掉（使用者設定可能開著）；總覽內容直接放在 prompt，不必讀任何檔
            [bin_, 'exec', '-m', model, '-s', 'read-only', '-c', 'web_search="disabled"', '-C', work, '--skip-git-repo-check',
             '--ephemeral', '--color', 'never', '-o', outf, '-'],
            stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            cwd=work, start_new_session=True)
        try:
            proc.communicate(prompt.encode('utf-8'), timeout=limit)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL); proc.wait()
            return None, f'逾時（{limit} 秒）'
        if proc.returncode != 0: return None, f'codex 失敗（退出碼 {proc.returncode}）'
        if not os.path.isfile(outf): return None, 'codex 沒有輸出'
        text = read(outf).strip()
    except OSError as e:
        return None, f'無法執行 {bin_}：{e}'
    finally:
        shutil.rmtree(work, ignore_errors=True)
    lines = [l.rstrip() for l in text.splitlines()]
    while lines and not lines[-1]: lines.pop()
    if not lines: return None, '輸出是空的'
    if len(lines) > 20: return None, f'輸出 {len(lines)} 行，超過 20 行'
    if any(l.lstrip().startswith(('|', '#', '```')) for l in lines):
        return None, '輸出含表格、標題或程式碼區塊'
    nums = set(re.findall(r'\d+', base))
    extra = sorted({x for x in re.findall(r'\d+', text) if x not in nums})
    if extra: return None, f"輸出出現總覽沒有的數字：{'、'.join(extra[:5])}"
    return '\n'.join(lines), None

def with_polish(base, para):
    if not para: return base
    at = base.index('## 一眼看')
    block = f'{POLISH_TITLE}\n\n{para}\n\n'
    final = base[:at] + block + base[at:]
    # 保證潤稿只多一節：拿掉這一節必須逐字等於原總覽
    assert final[:at] + final[at + len(block):] == base
    return final

polish_para = None
if polish:
    polish_para, why = polish_text(scrub(render('run'), 'polish'))
    print(f'潤稿：{"已加入「今晚一句話」" if polish_para else "略過（" + why + "）"}', file=sys.stderr)

write(os.path.join(run_dir, 'summary.md'), with_polish(render('run'), polish_para))
print(f'總覽：{os.path.join(run_dir, "summary.md")}')

if vault_base:
    root = os.path.realpath(os.path.join(vault_base, '🧪 驗收報告'))
    dest = os.path.realpath(os.path.join(root, date))
    if os.path.dirname(dest) != root:
        sys.exit(f'拒絕寫入：{dest} 不在 {root} 底下')
    os.makedirs(dest, exist_ok=True)
    write(os.path.join(dest, '總覽.md'), with_polish(render('vault'), polish_para))
    for info in items:
        iid = info['id']
        if info['report']:
            body = SHOT.sub(lambda mm: f'附件/{iid}/{os.path.basename(mm.group(1))}', info['report'])
            write(os.path.join(dest, f'{iid}.md'), body)
        elif info['progress'] is not None:
            body = SHOT.sub(lambda mm: f'附件/{iid}/{os.path.basename(mm.group(1))}', info['progress'])
            write(os.path.join(dest, f'{iid}-progress.md'), body)
            info['shots'].update(SHOT.findall(info['progress']))
    for m in merged:
        if m['shot']:
            next(i for i in items if i['id'] == m['shot'][0])['shots'].add(m['shot'][1])
    copied = 0
    for info in items:
        for shot in sorted(info['shots']):
            src = os.path.join(run_dir, info['id'], shot)
            if not os.path.isfile(src): continue
            ad = os.path.join(dest, '附件', info['id'])
            os.makedirs(ad, exist_ok=True)
            shutil.copyfile(src, os.path.join(ad, os.path.basename(shot)))
            copied += 1
    print(f'Vault：{dest}（{len(written) - 1} 份文件、{copied} 張截圖）')

# ---------- summary.json（給開發者後台讀；只寫 run 目錄，不進 Vault）----------
# 內容從「已遮蔽」的報告重新解析；整份字串寫出前再經 write() 的 scrub()，最後一樣跑 residual()。
STEP_COLS = ['步驟', '角色', '結果', '看到什麼', '截圖']
COUNT_KEY = re.compile(r'(不通過|通過|做不到|環境|問題|擋上線|要修|建議|待 Roy 決定|套件|自訂規則待分類)\s*(\d+)')

def parse_steps(text):
    out = []
    for l in section(text.splitlines(), r'^## 步驟結果') or []:
        c = cells(l)
        if not c or len(c) != len(STEP_COLS) or c[0] == '步驟' or all(re.fullmatch(r':?-{3,}:?', x) for x in c):
            continue
        row = dict(zip(STEP_COLS, c))
        row['截圖'] = [f"{iid}/{s}" for s in SHOT.findall(row['截圖'])]
        out.append(row)
    return out

def json_item(info):
    meta = info['meta']
    p = parse_report(info['report']) if info['report'] else None
    summary = p['summary'] if p else None
    d = {'id': info['id'], 'kind': meta.get('kind'), 'status': meta.get('status'),
         'resumed': bool(meta.get('resumed')), 'dependencyNotMet': info['id'] in dep_notes,
         'security': info['security'], 'report': report_path(info, 'run') if (info['report'] or info['progress'] is not None) else None,
         'parsed': bool(p and p['ok']), 'summaryLine': summary, 'relay': p['relay'] if p else None,
         'counts': {k: int(v) for k, v in COUNT_KEY.findall(summary or '')},
         'steps': parse_steps(info['report']) if info['report'] else [],
         'problems': [dict(r) for r in p['rows']] if p and p['ok'] else [],
         'errors': p['errs'] if p and not p['ok'] else []}
    return d

json_items = []
for info in items:
    iid = info['id']
    json_items.append(json_item(info))
personas = []
for info, ji in zip(items, json_items):
    p = parse_report(info['report']) if info['report'] else None
    if not (p and p['ok'] and p['tasks']): continue
    ts = [{'task': k, 'score': int(t['score']) if t['score'] else None, 'done': t['done']}
          for k, t in enumerate(p['tasks'], 1)]
    sc = [t['score'] for t in ts if t['score'] is not None]
    personas.append({'id': info['id'], 'title': p.get('title'), 'tasks': ts,
                     'average': round(sum(sc) / len(sc), 1) if sc else None})
summary_json = {
    'runId': run.get('runId') or os.path.basename(run_dir), 'plan': run.get('plan'),
    'startedAt': run.get('startedAt'), 'finishedAt': run.get('finishedAt'),
    'commitStart': run.get('commitStart'), 'commitEnd': run.get('commitEnd'),
    'problemColumns': COLS, 'items': json_items, 'personas': personas,
}
json_path = os.path.join(run_dir, 'summary.json')
json_text = json.dumps(summary_json, ensure_ascii=False, indent=2) + '\n'
json_problem = None
n_leaks = len(leaks)
if scrub(json_text, 'summary.json') != json_text:
    # 內容已從遮蔽過的報告來，整份再遮蔽一次還有變動＝新的疑似秘密，或密碼遮蔽剛好在字串結尾、
    # 被吃掉結尾引號；兩種都不寫（寧可沒有 JSON，也不留洩漏或讀不懂的檔），summary.md／Vault 照常。
    del leaks[n_leaks:]
    json_problem = '整份 JSON 遮蔽後有變動，未寫 summary.json'
    if os.path.exists(json_path): os.remove(json_path)
else:
    write(json_path, json_text)
    json.loads(read(json_path))
    print(f'JSON：{json_path}')

bad = [p for p in written if residual(read(p))]
if bad:
    sys.exit('遮蔽後仍有疑似秘密：' + '、'.join(bad))
if leaks:
    print(f'注意：遮蔽了 {len(leaks)} 處疑似秘密（見總覽第二行）', file=sys.stderr)
if json_problem:
    sys.exit(json_problem)
PY
