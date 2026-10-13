// 真的開 Chromium 錄影：頁面每個 rAF 把「章節時間」畫成二進位條碼，
// 再從 clip.mp4 逐格（含重複格）解碼，證明影片時間與事件時間對齊（誤差 ≤ 50 ms）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { analyze, H, recordBarcode, W, ZOOM, type Raw, type Recorded } from './barcode-recording.ts';
import { launchTutorialBrowser, NARRATION_TAIL_MS, newTutorialPage, startChapter } from '../recorder.ts';
import { silentProvider } from '../tts.ts';
import type { ChapterEvents } from '../events.ts';
import { FAILED_MARK, RECORDING_MARK } from '../runs.ts';


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

test('兩路同時錄影（兩個獨立程序，跟實際一樣）：各自逐格誤差 ≤ 50 ms、截圖品質合格', { timeout: 180_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tutorial-rec2-'));
  try {
    const slots = join(root, 'slots');
    const helper = join(import.meta.dirname, 'barcode-recording.ts');
    const rs = (
      await Promise.all(
        [1, 2].map(async (i) => {
          const { stdout } = await promisify(execFile)('node', [helper, root, slots, `parallel-${i}`], { maxBuffer: 1 << 24 });
          return JSON.parse(stdout.trim().split('\n').at(-1)!) as Raw;
        }),
      )
    ).map(analyze);
    rs.forEach((r, i) => {
      const abs = summarize(`兩路並行 #${i + 1}`, r);
      assert.ok(abs.at(-1)! <= 50, `#${i + 1} 最大誤差 ${abs.at(-1)} ms`);
      assert.ok(Math.abs(r.clickErr) <= 50, `#${i + 1} 點擊誤差 ${r.clickErr} ms`);
      assert.ok(r.ev.quality!.ok, `#${i + 1} ${JSON.stringify(r.ev.quality)}`);
    });
  } finally {
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

test('waitStable：goto 與點連結換頁後，等畫面內的圖片載完才繼續錄（慢圖不會以空白出現在影片裡）', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tutorial-stable-'));
  const browser = await launchTutorialBrowser();
  try {
    const page = await newTutorialPage(browser);
    // 兩張 800 ms 後才回應的圖：第一頁紅、第二頁藍
    const png = (c: string) => execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${c}:s=200x200`, '-frames:v', '1', '-f', 'image2', '-c:v', 'png', '-']);
    const imgs: Record<string, Buffer> = { '/red.png': png('red'), '/blue.png': png('blue') };
    const html = (img: string, link = '') =>
      `<body style="margin:0;background:#fff"><img src="${img}" style="position:absolute;left:100px;top:100px;width:200px;height:200px;background:#eee">${link}</body>`;
    await page.route('http://tutorial.test/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (imgs[path]) {
        await new Promise((r) => setTimeout(r, 800));
        return route.fulfill({ body: imgs[path], contentType: 'image/png' });
      }
      if (path === '/two') return route.fulfill({ contentType: 'text/html', body: html('/blue.png') });
      return route.fulfill({
        contentType: 'text/html',
        body: html('/red.png', '<a id=next href="/two" style="position:absolute;left:500px;top:150px;font-size:40px">下一頁</a>'),
      });
    });
    const t = await startChapter({ page, outDir: join(root, 'run'), chapter: '測試｜穩定', tts: silentProvider(), slots: { dir: join(root, 'slots') } });
    try {
      await t.step({ caption: '開頁' }, async () => {
        await t.goto('http://tutorial.test/');
        await t.wait(500);
      });
      await t.step({ caption: '點下一頁' }, async () => {
        await t.click(page.locator('#next'));
        await t.wait(500);
      });
      const { clip, events } = await t.finish();
      const ev = JSON.parse(readFileSync(events, 'utf8')) as ChapterEvents;
      const urlAt = (path: string) => {
        const e = ev.events.find((x) => x.type === 'url' && x.url.endsWith(path));
        assert.ok(e && e.type === 'url', `沒有換到 ${path}`);
        return e.atMs;
      };
      const [t1, t2] = [urlAt('tutorial.test/'), urlAt('/two')];
      // 影片每一格的圖片中心（CSS 200,200 → 影片 300,300）：第一頁之後是紅、第二頁之後是藍（之前是 about:blank）
      const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', clip, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 30 });
      const n = buf.length / (W * H * 3);
      const frameMs = 1000 / ev.clip.fps;
      const bad: string[] = [];
      for (let k = Math.ceil(t1 / frameMs) + 1; k < n; k++) {
        const o = k * W * H * 3 + (300 * W + 300) * 3;
        const [r, g, b] = [buf[o], buf[o + 1], buf[o + 2]];
        const want = k * frameMs > t2 + frameMs ? 'blue' : k * frameMs < t2 - frameMs ? 'red' : null;
        if (want === 'red' && !(r > 200 && g < 60 && b < 60)) bad.push(`#${k} 應為紅 ${[r, g, b]}`);
        if (want === 'blue' && !(b > 200 && r < 60 && g < 60)) bad.push(`#${k} 應為藍 ${[r, g, b]}`);
      }
      assert.deepEqual(bad, [], `${bad.length}/${n} 格圖片還沒載好`);
    } finally {
      await t.dispose();
    }
  } finally {
    await browser.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('截圖空檔分兩種：網頁自己卡住（long task）只標記不中止；截圖跟不上（> 100 ms）中止並報錯', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tutorial-gap-'));
  const browser = await launchTutorialBrowser();
  try {
    const slots = { dir: join(root, 'slots') };
    // 1) 網頁自己卡 250 ms：錄影繼續，events.json 標記
    const page = await newTutorialPage(browser);
    await page.setContent(
      `<button id=b style="position:fixed;left:200px;top:200px;width:300px;height:100px" onclick="const e=performance.now()+250;while(performance.now()<e){};this.textContent='好了'">卡一下</button>`,
    );
    const t = await startChapter({ page, outDir: join(root, 'jank'), chapter: '測試｜網頁卡', tts: silentProvider(), slots });
    try {
      await t.step({ caption: '按會卡的按鈕' }, async () => {
        await t.click(page.locator('#b'));
        await t.wait(500);
      });
      const { events } = await t.finish();
      const ev = JSON.parse(readFileSync(events, 'utf8')) as ChapterEvents;
      const jank = ev.quality!.pageJank ?? [];
      console.log('網頁卡住：', JSON.stringify(jank));
      assert.ok(jank.some((j) => j.gapMs > 100 && /long task|換頁/.test(j.reason)), JSON.stringify(ev.quality));
      assert.equal(ev.quality!.ok, false, '有停格就標記品質不合格');
      assert.ok(ev.quality!.warnings.some((w) => w.includes('畫面停了')));
    } finally {
      await t.dispose();
    }
    // 2) 錄影程序自己卡 300 ms（模擬機器太忙）：中止並報錯
    const page2 = await newTutorialPage(browser);
    await page2.setContent('<p>靜態頁</p>');
    const t2 = await startChapter({ page: page2, outDir: join(root, 'starved'), chapter: '測試｜截不到', tts: silentProvider(), slots });
    try {
      await assert.rejects(
        t2.step({ caption: '卡住錄影程序' }, async () => {
          await t2.wait(300);
          const end = Date.now() + 300;
          while (Date.now() < end) {} // 擋住 Node 事件迴圈：截圖迴圈跑不動
          await t2.wait(1000);
        }),
        /截圖跟不上/,
      );
    } finally {
      await t2.dispose();
    }
    assert.ok(existsSync(join(root, 'starved', FAILED_MARK)));
  } finally {
    await browser.close();
    rmSync(root, { recursive: true, force: true });
  }
});
