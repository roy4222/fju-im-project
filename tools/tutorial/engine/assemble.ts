// 組裝：多章 mp4 接成 final.mp4，並產生 YouTube 章節／詳細時間軸與可點的 index.html。

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { STATUS_ICON, type StatusKind } from './events.ts';
import type { ChapterMeta } from './render.ts';
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
    const placed = { ...c, offsetMs: t };
    t += durations[i];
    return placed;
  });
}

/** YouTube 說明欄文字：第一段是章節（第一行 0:00），第二段是每個步驟的詳細時間軸。 */
export function youtubeChapters(placed: readonly PlacedChapter[]): { text: string; warnings: string[] } {
  const warnings: string[] = [];
  const lines = placed.map((c) => `${timecode(c.offsetMs)} ${c.label}`);
  placed.forEach((c, i) => {
    const end = i + 1 < placed.length ? placed[i + 1].offsetMs : c.offsetMs + c.durationMs;
    if (end - c.offsetMs < YT_MIN_CHAPTER_MS) warnings.push(`「${c.label}」只有 ${((end - c.offsetMs) / 1000).toFixed(1)} 秒，YouTube 章節至少 10 秒`);
  });
  if (placed.length < 3) warnings.push(`只有 ${placed.length} 章：YouTube 至少要 3 個章節才會顯示章節列`);
  const detail: string[] = [];
  for (const c of placed) {
    detail.push('', `【${c.label}】`);
    for (const s of c.steps) {
      const icon = s.status ? ` ${STATUS_ICON[s.status as StatusKind] ?? ''}` : '';
      detail.push(`${timecode(c.offsetMs + s.startMs)} ${c.number != null ? `${c.number}-${s.index}` : s.index} ${s.caption}${icon}`);
    }
  }
  return { text: [...lines, '', '— 詳細時間軸 —', ...detail, ''].join('\n'), warnings };
}

// ── feature-table.md ─────────────────────────────────

export type FeatureRow = { cells: Record<string, string>; refs: { chapter: number; step?: number }[] };

/**
 * 讀 Markdown 表格。欄名照架構師的表（F 編號、角色、模組、功能、章節與步驟、狀態、依據、備註、Roy），
 * 「章節與步驟」接受 3-2、3.2、3｜2、第 3 章步驟 2、3（只有章）與用頓號／逗號分隔的多筆。
 */
export function parseFeatureTable(md: string): { headers: string[]; rows: FeatureRow[] } {
  const tableLines = md.split('\n').filter((l) => /^\s*\|.*\|\s*$/.test(l));
  if (tableLines.length < 2) return { headers: [], rows: [] };
  const split = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const headers = split(tableLines[0]);
  const refCol = headers.find((h) => h.includes('章節')) ?? '';
  const rows: FeatureRow[] = [];
  for (const l of tableLines.slice(1)) {
    const cells = split(l);
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    const rec: Record<string, string> = {};
    headers.forEach((h, i) => (rec[h] = cells[i] ?? ''));
    rows.push({ cells: rec, refs: parseRefs(rec[refCol] ?? '') });
  }
  return { headers, rows };
}

export function parseRefs(s: string): { chapter: number; step?: number }[] {
  const out: { chapter: number; step?: number }[] = [];
  for (const part of s.split(/[、,，;；/]+|\s{2,}/)) {
    const p = part.trim();
    if (!p) continue;
    const pair = p.match(/(\d+)\s*(?:[-.．｜|:：]|章\s*(?:步驟|第)?)\s*(?:步驟\s*)?(\d+)/);
    if (pair) out.push({ chapter: Number(pair[1]), step: Number(pair[2]) });
    else {
      const ch = p.match(/(\d+)/);
      if (ch) out.push({ chapter: Number(ch[1]) });
    }
  }
  return out;
}

export function refTime(placed: readonly PlacedChapter[], ref: { chapter: number; step?: number }): number | undefined {
  const c = placed.find((x) => x.number === ref.chapter);
  if (!c) return undefined;
  if (ref.step == null) return c.offsetMs;
  const s = c.steps.find((x) => x.index === ref.step);
  return s ? c.offsetMs + s.startMs : undefined;
}

// ── index.html ───────────────────────────────────────

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function indexHtml(placed: readonly PlacedChapter[], features: ReturnType<typeof parseFeatureTable> | null, video = 'final.mp4'): string {
  const jump = (ms: number, label: string) => `<a href="#t=${Math.floor(ms / 1000)}" data-t="${(ms / 1000).toFixed(2)}">${esc(label)}</a>`;
  const chapters = placed
    .map(
      (c) => `<li class="ch" data-start="${(c.offsetMs / 1000).toFixed(2)}"><div class="chh">${jump(c.offsetMs, timecode(c.offsetMs))} <b>${esc(c.label)}</b></div><ol>${c.steps
        .map((s) => `<li>${jump(c.offsetMs + s.startMs, timecode(c.offsetMs + s.startMs))} ${esc(s.caption)}${s.status ? ` ${STATUS_ICON[s.status as StatusKind] ?? ''}` : ''}</li>`)
        .join('')}</ol></li>`,
    )
    .join('');
  let featureBlock = '';
  if (features && features.rows.length) {
    const show = features.headers.filter((h) => /F|角色|模組|功能|狀態/.test(h) && !h.includes('章節'));
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

// ── 主流程 ───────────────────────────────────────────

export type AssembleOptions = {
  /** 每章的資料夾（裡面有 render 產生的 chapter.json）或 chapter.json 路徑，依播放順序。 */
  chapters: string[];
  outDir: string;
  /** feature-table.md；不存在就略過功能清單。 */
  featureTable?: string;
};

export async function assemble(opts: AssembleOptions): Promise<{ final: string; chaptersTxt: string; html: string; warnings: string[] }> {
  const outDir = resolve(opts.outDir);
  mkdirSync(outDir, { recursive: true });
  const metas = opts.chapters.map((p) => {
    const f = p.endsWith('.json') ? p : join(p, 'chapter.json');
    if (!existsSync(f)) throw new Error(`找不到 ${f}：先 render 這一章`);
    const m = JSON.parse(readFileSync(f, 'utf8')) as ChapterMeta;
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

  const { text, warnings } = youtubeChapters(placed);
  const chaptersTxt = join(outDir, 'youtube-chapters.txt');
  writeFileSync(chaptersTxt, text);

  const features = opts.featureTable && existsSync(opts.featureTable) ? parseFeatureTable(readFileSync(opts.featureTable, 'utf8')) : null;
  if (opts.featureTable && !features) warnings.push(`找不到 ${opts.featureTable}，index.html 不含功能清單`);
  if (features) {
    for (const r of features.rows) {
      const id = Object.values(r.cells)[0];
      if (r.refs.length && r.refs.every((ref) => refTime(placed, ref) == null)) warnings.push(`${id}：章節與步驟「${r.refs.map((x) => `${x.chapter}-${x.step ?? ''}`).join('、')}」對不到影片`);
    }
  }
  const html = join(outDir, 'index.html');
  writeFileSync(html, indexHtml(placed, features, basename(final)));
  writeFileSync(join(outDir, 'timeline.json'), JSON.stringify(placed, null, 2));
  return { final, chaptersTxt, html, warnings };
}
