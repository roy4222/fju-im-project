// 組裝：多章 mp4 接成 final.mp4，並產生 YouTube 說明欄、功能時間軸與可點的 index.html。

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { statusLabel, type ChapterEvents, type StatusKind } from './events.ts';
import { chapterMeta, type ChapterMeta, type ChapterMetaStep } from './render.ts';
import { buildCues, toSrt, toVtt, type Cue } from './subtitles.ts';
import { probeDurationMs } from './tts.ts';

const run = promisify(execFile);

/** YouTube 章節最短 10 秒。 */
export const YT_MIN_CHAPTER_MS = 10_000;

export type PlacedChapter = ChapterMeta & { offsetMs: number };

/** 秒數 → YouTube 時間碼（0:05、12:34、1:02:03）。 */
export function timecode(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** 依實際檔案長度排出每章在成品中的起點。 */
export function placeChapters(chapters: readonly ChapterMeta[], durations: readonly number[]): PlacedChapter[] {
  let t = 0;
  return chapters.map((c, i) => {
    const placed = { ...c, durationMs: durations[i], offsetMs: t };
    t += durations[i];
    return placed;
  });
}

/** YouTube 說明欄上限 5000 字，留點空間給 Roy 填的簡介。 */
export const YT_DESCRIPTION_MAX = 4500;
/** 每段功能清單最多幾個字（超過截斷加「…」）。 */
export const YT_FEATURE_LIST_MAX = 90;

export const LEGEND = [
  '✅ 已完成：可以正常使用',
  '⚠️ 部分完成：能用，但有已知限制或待補',
  '❌ 未完成：尚未實作或無法使用',
  '🟡 待確認：規格或做法還在討論',
];

type Segment = { startMs: number; endMs: number; names: string[]; items: string[] };

const cut = (s: string, max: number) => ([...s].length <= max ? s : max <= 0 ? '' : `${[...s].slice(0, max).join('')}…`);

/** 一章涵蓋的功能名稱：feature-table 裡指到這章的列（依影片時間排），沒有就用步驟字幕。 */
function chapterItems(c: PlacedChapter, features: FeatureTable | null): string[] {
  const fnCol = (features && headerOf(features.headers, /功能/)) ?? '';
  const hits: { t: number; order: number; name: string }[] = [];
  features?.rows.forEach((r, order) => {
    for (const ref of r.refs) {
      const t = refTime([c], ref);
      if (t != null && r.cells[fnCol]) hits.push({ t, order, name: r.cells[fnCol] });
    }
  });
  hits.sort((a, b) => a.t - b.t || a.order - b.order);
  const names = [...new Set(hits.map((h) => h.name))];
  return names.length ? names : c.steps.map((s) => s.caption);
}

/**
 * YouTube 說明欄：簡介佔位＋圖例＋章節時間軸（每段一行，冒號後是這段涵蓋的功能）。
 * YouTube 規則：第一行 0:00、時間碼遞增、每段 ≥ 10 秒；不放每一步的時間碼（會讓章節列消失）。
 */
export function youtubeDescription(placed: readonly PlacedChapter[], features: FeatureTable | null): { text: string; warnings: string[] } {
  const warnings: string[] = [];
  let segs: Segment[] = placed.map((c, i) => ({
    startMs: c.offsetMs,
    endMs: i + 1 < placed.length ? placed[i + 1].offsetMs : c.offsetMs + c.durationMs,
    names: [c.chapter],
    items: chapterItems(c, features),
  }));
  // 不足 10 秒的段併到下一段（最後一段併到前一段）
  for (let i = 0; i < segs.length && segs.length > 1; ) {
    const s = segs[i];
    if (s.endMs - s.startMs >= YT_MIN_CHAPTER_MS) {
      i++;
      continue;
    }
    const j = i + 1 < segs.length ? i + 1 : i - 1;
    const [a, b] = j > i ? [s, segs[j]] : [segs[j], s];
    warnings.push(`「${s.names.join('／')}」只有 ${((s.endMs - s.startMs) / 1000).toFixed(1)} 秒，已合併到相鄰章節（YouTube 章節至少 10 秒）`);
    const merged: Segment = { startMs: a.startMs, endMs: b.endMs, names: [...a.names, ...b.names], items: [...new Set([...a.items, ...b.items])] };
    segs = [...segs.slice(0, Math.min(i, j)), merged, ...segs.slice(Math.max(i, j) + 1)];
    i = Math.min(i, j);
  }
  if (segs.length < 3) warnings.push(`只有 ${segs.length} 段：YouTube 至少要 3 個章節才會顯示章節列`);

  const build = (max: number) =>
    [
      '{{INTRO}}',
      '',
      '圖例',
      ...LEGEND,
      '',
      '章節',
      ...segs.map((s) => {
        const list = cut(s.items.join('、'), max);
        return `${timecode(s.startMs)} ${s.names.join('／')}${list ? `：${list}` : ''}`;
      }),
      '',
      '每個功能的詳細時間點：見影片頁面附的功能時間軸。',
      '',
    ].join('\n');
  let max = YT_FEATURE_LIST_MAX;
  let text = build(max);
  while ([...text].length >= YT_DESCRIPTION_MAX && max > 0) {
    max = Math.max(0, max - 10);
    text = build(max);
  }
  if (max < YT_FEATURE_LIST_MAX) warnings.push(`說明欄字數超過 ${YT_DESCRIPTION_MAX}，每段功能清單縮到 ${max} 字`);
  if ([...text].length >= YT_DESCRIPTION_MAX) warnings.push(`說明欄仍有 ${[...text].length} 字，超過 ${YT_DESCRIPTION_MAX}`);
  return { text, warnings };
}

/** 每個 F 編號一行：時間碼＋youtu.be 連結（上傳後把 {{VIDEO_ID}} 換成影片 ID）。 */
export function featureTimeline(placed: readonly PlacedChapter[], features: FeatureTable | null): string {
  const link = (ms: number) => `[${timecode(ms)}](https://youtu.be/{{VIDEO_ID}}?t=${Math.floor(ms / 1000)})`;
  const out = ['# 功能時間軸', '', '上傳後把 `{{VIDEO_ID}}` 換成 YouTube 影片 ID。', ''];
  if (features && features.rows.length) {
    const h = features.headers;
    const col = (re: RegExp) => headerOf(h, re, /章節|時間碼/);
    const [idCol, roleCol, modCol, fnCol, stCol] = [col(/編號/), col(/角色/), col(/模組/), col(/功能/), col(/狀態/)];
    for (const r of features.rows) {
      const name = [idCol, roleCol, modCol, fnCol].map((c) => (c ? r.cells[c] : '')).filter(Boolean).join('｜');
      const st = stCol && r.cells[stCol] ? ` ${r.cells[stCol]}` : '';
      const times = r.refs.map((ref) => refTime(placed, ref)).filter((t): t is number => t != null);
      out.push(`- ${name}${st} — ${times.length ? times.map(link).join(' ') : '（影片中沒有示範）'}`);
    }
  } else {
    out.push('（沒有 feature-table.md，改列每個步驟）', '');
    for (const c of placed) for (const s of c.steps) out.push(`- ${c.number != null ? `${c.number}-${s.index}` : s.index} ${s.caption} — ${link(c.offsetMs + s.startMs)}`);
  }
  const statuses = stepStatusLines(placed);
  if (statuses.length) out.push('', '## 各步驟狀態與依據', '', '影片右上角只顯示圖示＋白話；依據只記在這裡與 index.html。', '', ...statuses);
  return `${out.join('\n')}\n`;
}

// ── feature-table.md ─────────────────────────────────

/** 「章節與步驟」的一個參照：段編號（例如 1-1、5A-2）＋步驟；兩段式（3-2）另記 whole 以便優先當段編號。 */
export type FeatureRef = { section: string; step?: number; whole?: string };
export type FeatureRow = { line: number; cells: Record<string, string>; refs: FeatureRef[] };
export type FeatureTable = { headers: string[]; rows: FeatureRow[] };

/** 功能表必要的表頭（含這些字的欄）；其他表格（例如圖例）略過。 */
const REQUIRED_HEADERS: [string, RegExp][] = [
  ['編號', /編號/],
  ['功能', /功能/],
  ['章節與步驟', /章節/],
];

export const headerOf = (headers: readonly string[], re: RegExp, not?: RegExp) => headers.find((h) => re.test(h) && !(not && not.test(h)));

/** 拆一列 Markdown 表格：`\|` 是儲存格裡的直線，不是分欄。 */
export function splitRow(line: string): string[] {
  const t = line.trim().replace(/^\|/, '');
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '\\' && t[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (t[i] === '|') {
      cells.push(cur.trim());
      cur = '';
    } else cur += t[i];
  }
  if (cur.trim()) cells.push(cur.trim());
  return cells;
}

/**
 * 讀 feature-table.md：只認表頭含「編號」「功能」「章節與步驟」的表格（可以分好幾塊、表頭要一樣），
 * 每列欄數必須跟表頭一樣，不一樣就報錯並指出第幾行。
 */
export function parseFeatureTable(md: string): FeatureTable {
  const lines = md.split('\n');
  let headers: string[] | null = null;
  const rows: FeatureRow[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\|/.test(lines[i])) continue;
    // 一塊表格：連續的 | 開頭行
    const start = i;
    while (i + 1 < lines.length && /^\s*\|/.test(lines[i + 1])) i++;
    const block = lines.slice(start, i + 1);
    const head = splitRow(block[0]);
    const isSep = block.length > 1 && splitRow(block[1]).every((c) => /^:?-+:?$/.test(c));
    if (!isSep || !REQUIRED_HEADERS.every(([, re]) => headerOf(head, re))) continue;
    if (headers && headers.join('|') !== head.join('|')) {
      throw new Error(`feature-table 第 ${start + 1} 行：這塊功能表的表頭跟前面不一樣（${head.join('｜')}）`);
    }
    headers = head;
    const refCol = headerOf(head, /章節/)!;
    block.slice(2).forEach((l, k) => {
      const lineNo = start + 3 + k;
      const cells = splitRow(l);
      if (cells.length !== head.length) {
        throw new Error(`feature-table 第 ${lineNo} 行有 ${cells.length} 欄，表頭有 ${head.length} 欄（儲存格裡的直線請寫成 \\|）：${l.trim()}`);
      }
      const rec: Record<string, string> = {};
      head.forEach((h, j) => (rec[h] = cells[j]));
      rows.push({ line: lineNo, cells: rec, refs: parseRefs(rec[refCol]) });
    });
  }
  if (!headers) {
    throw new Error(`feature-table 找不到功能表：需要一個表頭含「${REQUIRED_HEADERS.map(([n]) => n).join('」「')}」的 Markdown 表格`);
  }
  return { headers, rows };
}

