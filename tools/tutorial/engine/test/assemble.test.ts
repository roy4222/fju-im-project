import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assemble, featureTimeline, parseFeatureTable, parseRefs, placeChapters, timecode, YT_DESCRIPTION_MAX, youtubeDescription } from '../assemble.ts';
import type { ChapterMeta } from '../render.ts';

const meta = (n: number, label: string, file: string, steps: [number, string, string?][]): ChapterMeta => ({
  label: `${n}｜${label}`,
  number: n,
  chapter: label,
  file,
  durationMs: 0,
  titleMs: 2500,
  steps: steps.map(([startMs, caption, status], i) => ({ index: i + 1, startMs, caption, status })),
});

test('timecode：m:ss 與 h:mm:ss', () => {
  assert.equal(timecode(0), '0:00');
  assert.equal(timecode(65_900), '1:05');
  assert.equal(timecode(3_723_000), '1:02:03');
});

const TABLE_HEAD = '| F 編號 | 角色 | 模組 | 功能 | 章節與步驟 | 狀態 | 依據 | 備註 | Roy |\n|---|---|---|---|---|---|---|---|---|\n';
const row = (f: string, fn: string, ref: string, st = '✅') => `| ${f} | 學生 | 作業 | ${fn} | ${ref} | ${st} | | | |\n`;

/** 說明欄「章節」段落裡的時間碼行。 */
function chapterLines(text: string): { sec: number; line: string }[] {
  return text
    .split('\n')
    .map((line) => ({ line, m: line.match(/^(?:(\d+):)?(\d+):(\d{2}) /) }))
    .filter((x) => x.m)
    .map(({ line, m }) => ({ line, sec: Number(m![1] ?? 0) * 3600 + Number(m![2]) * 60 + Number(m![3]) }));
}

function assertYoutubeRules(text: string) {
  const lines = chapterLines(text);
  assert.ok(lines.length >= 1);
  assert.equal(lines[0].sec, 0, '第一行 0:00');
  assert.ok(lines[0].line.startsWith('0:00 '));
  for (let i = 1; i < lines.length; i++) {
    assert.ok(lines[i].sec > lines[i - 1].sec, `時間碼遞增：${lines[i - 1].line} → ${lines[i].line}`);
    assert.ok(lines[i].sec - lines[i - 1].sec >= 10, `間隔 ≥ 10 秒：${lines[i - 1].line} → ${lines[i].line}`);
  }
  assert.ok([...text].length < YT_DESCRIPTION_MAX, `總字數 ${[...text].length}`);
}

test('youtubeDescription：簡介佔位、圖例、每段一行列出功能，不放每一步的時間碼', () => {
  const placed = placeChapters(
    [
      meta(1, '訪客前台', 'a.mp4', [[2700, '首頁', 'ok'], [9000, '公告']]),
      meta(2, '學生｜登入', 'b.mp4', [[2700, '輸入帳號']]),
      meta(3, '學生｜繳交作業', 'c.mp4', [[2700, '上傳'], [9000, '送出'], [15000, '補交']]),
    ],
    [72_000, 45_000, 80_000],
  );
  const features = parseFeatureTable(TABLE_HEAD + row('F01', '看公告', '1-2') + row('F05', '上傳檔案', '3-1') + row('F06', '送出', '3-2') + row('F07', '看版本', '3-2') + row('F08', '補交', '3-3', '⚠️'));
  const { text } = youtubeDescription(placed, features);
  assert.ok(text.startsWith('{{INTRO}}\n'));
  for (const icon of ['✅', '⚠️', '❌', '🟡']) assert.ok(text.split('\n').some((l) => l.startsWith(icon)), `圖例 ${icon}`);
  const lines = chapterLines(text);
  assert.deepEqual(lines.map((l) => l.line), ['0:00 訪客前台：看公告', '1:12 學生｜登入：輸入帳號', '1:57 學生｜繳交作業：上傳檔案、送出、看版本、補交']);
  assertYoutubeRules(text);
});

test('youtubeDescription：不足 10 秒的段併到下一段，最後一段太短就併到前一段', () => {
  const placed = placeChapters(
    [meta(1, '甲', 'a.mp4', [[0, 'a']]), meta(2, '乙', 'b.mp4', [[0, 'b']]), meta(3, '丙', 'c.mp4', [[0, 'c']]), meta(4, '丁', 'd.mp4', [[0, 'd']])],
    [6_000, 30_000, 4_000, 30_000],
  );
  const { text, warnings } = youtubeDescription(placed, null);
  assert.deepEqual(chapterLines(text).map((l) => l.line), ['0:00 甲／乙：a、b', '0:36 丙／丁：c、d']);
  assertYoutubeRules(text);
  assert.ok(warnings.some((w) => w.includes('合併')));
});

test('youtubeDescription：功能清單超過 90 字截斷加「…」，總字數超過上限時再縮短', () => {
  const names = Array.from({ length: 40 }, (_, i) => `很長的功能名稱第${i + 1}項`);
  const chapters = Array.from({ length: 60 }, (_, i) => meta(i + 1, `第${i + 1}章｜某角色｜某模組`, 'x.mp4', [[0, 'x']]));
  const placed = placeChapters(chapters, chapters.map(() => 25_000));
  const md = TABLE_HEAD + chapters.flatMap((c) => names.map((n, j) => row(`F${c.number}-${j}`, n, `${c.number}-1`))).join('');
  const { text, warnings } = youtubeDescription(placed, parseFeatureTable(md));
  const first = chapterLines(text)[0].line;
  const list = first.slice(first.indexOf('：') + 1);
  assert.ok(list.endsWith('…'), first);
  assert.ok([...list].length <= 91, `${[...list].length}`);
  assertYoutubeRules(text);
  assert.equal(chapterLines(text).length, 60);
  assert.ok(warnings.some((w) => w.includes('字數')));
});

