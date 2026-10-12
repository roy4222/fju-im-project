#!/usr/bin/env python3
"""打開一個匯出檔（CSV 或 XLSX），印出核對要用的事實：格式、BOM、UTF-8、欄名、筆數、亂碼跡象。

用法（劇本第 6 章；用 -I 跑，不從下載目錄載入任何模組）：
  python3 -I <repo>/e2e/acceptance/fixtures/inspect-export.py <檔案> [--show 欄名,欄名]

--show 會逐列印出指定欄的值（例如 --show 組別,姓名,最終成績（採用））；不給就只印摘要。
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
    return {"格式": "CSV", "BOM": bom, "UTF-8": utf8, "CRLF 行尾": crlf}, rows


def read_xlsx(path: str):
    with zipfile.ZipFile(path) as z:
        sheet = ET.fromstring(z.read("xl/worksheets/sheet1.xml"))
        shared = []
        if "xl/sharedStrings.xml" in z.namelist():
            for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", NS):
                shared.append("".join(t.text or "" for t in si.iter(f"{{{NS['m']}}}t")))
    rows = []
    for r in sheet.iter(f"{{{NS['m']}}}row"):
        cells = []
        for c in r.findall("m:c", NS):
            ref = c.get("r", "")
            col = 0
            for ch in re.match(r"[A-Z]*", ref).group(0):
                col = col * 26 + (ord(ch) - 64)
            while col and len(cells) < col - 1:
                cells.append("")
            kind = c.get("t")
            if kind == "inlineStr":
                value = "".join(t.text or "" for t in c.iter(f"{{{NS['m']}}}t"))
            elif kind == "s":
                v = c.find("m:v", NS)
                value = shared[int(v.text)] if v is not None else ""
            else:
                v = c.find("m:v", NS)
                value = v.text if v is not None and v.text else ""
            cells.append(value)
        rows.append(cells)
    return {"格式": "XLSX", "工作表": "sheet1"}, rows


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    path = argv[1]
    show = []
    if "--show" in argv:
        show = [s for s in argv[argv.index("--show") + 1].split(",") if s]
    with open(path, "rb") as f:
        head = f.read(4)
    if head.startswith(b"PK"):
        meta, rows = read_xlsx(path)
    else:
        with open(path, "rb") as f:
            meta, rows = read_csv(f.read())
    rows = [r for r in rows if any(cell.strip() for cell in r)]
    header = rows[0] if rows else []
    body = rows[1:]
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
    if show:
        missing = [s for s in show if s not in header]
        if missing:
            print("找不到這些欄：" + "、".join(missing))
        idx = [header.index(s) for s in show if s in header]
        print("── " + "｜".join(header[i] for i in idx))
        for r in body:
            print("｜".join(r[i] if i < len(r) else "" for i in idx))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