/**
 * 「章節與步驟」：1-1-3（段 1-1 第 3 步）、5A-2-2～4（範圍）、2-1-10、3-2（段 3-2 或第 3 段第 2 步）、
 * 4（整段）、第 3 章步驟 2；多筆用頓號或逗號分隔；括號裡的備註（例如「5A-2-9（更多選單）」）忽略；「—」等非編號略過。
 */
export function parseRefs(s: string): FeatureRef[] {
  const out: FeatureRef[] = [];
  for (const part of s.split(/[、,，;；/]+|\s{2,}/)) {
    const p = part.replace(/[（(][^）)]*[）)]/g, '').trim().replace(/\s+/g, ''); // 括號裡是備註
    if (!p) continue;
    const zh = p.match(/^第?(\w+)章(?:第)?步驟?(\d+)步?$/);
    if (zh) {
      out.push({ section: zh[1], step: Number(zh[2]) });
      continue;
    }
    const m = p.match(/^([0-9A-Za-z]+(?:[-.．｜|][0-9A-Za-z]+)*?)(?:[～~〜](\d+))?$/);
    if (!m || !/\d/.test(m[1])) continue;
    const comps = m[1].split(/[-.．｜|]/);
    const last = comps.at(-1)!;
    if (comps.length === 1) {
      out.push({ section: comps[0] });
      continue;
    }
    if (!/^\d+$/.test(last)) {
      out.push({ section: comps.join('-') });
      continue;
    }
    const section = comps.slice(0, -1).join('-');
    const from = Number(last);
    const to = m[2] ? Number(m[2]) : from;
    for (let k = from; k <= Math.max(from, to); k++) {
      out.push(comps.length === 2 ? { section, step: k, whole: `${section}-${k}` } : { section, step: k });
    }
  }
  return out;
}

