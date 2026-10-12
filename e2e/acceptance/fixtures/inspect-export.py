#!/usr/bin/env python3
"""打開一個匯出檔（CSV 或 XLSX），印出核對要用的事實：格式、BOM、UTF-8、欄名、筆數、亂碼跡象。

用法（劇本第 6 章；用 -I 跑，不從下載目錄載入任何模組）：
  python3 -I <repo>/e2e/acceptance/fixtures/inspect-export.py <檔案> [--show 欄名,欄名]

--show 會逐列印出指定欄的值（例如 --show 組別,姓名,最終成績（採用））；不給就只印摘要。
XLSX 另外保留每一格的型別與公式：「學號」欄（或 --text-cols 指定的欄）只要有一格不是文字（數字、公式、布林），
就印出是哪幾格，最後一行寫「判定：不通過」並以 1 結束。CSV 的學號欄若不是純數字字串（例如 4.11E+08）也一樣。
只用標準函式庫；不改檔案、不連網。
"""
import csv
import io
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
# UTF-8 被當 Big5／cp1252 讀錯後常見的字：出現就算有亂碼跡象。
MOJIBAKE = re.compile("[�]|Ã.|Â.|å[\x80-\xbf]|ç[\x80-\xbf]|è[\x80-\xbf]|é[\x80-\xbf]|銝|蝯|撠|璅")


# 一定要是文字的欄（學號被當成數字，Excel 會吃掉前導零或改成科學記號）。
TEXT_COLS = ["學號"]
STUDENT_NO = re.compile(r"^[A-Za-z0-9]{1,20}$")


def read_csv(data: bytes):
    bom = data.startswith(b"\xef\xbb\xbf")
    try:
        text = data.decode("utf-8-sig")
        utf8 = True
    except UnicodeDecodeError:
        text = data.decode("utf-8-sig", errors="replace")
        utf8 = False
    crlf = b"\r\n" in data
    rows = list(csv.reader(io.StringIO(text, newline="")))
    # CSV 本身沒有型別：每格都是文字，型別欄一律記 "str"。
    return {"格式": "CSV", "BOM": bom, "UTF-8": utf8, "CRLF 行尾": crlf}, rows, [["str"] * len(r) for r in rows]


def read_xlsx(path: str):
    with zipfile.ZipFile(path) as z:
        sheet = ET.fromstring(z.read("xl/worksheets/sheet1.xml"))
        shared = []
        if "xl/sharedStrings.xml" in z.namelist():
            for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", NS):
                shared.append("".join(t.text or "" for t in si.iter(f"{{{NS['m']}}}t")))
    rows, kinds = [], []
    for r in sheet.iter(f"{{{NS['m']}}}row"):
        cells, types = [], []
        for c in r.findall("m:c", NS):
            ref = c.get("r", "")
            col = 0
            for ch in re.match(r"[A-Z]*", ref).group(0):
                col = col * 26 + (ord(ch) - 64)
            while col and len(cells) < col - 1:
                cells.append("")
                types.append("empty")
            kind = c.get("t")
            formula = c.find("m:f", NS)
            if kind == "inlineStr":
                value, typ = "".join(t.text or "" for t in c.iter(f"{{{NS['m']}}}t")), "str"
            elif kind == "s":
                v = c.find("m:v", NS)
                value, typ = (shared[int(v.text)] if v is not None else ""), "str"
            else:
                v = c.find("m:v", NS)
                value = v.text if v is not None and v.text else ""
                # 沒寫 t 或 t="n"＝數字；b＝布林；str＝公式算出的字串；e＝錯誤
                typ = {None: "number", "n": "number", "b": "bool", "str": "formula-str", "e": "error"}.get(kind, kind)
            if formula is not None:
                typ = f"formula({typ})"
                value = value or "=" + (formula.text or "")
            cells.append(value)
            types.append(typ)
        rows.append(cells)
        kinds.append(types)
    return {"格式": "XLSX", "工作表": "sheet1"}, rows, kinds


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    path = argv[1]
    show = []
    if "--show" in argv:
        show = [s for s in argv[argv.index("--show") + 1].split(",") if s]
    text_cols = TEXT_COLS
    if "--text-cols" in argv:
        text_cols = [s for s in argv[argv.index("--text-cols") + 1].split(",") if s]
    with open(path, "rb") as f:
        head = f.read(4)
    if head.startswith(b"PK"):
        meta, rows, kinds = read_xlsx(path)
    else:
        with open(path, "rb") as f:
            meta, rows, kinds = read_csv(f.read())
    keep = [i for i, r in enumerate(rows) if any(cell.strip() for cell in r)]
    rows, kinds = [rows[i] for i in keep], [kinds[i] for i in keep]
    header = rows[0] if rows else []
    body, body_kinds = rows[1:], kinds[1:]
    # 文字欄檢查：XLSX 看儲存格型別（數字、公式都算錯）；CSV 看值長得像不像學號（4.11E+08 這種就錯）。
    bad_text = []
    for name in text_cols:
        if name not in header:
            continue
        ci = header.index(name)
        for ri, (r, k) in enumerate(zip(body, body_kinds)):
            value = r[ci] if ci < len(r) else ""
            typ = k[ci] if ci < len(k) else "empty"
            if not value.strip():
                continue
            if typ != "str" or not STUDENT_NO.match(value.strip()):
                bad_text.append(f"{name} 第 {ri + 2} 行＝{value}（{typ}）")
    widths = sorted({len(r) for r in body})
    garbled = [i + 2 for i, r in enumerate(body) if any(MOJIBAKE.search(cell) for cell in r)]
    if any(MOJIBAKE.search(cell) for cell in header):
        garbled.insert(0, 1)

    print(f"檔案：{path.rsplit('/', 1)[-1]}")
    for k, v in meta.items():
        print(f"{k}：{'是' if v is True else '否' if v is False else v}")
    print(f"欄數：{len(header)}")
    print("欄名：" + "｜".join(header))
    print(f"資料筆數（不含表頭）：{len(body)}")
    print(f"每列欄數：{'、'.join(map(str, widths)) or '—'}（和欄數不同＝有列多或少欄）")
    print(f"亂碼跡象：{'第 ' + '、'.join(map(str, garbled)) + ' 行' if garbled else '沒有'}")
    checked = [n for n in text_cols if n in header]
    if checked:
        print(f"文字欄（{'、'.join(checked)}）不是文字的格：{'；'.join(bad_text) if bad_text else '沒有'}")
    if show:
        missing = [s for s in show if s not in header]
        if missing:
            print("找不到這些欄：" + "、".join(missing))
        idx = [header.index(s) for s in show if s in header]
        print("── " + "｜".join(header[i] for i in idx))
        for r in body:
            print("｜".join(r[i] if i < len(r) else "" for i in idx))
    if bad_text:
        print("判定：不通過（學號等文字欄有數字、公式或不像學號的值）")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
