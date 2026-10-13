// 真的開 Chromium 錄一段：頁面每個 rAF 把「章節時間」畫成二進位條碼，
// 再從 clip.mp4 逐格解碼，證明影片時間與事件時間對齊（誤差 ≤ 50 ms）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NARRATION_TAIL_MS, launchTutorialBrowser, newTutorialPage, startChapter } from '../recorder.ts';
import { silentProvider } from '../tts.ts';
import type { ChapterEvents } from '../events.ts';

const BITS = 20;
const BLOCK = 40;
const PAGE = `<!doctype html><body style="margin:0;background:#fff">
<canvas id=c width=${BITS * BLOCK} height=${BLOCK} style="position:fixed;left:0;top:0"></canvas>
<button id=b style="position:fixed;left:900px;top:400px;width:300px;height:120px;background:#fff;border:0"
  onmousedown="this.style.background='#000'">按我</button>
<script>
  window.__off = null;
  const g = c.getContext('2d');
  function draw() {
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    if (window.__off != null) {
      const v = Math.round(Date.now() - window.__off);
      g.fillStyle = '#000';
      for (let i = 0; i < ${BITS}; i++) if ((v >> i) & 1) g.fillRect(i * ${BLOCK}, 0, ${BLOCK}, ${BLOCK});
    }
    requestAnimationFrame(draw);
  }
  draw();
</script></body>`;

/** 頁面放大 1.5 倍錄影：CSS px × ZOOM ＝ 影片像素。 */
const ZOOM = 1.5;
const B = BLOCK * ZOOM;

/** 解出每一格的條碼值，以及按鈕區（CSS 中心 1050,460）是否變黑。 */
function decode(clip: string): { codes: number[]; pressed: boolean[] } {
  const w = 1920;
  const h = 1000;
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', clip, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], {
    maxBuffer: 1 << 30,
  });
  const n = buf.length / (w * h);
  const codes: number[] = [];
  const pressed: boolean[] = [];
  for (let k = 0; k < n; k++) {
    const base = k * w * h;
    let v = 0;
    for (let i = 0; i < BITS; i++) if (buf[base + (B / 2) * w + i * B + B / 2] < 128) v |= 1 << i;
    codes.push(v);
    pressed.push(buf[base + 690 * w + 1575] < 128);
  }
  return { codes, pressed };
}

test('影片時間與事件時間對齊（≤ 50 ms），步驟長度 ≥ 配音＋0.6 秒', { timeout: 120_000 }, async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'tutorial-rec-'));
  const browser = await launchTutorialBrowser();
  try {
    const page = await newTutorialPage(browser);
    await page.setContent(PAGE);
    const t = await startChapter({ page, outDir, chapter: '測試｜對齊', tts: silentProvider(150), keepFrames: !!process.env.KEEP });
    // 每步開頭把頁面條碼對到章節時間（暫停後章節時鐘會位移，要重設）；記下設好的時間，
    // 分析只從這之後開始，免得把還沒重設的舊條碼算成誤差
    const synced: number[] = [];
    const sync = async () => {
      await page.evaluate((off) => ((window as unknown as { __off: number }).__off = off), Date.now() - t.now());
      synced.push(t.now());
    };

    await t.step({ caption: '第一步', narration: '這一步有十二個字的配音' }, async () => {
      await sync();
      await t.wait(800);
      await t.click(page.locator('#b'));
    });
    // 第二步前會因為合成配音而暫停計時：暫停後仍要對齊
    await t.step({ caption: '第二步', narration: '短配音' }, async () => {
      await sync();
      await t.wait(1500);
    });
    const { clip, events } = await t.finish();
    const ev = JSON.parse(readFileSync(events, 'utf8')) as ChapterEvents;
    const { codes, pressed } = decode(clip);
    const frameMs = 1000 / ev.clip.fps;

    // 1) 條碼：每個新數值第一次出現在影片的時間 vs 它被畫出來的章節時間
    const errors: number[] = [];
    for (const [i, s] of ev.steps.entries()) {
      let last = -1;
      // 最後一格不算：下一步合成配音的暫停中，畫面會停在暫停期間最後一張（內容正確，但條碼還在走）
      for (let k = Math.ceil((synced[i] + 100) / frameMs); (k + 1) * frameMs < s.endMs; k++) {
        const v = codes[k];
        if (v === last || v === 0) continue;
        last = v;
        errors.push(k * frameMs - v);
      }
    }
    assert.ok(errors.length > 40, `取樣太少：${errors.length}`);
    const abs = errors.map(Math.abs).sort((a, b) => a - b);
    const p50 = abs[abs.length >> 1];
    console.log(`校正延遲 ${ev.clip.captureLatencyMs} ms`);
    console.log(`條碼對齊：${errors.length} 個樣本，|誤差| 中位數 ${p50.toFixed(1)} ms，最大 ${abs.at(-1)!.toFixed(1)} ms`);
    assert.ok(abs.at(-1)! <= 50, `最大誤差 ${abs.at(-1)} ms`);

    // 2) 點擊：按鈕變黑的第一格 vs events.json 記的點擊時間
    const click = ev.events.find((e) => e.type === 'click');
    assert.ok(click && click.type === 'click');
    const firstPressed = pressed.findIndex(Boolean) * frameMs;
    console.log(`點擊對齊：事件 ${click.atMs} ms，畫面 ${firstPressed.toFixed(0)} ms`);
    assert.ok(Math.abs(firstPressed - click.atMs) <= 50, `點擊誤差 ${firstPressed - click.atMs} ms`);
    // 點擊座標落在按鈕中心（影片像素＝CSS×1.5）
    assert.deepEqual([click.x, click.y], [1575, 690]);
    // 網頁放大錄影：CSS 1280×667、clip 仍是 1920×1000 的實際像素
    assert.deepEqual([ev.page.width, ev.page.height, ev.page.zoom], [1280, 667, ZOOM]);
    const dims = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', clip]).toString().trim();
    assert.equal(dims.replace(/,$/, ''), '1920,1000');

    // 3) 步驟長度 ≥ 配音長度＋0.6 秒，且配音在步驟內
    for (const s of ev.steps) {
      assert.ok(s.audio, '每步都有配音');
      assert.ok(s.endMs - s.startMs >= s.audio.durationMs + NARRATION_TAIL_MS, `步驟 ${s.index} 太短`);
      assert.ok(s.audio.startMs + s.audio.durationMs + NARRATION_TAIL_MS <= s.endMs + 1);
    }
    // 4) clip 長度與事件時間軸一致
    const probed = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', clip]).toString());
    assert.ok(Math.abs(probed * 1000 - ev.clip.durationMs) <= 50, `clip ${probed}s vs ${ev.clip.durationMs}ms`);
    assert.ok(ev.steps.at(-1)!.endMs <= ev.clip.durationMs);
  } finally {
    await browser.close();
    if (!process.env.KEEP) rmSync(outDir, { recursive: true, force: true }); else console.log('outDir', outDir);
  }
});