const placedId = (c: PlacedChapter) => c.id ?? (c.number != null ? String(c.number) : undefined);

/** 一步的狀態（新的 chapter.json 是物件，舊的是字串 kind）。 */
export function stepStatus(s: ChapterMetaStep): { kind: StatusKind; say?: string; evidence?: string } | undefined {
  if (!s.status) return undefined;
  return typeof s.status === 'string' ? { kind: s.status } : s.status;
}

/** 「5B-1-2」這種步驟編號（段編號＋步驟序）。 */
const stepId = (c: PlacedChapter, s: ChapterMetaStep) => (placedId(c) != null ? `${placedId(c)}-${s.index}` : String(s.index));

/**
 * feature-timeline.md 的「各步驟狀態與依據」段：畫面上只看得到圖示＋白話，依據（evidence）只在這裡與 index.html。
 */
export function stepStatusLines(placed: readonly PlacedChapter[]): string[] {
  const out: string[] = [];
  for (const c of placed) {
    for (const s of c.steps) {
      const st = stepStatus(s);
      if (!st) continue;
      out.push(`- ${stepId(c, s)} ${s.caption} — ${statusLabel(st)}${st.evidence ? `（依據：${st.evidence}）` : ''}`);
    }
  }
  return out;
}

/** 參照在成品中的時間（ms）；對不到影片回傳 undefined。 */
export function refTime(placed: readonly PlacedChapter[], ref: FeatureRef): number | undefined {
  if (ref.whole) {
    const seg = placed.find((x) => placedId(x) === ref.whole);
    if (seg) return seg.offsetMs;
  }
  const c = placed.find((x) => placedId(x) === ref.section);
  if (!c) return undefined;
  if (ref.step == null) return c.offsetMs;
  const s = c.steps.find((x) => x.index === ref.step);
  return s ? c.offsetMs + s.startMs : undefined;
}

