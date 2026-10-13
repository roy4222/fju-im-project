// 等待的規則：換頁前還在飛的請求不會讓 waitStable 等到逾時、逾時原因寫清楚、任何等待都不進影片、
// 同路徑只改查詢字串不算換頁（UI 過程保留）、同網址整頁重載仍算換頁。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright';
import type { ChapterEvents } from '../events.ts';
import { Chapter, isPageChange, launchTutorialBrowser, newTutorialPage, startChapter } from '../recorder.ts';
import { silentProvider } from '../tts.ts';

const ANIMATED = `<body style="margin:0;background:#fff"><style>@keyframes mv{from{transform:translateX(0)}to{transform:translateX(300px)}}</style>
<div style="position:absolute;left:100px;top:100px;width:200px;height:200px;background:#f00;animation:mv 1s linear infinite alternate"></div>
<input id=q style="position:absolute;left:100px;top:400px;width:300px;height:40px;font-size:24px" onkeydown="if(event.key==='Enter')this.style.background='#0f0'">
<a id=dead href="/nowhere" onclick="event.preventDefault()" style="position:absolute;left:600px;top:400px;font-size:40px">不會換頁的連結</a></body>`;

/** 真的 HTTP 伺服器（不用 route）：/hang 永遠不回，跟實際的「換頁時還在飛的 fetch」一樣。 */
async function hangServer(): Promise<{ base: string; srv: Server }> {
  const srv = createServer((req, res) => {
    const path = new URL(req.url!, 'http://x').pathname;
    if (path.startsWith('/hang')) return; // 永遠不回
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (path === '/one') return res.end(`<body style="margin:0"><p>one</p><script>fetch('/hang-rsc', { headers: { RSC: '1' } }); fetch('/hang-plain');</script></body>`);
    if (path === '/fresh') return res.end(`<body style="margin:0"><p>fresh</p><script>fetch('/hang-fresh')</script></body>`);
    if (path === '/anim') return res.end(ANIMATED);
    res.end('<body style="margin:0"><p>two</p></body>');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as { port: number };
  return { base: `http://127.0.0.1:${port}`, srv };
}

test('isPageChange：只有 origin 或路徑不同才算換頁，查詢字串與 hash 不算', () => {
  assert.equal(isPageChange('http://a/x?p=1', 'http://a/x?p=2'), false);
  assert.equal(isPageChange('http://a/x', 'http://a/x#top'), false);
  assert.equal(isPageChange('http://a/x', 'http://a/y'), true);
  assert.equal(isPageChange('http://a/x', 'http://b/x'), true);
});

test('換頁回溯暫停後動作拋錯：暫停一定收尾（時鐘繼續走），不用開瀏覽器', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tutorial-pause-'));
  try {
    // 假分頁：withNavWatch 在動作拋錯之前只用到這幾個方法
    const fakePage = { url: () => 'http://tutorial.test/', on() {}, off() {}, mainFrame: () => ({}) };
    const t = new Chapter({ page: fakePage as unknown as Page, outDir: join(root, 'run'), chapter: '測試｜暫停收尾', tts: silentProvider() });
    const priv = t as unknown as { t0Wall: number; pausedAt: number | null; pauses: unknown[]; navWatch: unknown; navDetected(w: unknown): void; withNavWatch(o: unknown, a: () => Promise<{ atMs: number }>): Promise<void> };
    priv.t0Wall = Date.now();
    await assert.rejects(
      priv.withNavWatch({ stable: {}, linkTo: null, settleMs: 10 }, async () => {
        priv.navDetected(priv.navWatch); // 模擬動作中同步偵測到換頁：回溯暫停已開
        assert.notEqual(priv.pausedAt, null);
        throw new Error('boom');
      }),
      /boom/,
    );
    assert.equal(priv.pausedAt, null, '暫停要收尾');
    assert.equal(priv.pauses.length, 1, '暫停區間要記下來');
    const before = t.now();
    await new Promise((r) => setTimeout(r, 120));
    assert.ok(t.now() - before >= 100, '時鐘要繼續走');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('換頁前還在飛的請求（Playwright 不會再通知結束）不會讓之後的 waitStable 等到逾時；逾時原因寫實際卡住的那一項', { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tutorial-leak-'));
  const { base, srv } = await hangServer();
  const browser = await launchTutorialBrowser();
  try {
    const page = await newTutorialPage(browser);
    const t = await startChapter({ page, outDir: join(root, 'run'), chapter: '測試｜請求外漏', baseURL: base, tts: silentProvider(), slots: { dir: join(root, 'slots') } });
    try {
      await t.goto('/one', false); // 這頁發了兩個永遠不回的 fetch
      await page.waitForTimeout(300);
      // 整頁換到 /two：舊頁的 fetch 要被清掉，等穩定幾秒內就該回來（修正前會等滿 30 秒）
      const t0 = Date.now();
      await t.goto('/two');
      const took = Date.now() - t0;
      assert.ok(took < 8000, `goto /two 等了 ${took} ms`);
      const t1 = Date.now();
      await t.waitStable();
      assert.ok(Date.now() - t1 < 5000, `waitStable 等了 ${Date.now() - t1} ms`);

      // 逾時原因：這一頁自己發的、還新鮮的請求 → 「網路一直沒停」並列出網址
      await t.goto('/fresh', false);
      await t.waitStable({ timeout: 1500 });
      // 畫面真的一直在變 → 「畫面一直在變」並附變動範圍
      await t.goto('/anim', false);
      await t.waitStable({ timeout: 1500 });
      const { events } = await t.finish();
      const ev = JSON.parse(readFileSync(events, 'utf8')) as ChapterEvents;
      const w = ev.quality!.warnings;
      assert.ok(w.some((x) => x.includes('/fresh') && x.includes('網路一直沒停') && x.includes('/hang-fresh')), w.join('\n'));
      assert.ok(w.some((x) => x.includes('/anim') && x.includes('畫面一直在變') && x.includes('變動範圍')), w.join('\n'));
      assert.ok(!w.some((x) => x.includes('/two')), w.join('\n'));
      assert.ok(w.filter((x) => x.includes('畫面沒穩定')).every((x) => x.includes('沒有錄進影片')), w.join('\n'));
    } finally {
      await t.dispose();
    }
  } finally {
    await browser.close();
    srv.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('任何等待都不進影片：步驟裡的 waitStable（逾時）、點了別頁連結卻沒換頁的等待都不佔影片時間；press 記進 events.json', { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tutorial-nowait-'));
  const { base, srv } = await hangServer();
  const browser = await launchTutorialBrowser();
  try {
    const page = await newTutorialPage(browser);
    const t = await startChapter({ page, outDir: join(root, 'run'), chapter: '測試｜等待不進影片', baseURL: base, tts: silentProvider(), slots: { dir: join(root, 'slots') } });
    try {
      await t.goto('/anim', false);
      const wall0 = Date.now();
      await t.step({ caption: '等一個不會穩定的畫面' }, async () => {
        await t.waitStable({ timeout: 1500 }); // 沒寫 offRecord 也一樣不進影片
      });
      const wall1 = Date.now();
      await t.step({ caption: '點一個不會換頁的連結' }, async () => {
        await t.click(page.locator('#dead'));
      });
      const wall2 = Date.now();
      await t.step({ caption: '按 Enter' }, async () => {
        await t.click(page.locator('#q'), false);
        await t.press('Enter');
      });
      const { events } = await t.finish();
      const ev = JSON.parse(readFileSync(events, 'utf8')) as ChapterEvents;
      const [s1, s2, s3] = ev.steps;
      assert.ok(s1.endMs - s1.startMs < 1000, `逾時的 waitStable 錄進影片了：步驟 ${s1.endMs - s1.startMs} ms（牆上時間 ${wall1 - wall0} ms）`);
      assert.ok(wall1 - wall0 >= 1500, '真的有等');
      const recorded2 = s2.endMs - s2.startMs;
      assert.ok(wall2 - wall1 - recorded2 >= 1200, `等換頁的時間要不在影片裡：步驟 ${recorded2} ms、牆上 ${wall2 - wall1} ms`);
      assert.ok(recorded2 < 2500, `步驟 2 太長：${recorded2} ms`);
      const press = ev.events.find((e) => e.type === 'press');
      assert.ok(press && press.type === 'press' && press.key === 'Enter' && press.atMs >= s3.startMs && press.atMs <= s3.endMs, JSON.stringify(press));
      assert.equal(await page.locator('#q').evaluate((el) => getComputedStyle(el).backgroundColor), 'rgb(0, 255, 0)', 'Enter 真的送到頁面');
    } finally {
      await t.dispose();
    }
  } finally {
    await browser.close();
    srv.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 同路徑只改查詢字串 vs 同網址整頁重載 ──────────────────────

/** 影片每一格在圖片中心（CSS 200,200 → 影片 300,300）的顏色（只裁那一個像素，clip 再長都不會爆記憶體）。 */
function centerColors(clip: string): [number, number, number][] {
  // yuv420p 裁 1×1 會失敗（色度要偶數），裁 2×2 取左上那一個像素
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', clip, '-vf', 'crop=2:2:300:300', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 24 });
  return Array.from({ length: buf.length / 12 }, (_, k) => [buf[k * 12], buf[k * 12 + 1], buf[k * 12 + 2]]);
}
const isRed = ([r, g, b]: number[]) => r > 200 && g < 60 && b < 60;
const isBlue = ([r, g, b]: number[]) => b > 200 && r < 60 && g < 60;
const isOrange = ([r, g, b]: number[]) => r > 200 && g > 100 && g < 180 && b < 60;
const isGray = ([r, g, b]: number[]) => [r, g, b].every((v) => v > 200 && v < 250) && Math.abs(r - b) < 12;

/** 首頁：一張 800 ms 才回應的紅圖（沒載好是灰底）；篩選連結只改查詢字串（replaceState／pushState），先橘色「載入中」400 ms 再變藍。 */
async function filterSite(page: Page): Promise<void> {
  const png = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=200x200', '-frames:v', '1', '-f', 'image2', '-c:v', 'png', '-']);
  const doc = `<body style="margin:0;background:#fff">
<div id=box style="position:absolute;left:100px;top:100px;width:200px;height:200px;background:#eee"><img src="/red.png" style="width:200px;height:200px;display:block"></div>
<a id=replace href="/?f=1" style="position:absolute;left:500px;top:150px;font-size:40px">篩選 1</a>
<a id=push href="/?f=2" style="position:absolute;left:800px;top:150px;font-size:40px">篩選 2</a>
<a id=reload href="/" style="position:absolute;left:500px;top:400px;font-size:40px">重載</a>
<script>
  function filter(ev, how, url) {
    ev.preventDefault();
    history[how]({}, '', url);
    const box = document.getElementById('box');
    box.innerHTML = ''; box.style.background = '#ff8c00';           // 載入中（橘）
    setTimeout(() => { box.style.background = '#00f'; }, 400);       // 篩好了（藍）
  }
  document.getElementById('replace').onclick = (e) => filter(e, 'replaceState', '/?f=1');
  document.getElementById('push').onclick = (e) => filter(e, 'pushState', '/?f=2');
</script></body>`;
  await page.route('http://tutorial.test/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/red.png') {
      await new Promise((r) => setTimeout(r, 800));
      return route.fulfill({ body: png, contentType: 'image/png' });
    }
    return route.fulfill({ contentType: 'text/html', body: doc });
  });
}

/** 首頁：紅色方塊＋一個 GET 表單（action=/two）；/two 是 800 ms 才回應的藍圖（沒載好是灰底）。 */
async function formSite(page: Page): Promise<void> {
  const png = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=200x200', '-frames:v', '1', '-f', 'image2', '-c:v', 'png', '-']);
  await page.route('http://tutorial.test/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/blue.png') {
      await new Promise((r) => setTimeout(r, 800));
      return route.fulfill({ body: png, contentType: 'image/png' });
    }
    if (path === '/two') {
      return route.fulfill({ contentType: 'text/html', body: `<body style="margin:0;background:#fff"><img src="/blue.png" style="position:absolute;left:100px;top:100px;width:200px;height:200px;background:#eee"></body>` });
    }
    return route.fulfill({
      contentType: 'text/html',
      body: `<body style="margin:0;background:#fff"><div style="position:absolute;left:100px;top:100px;width:200px;height:200px;background:#f00"></div>
<form action="/two" method="get"><input id=q name=q style="position:absolute;left:100px;top:400px;width:300px;height:40px;font-size:24px"></form></body>`,
    });
  });
}

test('press：在表單裡按 Enter 送出而換到慢圖頁——跟 click 共用換頁監看，從按下那一刻起回溯暫停，影片裡沒有載入過程（沒有灰圖格），press 與 url 同一時刻', { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tutorial-press-nav-'));
  const browser = await launchTutorialBrowser();
  try {
    const page = await newTutorialPage(browser);
    await formSite(page);
    const t = await startChapter({ page, outDir: join(root, 'run'), chapter: '測試｜Enter 送出', tts: silentProvider(), slots: { dir: join(root, 'slots') } });
    try {
      await t.goto('http://tutorial.test/');
      await t.step({ caption: '打字後按 Enter 送出' }, async () => {
        await t.type(page.locator('#q'), 'abc');
        await t.press('Enter');
        await t.wait(500);
      });
      const { clip, events } = await t.finish();
      const ev = JSON.parse(readFileSync(events, 'utf8')) as ChapterEvents;
      const press = ev.events.find((e) => e.type === 'press');
      const two = ev.events.find((e) => e.type === 'url' && new URL(e.url).pathname === '/two');
      assert.ok(press && press.type === 'press' && two && two.type === 'url', JSON.stringify(ev.events.filter((e) => e.type !== 'move')));
      assert.ok(Math.abs(two.atMs - press.atMs) <= 1, `url ${two.atMs} vs press ${press.atMs}（換頁要從按下那一刻起回溯暫停）`);
      const colors = centerColors(clip);
      const frameMs = 1000 / ev.clip.fps;
      const before = colors.slice(Math.round(press.atMs / frameMs) - 8, Math.round(press.atMs / frameMs) - 1);
      const after = colors.slice(Math.round(press.atMs / frameMs) + 1);
      assert.ok(before.length >= 5 && before.every(isRed), `按下前應是紅色方塊：${JSON.stringify(before)}`);
      assert.ok(after.length >= 10 && after.every(isBlue), `按下後每一格都要是載好的藍圖：灰 ${after.filter(isGray).length} 格、藍 ${after.filter(isBlue).length} 格／${after.length}`);
      assert.ok(!ev.quality!.warnings.some((w) => w.includes('還沒載好')), ev.quality!.warnings.join('\n'));
    } finally {
      await t.dispose();
    }
  } finally {
    await browser.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('同路徑只改查詢字串（replaceState／pushState）不算換頁：UI 過程保留、url 晚於或等於 click 且沒有回溯暫停；同網址整頁重載仍算換頁、沒有灰圖', { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tutorial-filter-'));
  const browser = await launchTutorialBrowser();
  try {
    const page = await newTutorialPage(browser);
    await filterSite(page);
    const t = await startChapter({ page, outDir: join(root, 'run'), chapter: '測試｜篩選', tts: silentProvider(), slots: { dir: join(root, 'slots') } });
    try {
      await t.goto('http://tutorial.test/');
      await t.step({ caption: 'replaceState 篩選' }, async () => {
        await t.click(page.locator('#replace'));
        await t.wait(600);
      });
      await t.step({ caption: 'pushState 篩選' }, async () => {
        await t.click(page.locator('#push'));
        await t.wait(600);
      });
      await t.step({ caption: '同網址整頁重載' }, async () => {
        await t.click(page.locator('#reload'));
        await t.wait(500);
      });
      const { clip, events } = await t.finish();
      const ev = JSON.parse(readFileSync(events, 'utf8')) as ChapterEvents;
      const colors = centerColors(clip);
      const frameMs = 1000 / ev.clip.fps;
      const at = (ms: number) => colors[Math.round(ms / frameMs)];
      const clicks = ev.events.filter((e) => e.type === 'click');
      const urls = ev.events.filter((e) => e.type === 'url');
      assert.equal(clicks.length, 3);
      for (const [i, q] of [['f=1', 0], ['f=2', 1]] as const) {
        const c = clicks[q];
        const u = urls.find((x) => x.url.includes(i));
        assert.ok(u, `沒記到 ${i}：${JSON.stringify(urls)}`);
        // 改網址在 click 事件裡同步發生，比「放開滑鼠＋畫出下一格」記下的 click 早幾毫秒是正常的；沒有回溯暫停就不會早於點擊前
        assert.ok(u.atMs >= c.atMs - 60 && u.atMs - c.atMs < 400, `${i}：url ${u.atMs} vs click ${c.atMs}`);
        // 點擊後 100～350 ms 要看到橘色「載入中」（過程保留），700 ms 後是藍
        for (const d of [120, 200, 300]) assert.ok(isOrange(at(c.atMs + d)), `${i} 點擊後 ${d} ms 應為橘（載入中）：${at(c.atMs + d)}`);
        assert.ok(isBlue(at(c.atMs + 750)), `${i} 點擊後 750 ms 應為藍：${at(c.atMs + 750)}`);
      }
      // 整頁重載：點下去直接切到載好的紅圖，不能有灰格
      const r = clicks[2];
      const after = colors.slice(Math.round(r.atMs / frameMs) + 1);
      assert.ok(after.length >= 10 && after.every(isRed), `重載後 ${after.filter(isGray).length} 格灰圖／${after.filter(isRed).length} 格紅`);
      assert.ok(!ev.quality!.warnings.some((w) => w.includes('還沒載好')), ev.quality!.warnings.join('\n'));
    } finally {
      await t.dispose();
    }
  } finally {
    await browser.close();
    rmSync(root, { recursive: true, force: true });
  }
});
