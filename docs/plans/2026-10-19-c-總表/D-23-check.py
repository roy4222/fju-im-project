#!/usr/bin/env python3
"""D-23 放寬後的前置檢查：除了三個共用檔（fp／sqlx／budget），任兩張還沒合的票只要可改檔案有交集，
就必須在放寬後的 blocked by 圖上有前置路徑（誰先誰後都可以）。輸出漏掉的組數；0＝通過。"""
import itertools, json, sys
d = json.load(open(sys.argv[1] if len(sys.argv) > 1 else 'D-23-check-data.json', encoding='utf-8'))['tickets']
THREE = {'fp', 'sqlx', 'budget'}
anc = {}
def ancestors(t):
    if t not in anc:
        s = set()
        for x in d[t]['blocked_by']:
            s |= {x} | ancestors(x)
        anc[t] = s
    return anc[t]
bad = []
for a, b in itertools.combinations(sorted(d), 2):
    if d[a]['merged'] or d[b]['merged']:
        continue
    shared = (set(d[a]['files']) & set(d[b]['files'])) - THREE
    if shared and a not in ancestors(b) and b not in ancestors(a):
        bad.append((a, b, sorted(shared)))
for a, b in [('C1-11', 'C2-22'), ('C1-10', 'C1-11')]:   # 三檔裡的同鍵組，仍須串著
    if a not in ancestors(b) and b not in ancestors(a):
        bad.append((a, b, ['同鍵']))
for row in bad:
    print('漏掉', *row)
print('漏掉的組數：', len(bad))
sys.exit(1 if bad else 0)