const refLabel = (r: FeatureRef) => (r.step == null ? r.section : `${r.section}-${r.step}`);

/** feature-table 的「時間碼」欄填好的版本（每列取第一個對得到的時間）。 */
export function timedFeatureTable(md: string, placed: readonly PlacedChapter[], table: FeatureTable): string {
  const tcCol = headerOf(table.headers, /時間碼/);
  if (!tcCol) return md;
  const idx = table.headers.indexOf(tcCol);
  const lines = md.split('\n');
  for (const r of table.rows) {
    const t = r.refs.map((ref) => refTime(placed, ref)).find((x) => x != null);
    if (t == null) continue;
    const cells = splitRow(lines[r.line - 1]);
    cells[idx] = timecode(t);
    lines[r.line - 1] = `| ${cells.map((c) => c.replace(/\|/g, '\\|')).join(' | ')} |`;
  }
  return lines.join('\n');
}

// ── index.html ───────────────────────────────────────

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function indexHtml(placed: readonly PlacedChapter[], features: FeatureTable | null, video = 'final.mp4'): string {
  const jump = (ms: number, label: string) => `<a href="#t=${Math.floor(ms / 1000)}" data-t="${(ms / 1000).toFixed(2)}">${esc(label)}</a>`;
  const chapters = placed
    .map(
      (c) => `<li class="ch" data-start="${(c.offsetMs / 1000).toFixed(2)}"><div class="chh">${jump(c.offsetMs, timecode(c.offsetMs))} <b>${esc(c.label)}</b></div><ol>${c.steps
        .map((s) => {
          const st = stepStatus(s);
          const badge = st ? ` <span class="st" title="${esc(statusLabel(st))}">${esc(statusLabel(st))}</span>` : '';
          const evidence = st?.evidence ? `<div class="ev">依據：${esc(st.evidence)}</div>` : '';
          return `<li>${jump(c.offsetMs + s.startMs, timecode(c.offsetMs + s.startMs))} ${esc(s.caption)}${badge}${evidence}</li>`;
        })
        .join('')}</ol></li>`,
    )
    .join('');
  let featureBlock = '';
  if (features && features.rows.length) {
    const show = features.headers.filter((h) => /編號|角色|模組|功能|狀態/.test(h) && !/章節|時間碼/.test(h));
    featureBlock = `<h2>功能清單</h2><table><thead><tr><th>時間</th>${show.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${features.rows
      .map((r) => {
        const times = r.refs.map((ref) => refTime(placed, ref)).filter((t): t is number => t != null);
        const cell = times.length ? times.map((t) => jump(t, timecode(t))).join(' ') : '<span class="none">—</span>';
        return `<tr><td class="tc">${cell}</td>${show.map((h) => `<td>${esc(r.cells[h] ?? '')}</td>`).join('')}</tr>`;
      })
      .join('')}</tbody></table>`;
  }
  return `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>專題平台操作教學</title>
<style>
  :root{--orange:#E56E00;--navy:#14284B}
  *{box-sizing:border-box}
  body{margin:0;font-family:"PingFang TC","Noto Sans TC",system-ui,sans-serif;color:#1f2937;background:#f5f6f8;display:flex;height:100vh}
  main{flex:1;min-width:0;display:flex;align-items:center;justify-content:center;background:#0b1220}
  video{width:100%;max-height:100vh;background:#000}
  aside{width:min(520px,38vw);overflow:auto;padding:20px 22px;background:#fff;border-left:1px solid #e5e7eb}
  h1{font-size:20px;margin:0 0 14px;color:var(--navy)} h2{font-size:17px;margin:26px 0 10px;color:var(--navy)}
  ol,ul{margin:0;padding:0;list-style:none}
  .ch{margin:0 0 12px;padding:8px 10px;border-radius:10px}
  .ch.on{background:#fff4e8;outline:2px solid var(--orange)}
  .chh{font-size:16px} .ch ol{margin:6px 0 0 4px;font-size:14px} .ch ol li{padding:2px 0}
  .st{color:#374151;font-size:13px;margin-left:4px} .ev{color:#6b7280;font-size:12px;margin:1px 0 2px 44px}
  a{color:var(--orange);font-variant-numeric:tabular-nums;text-decoration:none;font-weight:600}
  a:hover{text-decoration:underline}
  table{border-collapse:collapse;font-size:13px;width:100%} th,td{border-bottom:1px solid #eee;padding:5px 6px;text-align:left;vertical-align:top}
  th{background:#f9fafb;position:sticky;top:0} .tc{white-space:nowrap} .none{color:#9ca3af}
</style></head><body>
<main><video id="v" src="${esc(video)}" controls preload="metadata"></video></main>
<aside><h1>章節與步驟</h1><ol>${chapters}</ol>${featureBlock}</aside>
<script>
  const v = document.getElementById('v');
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-t]');
    if (!a) return;
    e.preventDefault();
    v.currentTime = Number(a.dataset.t);
    v.play();
  });
  const chs = [...document.querySelectorAll('.ch')];
  v.addEventListener('timeupdate', () => {
    let cur = null;
    for (const c of chs) if (Number(c.dataset.start) <= v.currentTime + 0.05) cur = c;
    chs.forEach((c) => c.classList.toggle('on', c === cur));
  });
  const m = location.hash.match(/t=(\\d+)/);
  if (m) v.addEventListener('loadedmetadata', () => (v.currentTime = Number(m[1])), { once: true });
</script></body></html>
`;
}

