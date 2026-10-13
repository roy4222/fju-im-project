import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assemble, parseFeatureTable, parseRefs, placeChapters, timecode, youtubeChapters } from '../assemble.ts';
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

test('youtubeChapters：第一行 0:00、詳細時間軸含步驟與狀態、太短的章節會警告', () => {
  const placed = placeChapters(
    [meta(1, '訪客前台', 'a.mp4', [[2700, '首頁', 'ok']]), meta(2, '學生｜登入', 'b.mp4', [[2700, '輸入帳號'], [9000, '登入', 'warn']])],
    [72_000, 8_000],
  );
  const { text, warnings } = youtubeChapters(placed);
  const lines = text.split('\n');
  assert.equal(lines[0], '0:00 1｜訪客前台');
  assert.equal(lines[1], '1:12 2｜學生｜登入');
  assert.ok(text.includes('0:02 1-1 首頁 ✅'));
  assert.ok(text.includes('1:21 2-2 登入 ⚠️'));
  assert.ok(warnings.some((w) => w.includes('2｜學生｜登入') && w.includes('10 秒')));
  assert.ok(warnings.some((w) => w.includes('至少要 3 個章節')));
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
    const txt = readFileSync(r.chaptersTxt, 'utf8');
    assert.ok(txt.startsWith('0:00 1｜訪客前台\n0:12 3｜學生｜繳交作業\n'), txt);
    assert.ok(txt.includes('0:14 3-1 打開作業頁 ⚠️'));
    const html = readFileSync(r.html, 'utf8');
    assert.ok(html.includes('data-t="6.00">0:06</a></td><td>F01'), 'F01 → 1-2 = 0:06');
    assert.ok(html.includes('data-t="14.50">0:14</a></td><td>F07'), 'F07 → 3-1 = 12 + 2.5 秒');
    assert.ok(r.warnings.some((w) => w.startsWith('F09')), r.warnings.join('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
