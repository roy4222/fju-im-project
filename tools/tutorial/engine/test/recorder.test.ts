// 真的開 Chromium 錄影：頁面每個 rAF 把「章節時間」畫成二進位條碼，
// 再從 clip.mp4 逐格（含重複格）解碼，證明影片時間與事件時間對齊（誤差 ≤ 50 ms）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { launchTutorialBrowser, NARRATION_TAIL_MS, newTutorialPage, startChapter } from '../recorder.ts';
import { silentProvider } from '../tts.ts';
import type { ChapterEvents } from '../events.ts';
import { FAILED_MARK, RECORDING_MARK } from '../runs.ts';

const BITS = 20;
const BLOCK = 40;
/** 頁面放大 1.5 倍錄影：CSS px × ZOOM ＝ 影片像素。 */
const ZOOM = 1.5;
const B = BLOCK * ZOOM;
const W = 1920;
const H = 1000;

const PAGE = `<!doctype html><body style="margin:0;background:#fff">
<canvas id=c width=${BITS * BLOCK} height=${BLOCK} style="position:fixed;left:0;top:0"></canvas>
<button id=b style="position:fixed;left:900px;top:400px;width:300px;height:120px;background:#fff;border:0"
  onclick="this.style.background='#000'">按我</button>
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

/** 每一格的條碼值，以及按鈕區（CSS 中心 1050,460 → 影片 1575,690）是否變黑。 */
function decode(clip: string): { codes: number[]; pressed: boolean[] } {
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', clip, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 30 });
  const n = buf.length / (W * H);
  const codes: number[] = [];
  const pressed: boolean[] = [];
  for (let k = 0; k < n; k++) {
    const base = k * W * H;
    let v = 0;
    for (let i = 0; i < BITS; i++) if (buf[base + (B / 2) * W + i * B + B / 2] < 128) v |= 1 << i;
    codes.push(v);
    pressed.push(buf[base + 690 * W + 1575] < 128);
  }
  return { codes, pressed };
}

type Raw = { ev: ChapterEvents; clip: string; synced: number[]; outDir: string };
type Recorded = Raw & { errors: number[]; clickErr: number };

/**
 * 錄一段條碼章節：兩步（第二步前因合成配音暫停計時），第一步點一下按鈕。
 * 只錄不分析：解碼用同步的 ffmpeg，同一個程序裡另一路還在錄的話會卡住它的截圖迴圈。
 */
async function recordBarcode(browser: Browser, root: string, slotsDir: string, label: string): Promise<Raw> {
  const page = await newTutorialPage(browser);
  await page.setContent(PAGE);
  const outDir = join(root, label);
  const t = await startChapter({ page, outDir, chapter: `測試｜${label}`, tts: silentProvider(150), slots: { dir: slotsDir, max: 2 } });
  // 每步開頭把頁面條碼對到章節時間（暫停後章節時鐘會位移，要重設）；記下設好的時間，
  // 分析只從這之後開始，免得把還沒重設的舊條碼算成誤差
  const synced: number[] = [];
  const sync = async () => {
    await page.evaluate((off) => ((window as unknown as { __off: number }).__off = off), Date.now() - t.now());
    synced.push(t.now());
  };
  try {
    await t.step({ caption: '第一步', narration: '這一步有十二個字的配音' }, async () => {
      await sync();
      await t.wait(800);
      await t.click(page.locator('#b'));
    });
    await t.step({ caption: '第二步', narration: '短配音' }, async () => {
      await sync();
      await t.wait(1500);
    });
    const { clip, events } = await t.finish();
    return { ev: JSON.parse(readFileSync(events, 'utf8')) as ChapterEvents, clip, synced, outDir };
  } finally {
    await t.dispose();
    await page.close();
  }
}

/** 逐格解碼、算誤差。 */
function analyze({ ev, clip, synced, outDir }: Raw): Recorded {
  {
    const { codes, pressed } = decode(clip);
    const frameMs = 1000 / ev.clip.fps;
    // 逐格（含重複格）：第 k 格顯示的條碼值就是那張畫面內容的章節時間
    const errors: number[] = [];
    for (const [i, s] of ev.steps.entries()) {
      // 最後一格不算：下一步合成配音的暫停中，畫面會停在暫停期間最後一張（內容正確，但條碼還在走）
      for (let k = Math.ceil((synced[i] + 100) / frameMs); (k + 1) * frameMs < s.endMs; k++) {
        if (codes[k] !== 0) errors.push(k * frameMs - codes[k]);
      }
    }
    const click = ev.events.find((e) => e.type === 'click');
    assert.ok(click && click.type === 'click');
    const clickErr = pressed.findIndex(Boolean) * frameMs - click.atMs;
    assert.deepEqual([click.x, click.y], [1575, 690], '點擊座標落在按鈕中心（影片像素＝CSS×1.5）');
    return { ev, clip, synced, errors, clickErr, outDir };
  }
}

function summarize(name: string, r: Recorded) {
  const abs = r.errors.map(Math.abs).sort((a, b) => a - b);
  const q = r.ev.quality!;
  console.log(
    `${name}：逐格 ${abs.length} 格 |誤差| 中位數 ${abs[abs.length >> 1].toFixed(1)} ms、最大 ${abs.at(-1)!.toFixed(1)} ms；` +
      `點擊（onclick）誤差 ${r.clickErr.toFixed(1)} ms；截圖 ${q.fps} 張／秒、最大間隔 ${q.maxGapMs} ms`,
  );
  return abs;
}

test('影片時間與事件時間逐格對齊（含重複格 ≤ 50 ms），點擊與 onclick 反應對齊，步驟長度 ≥ 配音＋0.6 秒', { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tutorial-rec-'));
  const browser = await launchTutorialBrowser();
  try {
    const r = analyze(await recordBarcode(browser, root, join(root, 'slots'), 'single'));
    const abs = summarize('單路', r);
    assert.ok(abs.length > 100, `取樣太少：${abs.length}`);
    assert.ok(abs.at(-1)! <= 50, `最大誤差 ${abs.at(-1)} ms`);
    assert.ok(Math.abs(r.clickErr) <= 50, `點擊誤差 ${r.clickErr} ms`);
    const { ev, clip } = r;
    // 截圖品質寫進 events.json
    assert.ok(ev.quality && ev.quality.ok, JSON.stringify(ev.quality));
    assert.ok(ev.quality.fps >= 25 && ev.quality.maxGapMs <= 50);
    // 網頁放大錄影：CSS 1280×667、clip 仍是 1920×1000 的實際像素
    assert.deepEqual([ev.page.width, ev.page.height, ev.page.zoom], [1280, 667, ZOOM]);
    const dims = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', clip]).toString().trim();
    assert.equal(dims.replace(/,$/, ''), '1920,1000');
    // 步驟長度 ≥ 配音長度＋0.6 秒，且配音在步驟內
    for (const s of ev.steps) {
      assert.ok(s.audio, '每步都有配音');
      assert.ok(s.endMs - s.startMs >= s.audio.durationMs + NARRATION_TAIL_MS, `步驟 ${s.index} 太短`);
      assert.ok(s.audio.startMs + s.audio.durationMs + NARRATION_TAIL_MS <= s.endMs + 1);
    }
    const probed = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', clip]).toString());
    assert.ok(Math.abs(probed * 1000 - ev.clip.durationMs) <= 50, `clip ${probed}s vs ${ev.clip.durationMs}ms`);
    // 錄完：錄影中標記拿掉、沒有失敗檔、名額歸還
    assert.ok(!existsSync(join(r.outDir, RECORDING_MARK)) && !existsSync(join(r.outDir, FAILED_MARK)));
    assert.deepEqual(readdirSync(join(root, 'slots')), []);
  } finally {
    await browser.close();
    if (!process.env.KEEP) rmSync(root, { recursive: true, force: true });
    else console.log('root', root);
  }
});

test('兩路同時錄影：各自逐格誤差 ≤ 50 ms、截圖品質合格', { timeout: 180_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tutorial-rec2-'));
  const browsers = await Promise.all([launchTutorialBrowser(), launchTutorialBrowser()]);
  try {
    const slots = join(root, 'slots');
    // 兩路都錄完才分析（實際使用時兩路是兩個獨立程序）
    const rs = (await Promise.all(browsers.map((b, i) => recordBarcode(b, root, slots, `parallel-${i + 1}`)))).map(analyze);
    rs.forEach((r, i) => {
      const abs = summarize(`兩路並行 #${i + 1}`, r);
      assert.ok(abs.at(-1)! <= 50, `#${i + 1} 最大誤差 ${abs.at(-1)} ms`);
      assert.ok(Math.abs(r.clickErr) <= 50, `#${i + 1} 點擊誤差 ${r.clickErr} ms`);
      assert.ok(r.ev.quality!.ok, `#${i + 1} ${JSON.stringify(r.ev.quality)}`);
    });
  } finally {
    await Promise.all(browsers.map((b) => b.close()));
    rmSync(root, { recursive: true, force: true });
  }
});