// ── 字幕 ─────────────────────────────────────────────

/** 整片的配音全文字幕：每步配音一則（太長切多則），起訖＝這句在整片的實際起播與結束；標題卡沒有配音、不出字幕。 */
export function finalCues(placed: readonly PlacedChapter[]): Cue[] {
  return buildCues(
    placed.flatMap((c) =>
      c.steps.flatMap((s) => (s.narration && s.audio ? [{ narration: s.narration, startMs: c.offsetMs + s.audio.startMs, endMs: c.offsetMs + s.audio.startMs + s.audio.durationMs }] : [])),
    ),
  );
}

/** 舊的 chapter.json 沒有配音全文：旁邊有 events.json 就從那裡補（錄影時的配音）。 */
function withNarration(m: ChapterMeta, dir: string): ChapterMeta {
  const evFile = join(dir, 'events.json');
  if (m.steps.some((s) => s.narration) || !existsSync(evFile)) return m;
  const ev = JSON.parse(readFileSync(evFile, 'utf8')) as ChapterEvents;
  const byIndex = new Map(chapterMeta(ev, m.titleMs, m.file).steps.map((s) => [s.index, s]));
  return { ...m, steps: m.steps.map((s) => ({ ...s, narration: byIndex.get(s.index)?.narration, audio: byIndex.get(s.index)?.audio })) };
}

