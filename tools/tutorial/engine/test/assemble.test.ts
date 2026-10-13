import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assemble, featureTimeline, parseFeatureTable, parseRefs, placeChapters, refTime, timecode, timedFeatureTable, YT_DESCRIPTION_MAX, youtubeDescription, type PlacedChapter } from '../assemble.ts';
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

function assertYoutubeRules(text: string, placed: readonly PlacedChapter[]) {
  const lines = chapterLines(text);
  const last = placed.at(-1)!;
  const endSec = (last.offsetMs + last.durationMs) / 1000;
  assert.ok(endSec - lines.at(-1)!.sec >= 10, `最後一個時間碼到片尾 ≥ 10 秒：${lines.at(-1)!.line}，片長 ${endSec} 秒`);
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
  assertYoutubeRules(text, placed);
});

test('youtubeDescription：不足 10 秒的段併到下一段，最後一段太短就併到前一段', () => {
  const placed = placeChapters(
    [meta(1, '甲', 'a.mp4', [[0, 'a']]), meta(2, '乙', 'b.mp4', [[0, 'b']]), meta(3, '丙', 'c.mp4', [[0, 'c']]), meta(4, '丁', 'd.mp4', [[0, 'd']])],
    [6_000, 30_000, 4_000, 30_000],
  );
  const { text, warnings } = youtubeDescription(placed, null);
  assert.deepEqual(chapterLines(text).map((l) => l.line), ['0:00 甲／乙：a、b', '0:36 丙／丁：c、d']);
  assertYoutubeRules(text, placed);
  assert.ok(warnings.some((w) => w.includes('合併')));
  // 最後一段太短：併到前一段，最後一個時間碼到片尾仍 ≥ 10 秒
  const placed2 = placeChapters([meta(1, '甲', 'a.mp4', [[0, 'a']]), meta(2, '乙', 'b.mp4', [[0, 'b']]), meta(3, '丙', 'c.mp4', [[0, 'c']])], [30_000, 30_000, 5_000]);
  const t2 = youtubeDescription(placed2, null).text;
  assert.deepEqual(chapterLines(t2).map((l) => l.line), ['0:00 甲：a', '0:30 乙／丙：b、c']);
  assertYoutubeRules(t2, placed2);
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
  assertYoutubeRules(text, placed);
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

test('parseRefs：分鏡的段編號、範圍、多筆與舊寫法', () => {
  assert.deepEqual(parseRefs('1-1-3～5'), [{ section: '1-1', step: 3 }, { section: '1-1', step: 4 }, { section: '1-1', step: 5 }]);
  assert.deepEqual(parseRefs('5A-2-2～4、5B-4-6'), [
    { section: '5A-2', step: 2 }, { section: '5A-2', step: 3 }, { section: '5A-2', step: 4 }, { section: '5B-4', step: 6 },
  ]);
  assert.deepEqual(parseRefs('2-1-10、2-2-3'), [{ section: '2-1', step: 10 }, { section: '2-2', step: 3 }]);
  assert.deepEqual(parseRefs('3-2'), [{ section: '3', step: 2, whole: '3-2' }]);
  assert.deepEqual(parseRefs('3.2、3.4').map((r) => [r.section, r.step]), [['3', 2], ['3', 4]]);
  assert.deepEqual(parseRefs('第 3 章步驟 5'), [{ section: '3', step: 5 }]);
  assert.deepEqual(parseRefs('4'), [{ section: '4' }]);
  assert.deepEqual(parseRefs('5A-2'), [{ section: '5A', step: 2, whole: '5A-2' }], '兩段式：refTime 先找 5A-2 這段');
  assert.deepEqual(parseRefs('—'), []);
  assert.deepEqual(parseRefs('5A-2-9（更多選單）、1-2-1 (舊)'), [{ section: '5A-2', step: 9 }, { section: '1-2', step: 1 }]);
});

test('refTime：兩段式優先當段編號，否則當「第幾段第幾步」', () => {
  const placed = placeChapters([{ ...meta(0, '甲', 'a.mp4', [[1000, 'x'], [5000, 'y']]), id: '3-2' }, { ...meta(0, '乙', 'b.mp4', [[2000, 'z']]), id: '4' }], [20_000, 20_000]);
  assert.equal(refTime(placed, parseRefs('3-2')[0]), 0, '3-2 是段');
  assert.equal(refTime(placed, parseRefs('3-2-2')[0]), 5000);
  assert.equal(refTime(placed, parseRefs('4-1')[0]), 22_000, '沒有 4-1 這段 → 第 4 段第 1 步');
  assert.equal(refTime(placed, parseRefs('9-9-9')[0]), undefined);
});

const REAL_LIKE = `# 功能對照表

| 狀態 | 意思 |
|---|---|
| ✅ | 正常 |

| 編號 | 角色 | 模組 | 功能 | 章節與步驟 | 時間碼 | 狀態 | 依據 | 備註 | Roy：保留／改／砍 |
|---|---|---|---|---|---|---|---|---|---|
| F-01 | 訪客 | 09 公開展示 | 首頁：大圖、公告區 | 1-1-1、1-1-3～5 | | ✅ | story-1 第 2 步 | | |
| F-02 | 訪客 | 09 公開展示 | 導覽列 A \\| B 兩種 | 1-1-2 | | 🟡 | UX N-15 | 寫了 \\| 也不會分欄 | |
| F-03 | 系辦 | 01 帳號 | 批次核准 | 5A-2-5 | | 🟡 | | | |
| F-99 | 全部 | 09 | 沒拍 | — | | ✅ | | | |
`;

test('parseFeatureTable：只認含必要表頭的功能表、處理 \\|、欄位數不符就報錯', () => {
  const t = parseFeatureTable(REAL_LIKE);
  assert.equal(t.headers.length, 10);
  assert.deepEqual(t.rows.map((r) => r.cells['編號']), ['F-01', 'F-02', 'F-03', 'F-99'], '圖例表格要略過');
  assert.equal(t.rows[1].cells['功能'], '導覽列 A | B 兩種');
  assert.equal(t.rows[1].cells['備註'], '寫了 | 也不會分欄');
  assert.deepEqual(t.rows[0].refs.map((r) => `${r.section}-${r.step}`), ['1-1-1', '1-1-3', '1-1-4', '1-1-5']);
  assert.deepEqual(t.rows[3].refs, []);
  const bad = REAL_LIKE.replace('| F-03 | 系辦 | 01 帳號 | 批次核准 | 5A-2-5 | | 🟡 | | | |', '| F-03 | 系辦 | 01 帳號 | 批次 | 核准 | 5A-2-5 | | 🟡 | | | |');
  assert.throws(() => parseFeatureTable(bad), /第 11 行有 11 欄，表頭有 10 欄/);
  assert.throws(() => parseFeatureTable('| 狀態 | 意思 |\n|---|---|\n| ✅ | 正常 |\n'), /找不到功能表/);
});

test('timedFeatureTable：把時間碼填進「時間碼」欄，其他內容不動', () => {
  const placed = placeChapters([{ ...meta(0, '首頁', 'a.mp4', [[2500, 'a'], [6000, 'b'], [9000, 'c']]), id: '1-1' }], [60_000]);
  const t = parseFeatureTable(REAL_LIKE);
  const out = timedFeatureTable(REAL_LIKE, placed, t);
  const lines = out.split('\n');
  assert.ok(lines.find((l) => l.startsWith('| F-01'))!.includes('| 0:02 |'));
  assert.ok(lines.find((l) => l.startsWith('| F-02'))!.includes('| 0:06 |'));
  assert.ok(lines.find((l) => l.startsWith('| F-02'))!.includes('A \\| B'), '跳脫的直線要保留');
  assert.ok(!/\| \d+:\d\d \|/.test(lines.find((l) => l.startsWith('| F-03'))!), '對不到影片的列不填');
  assert.deepEqual(parseFeatureTable(out).rows.map((r) => r.cells['功能']), t.rows.map((r) => r.cells['功能']));
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
    assertYoutubeRules(desc, placeChapters([a, b], [12_000, 11_000]));
    const ft = readFileSync(r.featureTimeline, 'utf8');
    assert.ok(ft.includes('- F07｜學生｜作業｜繳交 ⚠️ — [0:14](https://youtu.be/{{VIDEO_ID}}?t=14)'), ft);
    const html = readFileSync(r.html, 'utf8');
    assert.ok(html.includes('data-t="6.00">0:06</a></td><td>F01'), 'F01 → 1-2 = 0:06');
    assert.ok(html.includes('data-t="14.50">0:14</a></td><td>F07'), 'F07 → 3-1 = 12 + 2.5 秒');
    assert.ok(r.warnings.some((w) => w.includes('對不到影片') && w.includes('F09（9-9）')), r.warnings.join('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
