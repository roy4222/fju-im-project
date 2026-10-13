// 後製：時間軸純函式，加上一個合成章節實際 render 後抽格檢查像素。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChapterEvents } from '../events.ts';
import { renderChapter } from '../render.ts';
import { cursorAss, displayUrl, overlaySegments } from '../timeline.ts';

function fixture(): ChapterEvents {
  return {
    version: 1,
    chapter: '學生｜繳交作業',
    number: 3,
    output: { width: 1920, height: 1080, chromeHeight: 80 },
    page: { width: 1920, height: 1000, zoom: 1 },
    clip: { file: 'clip.mp4', durationMs: 4000, fps: 30, captureLatencyMs: 0 },
    displayOrigin: 'test.fju.roy422.dev',
    cursorStart: { x: 960, y: 450 },
    steps: [
      { index: 1, caption: '打開作業頁', narration: '打開作業頁。', status: { kind: 'warn', note: '尚未開放' }, startMs: 200, endMs: 2500, audio: { file: 'audio/a.wav', startMs: 450, durationMs: 1000 } },
      { index: 2, caption: '上傳檔案', narration: '', startMs: 2500, endMs: 3900 },
    ],
    events: [
      { type: 'url', atMs: 0, url: 'https://localhost:3000/dashboard/student/affairs?tab=%E4%BD%9C%E6%A5%AD' },
      { type: 'move', startMs: 300, endMs: 1100, from: { x: 960, y: 450 }, to: { x: 400, y: 300 } },
      { type: 'click', atMs: 1300, x: 400, y: 300 },
      { type: 'url', atMs: 1600, url: 'https://localhost:3000/dashboard/student' },
    ],
  };
}

test('displayUrl：換主機、解碼中文查詢字串、首頁只顯示主機', () => {
  assert.equal(displayUrl('http://localhost:3000/a?q=%E4%BD%9C', 'test.fju.roy422.dev'), 'test.fju.roy422.dev/a?q=作');
  assert.equal(displayUrl('https://test.fju.roy422.dev/'), 'test.fju.roy422.dev');
});

test('overlaySegments：步驟或網址一變就切，沒步驟的空檔只有網址列', () => {
  const segs = overlaySegments(fixture());
  assert.deepEqual(
    segs.map((s) => [s.startMs, s.endMs, s.state.step?.index ?? null, s.state.url]),
    [
      [0, 200, null, 'test.fju.roy422.dev/dashboard/student/affairs?tab=作業'],
      [200, 1600, 1, 'test.fju.roy422.dev/dashboard/student/affairs?tab=作業'],
      [1600, 2500, 1, 'test.fju.roy422.dev/dashboard/student'],
      [2500, 3900, 2, 'test.fju.roy422.dev/dashboard/student'],
      [3900, 4000, null, 'test.fju.roy422.dev/dashboard/student'],
    ],
  );
});

test('cursorAss：游標事件連續覆蓋整段 clip，座標含網址列位移', () => {
  const ass = cursorAss(fixture(), 2500);
  const cursorLines = ass.split('\n').filter((l) => l.startsWith('Dialogue: 2,'));
  assert.ok(cursorLines[0].startsWith('Dialogue: 2,0:00:02.50,'), cursorLines[0]);
  assert.ok(cursorLines.at(-1)!.includes(',0:00:06.50,'), cursorLines.at(-1));
  assert.ok(cursorLines.at(-1)!.includes('\\pos(400,380)'));
  // 相鄰事件首尾相接（沒有游標消失的空格）
  const spans = cursorLines.map((l) => l.split(',').slice(1, 3));
  for (let i = 1; i < spans.length; i++) assert.equal(spans[i][0], spans[i - 1][1], `gap at ${i}`);
});

test('render：標題卡、網址列、字幕條、狀態標記、游標與波紋出現在正確位置', { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tutorial-render-'));
  try {
    const ev = fixture();
    mkdirSync(join(dir, 'audio'));
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0xEEF2F7:s=1920x1000:r=30:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(dir, 'clip.mp4')]);
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=f=440:d=1', '-ar', '48000', '-ac', '1', join(dir, 'audio', 'a.wav')]);
    writeFileSync(join(dir, 'events.json'), JSON.stringify(ev));
    const { file, meta } = await renderChapter({ dir, titleMs: 2500 });

    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]).toString());
    const v = probe.streams.find((s: { codec_type: string }) => s.codec_type === 'video');
    const a = probe.streams.find((s: { codec_type: string }) => s.codec_type === 'audio');
    assert.equal(v.codec_name, 'h264');
    assert.deepEqual([v.width, v.height, v.r_frame_rate], [1920, 1080, '30/1']);
    assert.equal(a.codec_name, 'aac');
    assert.ok(Math.abs(Number(probe.format.duration) - 6.5) < 0.1, probe.format.duration);
    assert.equal(meta.steps[0].startMs, 2700);

    const rgbAt = (sec: number) =>
      execFileSync('ffmpeg', ['-v', 'error', '-ss', String(sec), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 24 });
    const px = (buf: Buffer, x: number, y: number) => [...buf.subarray((y * 1920 + x) * 3, (y * 1920 + x) * 3 + 3)];
    const isNavy = ([r, , b]: number[]) => b > r + 25 && r < 60;
    // 半透明橘疊在淺色底上：紅 > 綠 > 藍 且差距明顯
    const isOrange = ([r, g, b]: number[]) => r > 200 && r - g > 30 && g - b > 25;

    // 1 秒：標題卡（深藍底）
    assert.ok(isNavy(px(rgbAt(1.0), 960, 300)), `title ${px(rgbAt(1.0), 960, 300)}`);

    // 4.2 秒（clip 1700 ms）：游標停在 (400, 300+80)；尖端右下方是白色箭頭
    const f = rgbAt(4.2);
    const tip = px(f, 404, 392);
    assert.ok(tip.every((c) => c > 230), `cursor body ${tip}`);
    // 網址列在上方 80px、字幕條在下方
    assert.ok(px(f, 10, 40).every((c) => c > 200 && c < 245), `chrome ${px(f, 10, 40)}`);
    const capY = 1080 - 44 - 50;
    assert.ok(px(f, 960, capY).every((c) => c < 60), `caption ${px(f, 960, capY)}`);

    // 3.95 秒（點擊後 150 ms）：波紋以點擊點為圓心，左右對稱
    const r = rgbAt(3.95);
    const left = px(r, 400 - 22, 380);
    const right = px(r, 400 + 22, 380);
    const up = px(r, 400, 380 - 22);
    assert.ok(isOrange(left) && isOrange(up), `ripple left ${left} up ${up}`);
    assert.deepEqual(left, up, '圓心在點擊點：左與上等距處顏色相同');
    // 右側被游標箭頭蓋住一部分，只要求不是底色
    assert.ok(!right.every((c, i) => Math.abs(c - [0xee, 0xf2, 0xf7][i]) < 8), `ripple right ${right}`);
    const far = px(r, 400 - 90, 380);
    assert.ok(!isOrange(far), `ripple too big ${far}`);

    // 音軌：配音那一秒有聲音
    const det = execFileSync('sh', ['-c', `ffmpeg -ss 3.0 -t 0.8 -i '${file}' -af volumedetect -f null - 2>&1 | grep mean_volume`]).toString();
    assert.ok(Number(det.match(/mean_volume: (-?[\d.]+)/)![1]) > -40, det);
    assert.ok(JSON.parse(readFileSync(join(dir, 'chapter.json'), 'utf8')).label === '3｜學生｜繳交作業');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