// ── 主流程 ───────────────────────────────────────────

export type AssembleOptions = {
  /** 每章的資料夾（裡面有 render 產生的 chapter.json）或 chapter.json 路徑，依播放順序。 */
  chapters: string[];
  outDir: string;
  /** feature-table.md；不存在就略過功能清單。 */
  featureTable?: string;
};

export async function assemble(
  opts: AssembleOptions,
): Promise<{ final: string; description: string; featureTimeline: string; html: string; srt?: string; vtt?: string; warnings: string[] }> {
  const outDir = resolve(opts.outDir);
  mkdirSync(outDir, { recursive: true });
  const metas = opts.chapters.map((p) => {
    const f = p.endsWith('.json') ? p : join(p, 'chapter.json');
    if (!existsSync(f)) throw new Error(`找不到 ${f}：先 render 這一章`);
    const m = withNarration(JSON.parse(readFileSync(f, 'utf8')) as ChapterMeta, dirname(f));
    return { ...m, file: resolve(dirname(f), m.file) };
  });
  // 用實際檔案長度排時間（concat 也是照檔案長度接）
  const durations = await Promise.all(metas.map((m) => probeDurationMs(m.file)));
  const placed = placeChapters(metas, durations);

  const list = join(outDir, 'chapters.ffconcat');
  writeFileSync(list, ['ffconcat version 1.0', ...metas.map((m) => `file '${m.file.replace(/'/g, "'\\''")}'`)].join('\n'));
  const final = join(outDir, 'final.mp4');
  // 影像直接接（每章編碼參數相同）；聲音重新編一次，避免 AAC 前置靜音在章節交界造成空隙
  await run('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', final], {
    maxBuffer: 1 << 24,
  });

  const md = opts.featureTable && existsSync(opts.featureTable) ? readFileSync(opts.featureTable, 'utf8') : null;
  const features = md != null ? parseFeatureTable(md) : null;
  const { text, warnings } = youtubeDescription(placed, features);
  if (opts.featureTable && !features) warnings.push(`找不到 ${opts.featureTable}，說明欄改列步驟字幕、index.html 不含功能清單`);
  const description = join(outDir, 'youtube-description.txt');
  writeFileSync(description, text);
  const featureTimelineFile = join(outDir, 'feature-timeline.md');
  writeFileSync(featureTimelineFile, featureTimeline(placed, features));
  if (features && md != null) {
    const idCol = headerOf(features.headers, /編號/)!;
    const missing = features.rows
      .filter((r) => r.refs.length && r.refs.every((ref) => refTime(placed, ref) == null))
      .map((r) => `${r.cells[idCol]}（${r.refs.map(refLabel).join('、')}）`);
    if (missing.length) warnings.push(`${missing.length} 個功能對不到影片：${missing.slice(0, 10).join('、')}${missing.length > 10 ? '…' : ''}`);
    // 架構師的表有「時間碼」欄：另存一份填好的
    if (headerOf(features.headers, /時間碼/)) writeFileSync(join(outDir, 'feature-table.timed.md'), timedFeatureTable(md, placed, features));
  }
  const html = join(outDir, 'index.html');
  writeFileSync(html, indexHtml(placed, features, basename(final)));
  writeFileSync(join(outDir, 'timeline.json'), JSON.stringify(placed, null, 2));
  const cues = finalCues(placed);
  const silent = placed.filter((c) => !c.steps.some((s) => s.narration && s.audio)).map((c) => c.label);
  if (silent.length) warnings.push(`${silent.length} 段沒有配音全文（chapter.json 是舊版、旁邊也沒有 events.json），字幕裡沒有它們：${silent.slice(0, 10).join('、')}`);
  let srt: string | undefined;
  let vtt: string | undefined;
  if (cues.length) {
    srt = join(outDir, 'final.srt');
    vtt = join(outDir, 'final.vtt');
    writeFileSync(srt, toSrt(cues));
    writeFileSync(vtt, toVtt(cues));
  }
  return { final, description, featureTimeline: featureTimelineFile, html, srt, vtt, warnings };
}
