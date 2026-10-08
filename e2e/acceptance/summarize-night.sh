#!/usr/bin/env bash
# 整夜驗收彙整：把一個 run 目錄拼成一頁總覽 summary.md（設計方案 §3.5），可選擇複製進 Vault（§3.6）。
#
#   e2e/acceptance/summarize-night.sh <RUN_DIR>                         # 只寫 <RUN_DIR>/summary.md
#   e2e/acceptance/summarize-night.sh <RUN_DIR> --vault                 # 另寫進預設 Vault 的 🧪 驗收報告/<日期>/
#   e2e/acceptance/summarize-night.sh <RUN_DIR> --vault <工程開發目錄>  # 指到別處（例如 /tmp/vault-test 先試）
#   e2e/acceptance/summarize-night.sh <RUN_DIR> --vault --date 0000-00-00-test   # 指定日期子目錄（測試用）
#
# 只讀：run.json、run.log（找 dependency-not-met）、各項目的 report.md／progress.md、被引用的截圖。
# 每份報告只解析 §5.3 問題表、`## 做不到（環境）` 清單與 §5.5 結尾兩行；格式不合就原文貼進「未解析」節，
# 總覽照樣產出。沒有 report.md 只有 progress.md 的項目用進度檔。
#
# 去重（§3.5）：`已知` 欄同代號 → 合一條（取最嚴重的那級）；否則 頁面＋嚴重度＋一句話前 12 字相同 → 合一條，
# 保留第一張截圖，其他來源寫「也出現在：…」。
#
# 遮蔽：寫出的總覽與複製進 Vault 的報告都先遮掉 Email、常見 token 格式與 `密碼：…` 這類寫法；
# 寫完再掃一次，還有殘留就非 0 結束。
#
# Vault：只寫 <工程開發目錄>/🧪 驗收報告/<日期>/ 這一層；資料夾不存在就建，同名檔覆蓋、不刪多出來的檔。
# 日期預設取 run.json 的 startedAt（整夜跨午夜仍算開始那天），沒有就取 runId／今天。
set -euo pipefail

DEFAULT_VAULT_BASE="/Users/lubaiyu/Documents/roy422的人生online/專案/🌐 網站與互動/📁 輔大資管系專題網站/🛠️ 工程開發"

usage() { echo "用法：$0 <RUN_DIR> [--vault [<工程開發目錄>]] [--date <YYYY-MM-DD[-標籤]>]" >&2; exit 2; }

[ $# -ge 1 ] || usage
RUN_DIR="$1"; shift
[ -d "$RUN_DIR" ] || { echo "找不到 run 目錄：$RUN_DIR" >&2; exit 1; }

VAULT_BASE=""
DATE_LABEL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --vault)
      if [ $# -ge 2 ] && [ "${2#--}" = "$2" ]; then VAULT_BASE="$2"; shift 2
      else VAULT_BASE="$DEFAULT_VAULT_BASE"; shift; fi ;;
    --date)
      [ $# -ge 2 ] || usage
      DATE_LABEL="$2"; shift 2 ;;
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
exec python3 -I - "$RUN_DIR" "$VAULT_BASE" "$DATE_LABEL" <<'PY'
import json, os, re, shutil, sys
from datetime import datetime

run_dir, vault_base, date_label = sys.argv[1], sys.argv[2], sys.argv[3]
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

dep_notes = {}
rl = os.path.join(run_dir, 'run.log')
if os.path.isfile(rl):
    for line in read(rl).splitlines():
        if 'dependency-not-met' in line:
            parts = [p.strip() for p in re.split(r'[｜|]', line)]
            item = parts[2] if len(parts) > 2 else '?'
            dep_notes[item] = 'dependency-not-met'

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
    return {'ok': not errs, 'errs': errs, 'rows': rows, 'env': env, 'summary': summary, 'relay': relay}

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
    if os.path.isfile(rp):
        info['report'] = read(rp)
        info['parsed'] = parse_report(info['report'])
        info['shots'].update(SHOT.findall(info['report']))
    if os.path.isfile(pp):
        info['progress'] = read(pp)
    items.append(info)

# ---------- 去重 ----------
RANK = {lv: i for i, lv in enumerate(LEVELS)}
merged = []
index = {}
for info in items:
    p = info['parsed']
    if not p or not p['ok']: continue
    for r in p['rows']:
        known = r['已知'] if r['已知'] not in EMPTY else None
        keys = ([('known', known)] if known else []) + [('text', r['頁面'], r['嚴重度'], r['一句話'][:12])]
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

def render(mode):
    out = []
    cs, ce = run.get('commitStart'), run.get('commitEnd')
    s8 = (cs or '未記錄')[:8]; e8 = (ce or '未記錄')[:8]
    changed = bool(cs and ce and cs[:8] != ce[:8])
    title = f'# 網站驗收總覽 {date}'
    if changed: title += ' ⚠️ 測試站中途換版'
    out.append(title)
    if changed:
        commit_txt = f'⚠️ 測試站中途換版：{s8} → {e8}，以下結果可能混到兩個版本'
    elif cs and ce:
        commit_txt = f'測試站 commit {s8} → {e8}（未變）'
    else:
        commit_txt = f'測試站 commit {s8} → {e8}（無法比對）'
    out.append(f"計畫 {run.get('plan') or '—'}｜開始 {hhmm(run.get('startedAt'))}｜結束 {hhmm(run.get('finishedAt'))}｜{commit_txt}")
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
    out.append('| 擋上線 | 要修 | 建議 | 待 Roy 決定 | 做不到（環境） |')
    out.append('|---|---|---|---|---|')
    out.append(f"| {counts['擋上線']} | {counts['要修']} | {counts['建議']} | {counts['待 Roy 決定']} | {len(env_all)} |")
    out.append('')
    out.append('| 項目 | 狀態 | 總結 |')
    out.append('|---|---|---|')
    for info in items:
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

    out.append('## 可開票清單')
    out.append('')
    tix = [m for m in merged if m['ticket'] and m['level'] != '待 Roy 決定']
    if tix:
        for m in tix: out.append(f"- [{m['level']}] {m['text']}｜{m['page']}｜{m['no']}")
    else:
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
for m in merged:
    m['text'] = scrub(m['text'], 'summary'); m['page'] = scrub(m['page'], 'summary')
env_all = [(i, scrub(e, i)) for i, e in env_all]

written = []
def write(path, text):
    text = scrub(text, os.path.basename(path))
    with open(path, 'w', encoding='utf-8') as f: f.write(text)
    written.append(path)

write(os.path.join(run_dir, 'summary.md'), render('run'))
print(f'總覽：{os.path.join(run_dir, "summary.md")}')

if vault_base:
    root = os.path.realpath(os.path.join(vault_base, '🧪 驗收報告'))
    dest = os.path.realpath(os.path.join(root, date))
    if os.path.dirname(dest) != root:
        sys.exit(f'拒絕寫入：{dest} 不在 {root} 底下')
    os.makedirs(dest, exist_ok=True)
    write(os.path.join(dest, '總覽.md'), render('vault'))
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

bad = [p for p in written if residual(read(p))]
if bad:
    sys.exit('遮蔽後仍有疑似秘密：' + '、'.join(bad))
if leaks:
    print(f'注意：遮蔽了 {len(leaks)} 處疑似秘密（見總覽第二行）', file=sys.stderr)
PY