test('錄影中分頁被關：動作立刻報錯、截圖停止、名額歸還、留下 FAILED.txt；輸出目錄已存在就拒絕開始', { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tutorial-fail-'));
  const browser = await launchTutorialBrowser();
  try {
    const slots = join(root, 'slots');
    const page = await newTutorialPage(browser);
    await page.setContent('<p>hi</p>');
    const outDir = join(root, 'run');
    const t = await startChapter({ page, outDir, chapter: '測試｜關閉', tts: silentProvider(), slots: { dir: slots, max: 2 } });
    const t0 = Date.now();
    const stepP = t.step({ caption: '等很久' }, async () => {
      await t.wait(30_000);
    });
    setTimeout(() => void page.close(), 300);
    await assert.rejects(stepP, /分頁被關閉|截圖失敗/);
    assert.ok(Date.now() - t0 < 5000, '中止要馬上生效');
    await t.dispose();
    assert.ok(existsSync(join(outDir, FAILED_MARK)));
    assert.ok(!existsSync(join(outDir, RECORDING_MARK)));
    assert.deepEqual(readdirSync(slots), [], '名額要歸還');
    // 同一個 outDir 再錄一次：開始前就拒絕
    const page2 = await newTutorialPage(browser);
    await assert.rejects(startChapter({ page: page2, outDir, chapter: '測試｜撞名', tts: silentProvider(), slots: { dir: slots } }), /已存在，拒絕覆蓋/);
    assert.deepEqual(readdirSync(slots), []);
  } finally {
    await browser.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('waitStable：goto 後等畫面內的圖片載完才開始錄（慢圖不會以空白出現在影片裡）', { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tutorial-stable-'));
  const browser = await launchTutorialBrowser();
  try {
    const page = await newTutorialPage(browser);
    // 一張 800 ms 後才回應的紅色圖片
    const png = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=200x200', '-frames:v', '1', '-f', 'image2', '-c:v', 'png', '-']);
    await page.route('http://tutorial.test/**', async (route) => {
      if (route.request().url().endsWith('.png')) {
        await new Promise((r) => setTimeout(r, 800));
        return route.fulfill({ body: png, contentType: 'image/png' });
      }
      return route.fulfill({
        contentType: 'text/html',
        body: '<body style="margin:0;background:#fff"><img src="/slow.png" style="position:absolute;left:100px;top:100px;width:200px;height:200px;background:#eee"></body>',
      });
    });
    const t = await startChapter({ page, outDir: join(root, 'run'), chapter: '測試｜穩定', tts: silentProvider(), slots: { dir: join(root, 'slots') } });
    try {
      await t.step({ caption: '開頁' }, async () => {
        await t.goto('http://tutorial.test/');
        await t.wait(500);
      });
      const { clip, events } = await t.finish();
      const ev = JSON.parse(readFileSync(events, 'utf8')) as ChapterEvents;
      const opened = ev.events.find((e) => e.type === 'url' && e.url.startsWith('http://tutorial.test'));
      assert.ok(opened && opened.type === 'url');
      // 開頁之後影片每一格的圖片中心（CSS 200,200 → 影片 300,300）都要是紅色（開頁前是 about:blank）
      const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', clip, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 30 });
      const n = buf.length / (W * H * 3);
      let notRed = 0;
      for (let k = Math.ceil(opened.atMs / (1000 / ev.clip.fps)) + 1; k < n; k++) {
        const o = k * W * H * 3 + (300 * W + 300) * 3;
        if (!(buf[o] > 200 && buf[o + 1] < 60 && buf[o + 2] < 60)) notRed++;
      }
      assert.equal(notRed, 0, `${notRed}/${n} 格圖片還沒載好`);
    } finally {
      await t.dispose();
    }
  } finally {
    await browser.close();
    rmSync(root, { recursive: true, force: true });
  }
});