test('featureTimeline：每個 F 編號一行，時間碼＋youtu.be 連結（秒數取整）', () => {
  const placed = placeChapters([meta(1, '訪客前台', 'a.mp4', [[2500, '首頁'], [6400, '公告']]), meta(3, '學生｜繳交作業', 'b.mp4', [[2500, '上傳']])], [72_000, 40_000]);
  const md = featureTimeline(placed, parseFeatureTable(TABLE_HEAD + row('F01', '看公告', '1-2') + row('F07', '繳交', '3-1、1-1', '⚠️') + row('F09', '打分', '9-9', '🟡')));
  const lines = md.split('\n').filter((l) => l.startsWith('- '));
  assert.equal(lines.length, 3);
  assert.equal(lines[0], '- F01｜學生｜作業｜看公告 ✅ — [0:06](https://youtu.be/{{VIDEO_ID}}?t=6)');
  assert.equal(lines[1], '- F07｜學生｜作業｜繳交 ⚠️ — [1:14](https://youtu.be/{{VIDEO_ID}}?t=74) [0:02](https://youtu.be/{{VIDEO_ID}}?t=2)');
  assert.ok(lines[2].startsWith('- F09｜') && lines[2].includes('影片中沒有示範'));
});

test('parseRefs：各種「章節與步驟」寫法', () => {
  assert.deepEqual(parseRefs('3-2'), [{ chapter: 3, step: 2 }]);
  assert.deepEqual(parseRefs('3.2、3.4'), [{ chapter: 3, step: 2 }, { chapter: 3, step: 4 }]);
  assert.deepEqual(parseRefs('第 3 章步驟 5'), [{ chapter: 3, step: 5 }]);
  assert.deepEqual(parseRefs('3｜7'), [{ chapter: 3, step: 7 }]);
  assert.deepEqual(parseRefs('4'), [{ chapter: 4 }]);
  assert.deepEqual(parseRefs('—'), []);
});

test('parseFeatureTable：讀表頭、略過分隔列', () => {
  const md = `# 功能表\n\n| F 編號 | 角色 | 模組 | 功能 | 章節與步驟 | 狀態 | 依據 | 備註 | Roy |\n|---|---|---|---|---|---|---|---|---|\n| F01 | 訪客 | 前台 | 看公告 | 1-3 | ✅ | §3 | | |\n| F02 | 學生 | 作業 | 繳交 | 3-2、3-4 | ⚠️ | §7 | 待修 | |\n`;
  const { headers, rows } = parseFeatureTable(md);
  assert.equal(headers.length, 9);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].cells['功能'], '繳交');
  assert.deepEqual(rows[1].refs, [{ chapter: 3, step: 2 }, { chapter: 3, step: 4 }]);
});

test('assemble：接成一部、章節時間照實際長度、index.html 填入功能時間碼', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tutorial-asm-'));
  try {
    const mk = (name: string, sec: number, color: string) => {
      const f = join(dir, name);
      execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=320x180:r=30:d=${sec}`, '-f', 'lavfi', '-i', `sine=f=300:d=${sec}`,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-shortest', f]);
      return f;
    };
    const a = meta(1, '訪客前台', mk('a.mp4', 12, 'red'), [[2500, '首頁'], [6000, '公告']]);
    const b = meta(3, '學生｜繳交作業', mk('b.mp4', 11, 'blue'), [[2500, '打開作業頁', 'warn']]);
    writeFileSync(join(dir, 'a.json'), JSON.stringify(a));
    writeFileSync(join(dir, 'b.json'), JSON.stringify(b));
    writeFileSync(join(dir, 'features.md'), `| F 編號 | 角色 | 模組 | 功能 | 章節與步驟 | 狀態 | 依據 | 備註 | Roy |\n|---|---|---|---|---|---|---|---|---|\n| F01 | 訪客 | 前台 | 看公告 | 1-2 | ✅ | | | |\n| F07 | 學生 | 作業 | 繳交 | 3-1 | ⚠️ | | | |\n| F09 | 老師 | 評分 | 打分 | 9-9 | 🟡 | | | |\n`);
    const out = join(dir, 'out');
    const r = await assemble({ chapters: [join(dir, 'a.json'), join(dir, 'b.json')], outDir: out, featureTable: join(dir, 'features.md') });

    const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', r.final]).toString());
    assert.ok(Math.abs(dur - 23) < 0.15, `final ${dur}s`);
    const desc = readFileSync(r.description, 'utf8');
    assert.deepEqual(chapterLines(desc).map((l) => l.line), ['0:00 訪客前台：看公告', '0:12 學生｜繳交作業：繳交']);
    assertYoutubeRules(desc);
    const ft = readFileSync(r.featureTimeline, 'utf8');
    assert.ok(ft.includes('- F07｜學生｜作業｜繳交 ⚠️ — [0:14](https://youtu.be/{{VIDEO_ID}}?t=14)'), ft);
    const html = readFileSync(r.html, 'utf8');
    assert.ok(html.includes('data-t="6.00">0:06</a></td><td>F01'), 'F01 → 1-2 = 0:06');
    assert.ok(html.includes('data-t="14.50">0:14</a></td><td>F07'), 'F07 → 3-1 = 12 + 2.5 秒');
    assert.ok(r.warnings.some((w) => w.startsWith('F09')), r.warnings.join('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
