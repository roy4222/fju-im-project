// 橫向與容器內捲動：比畫面寬的表格，操作欄在容器右下角看不到的地方，t.click 要自己把它捲出來再點對位置。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChapterEvents } from '../events.ts';
import { launchTutorialBrowser, newTutorialPage, startChapter } from '../recorder.ts';
import { silentProvider } from '../tts.ts';
import { CAPTURE_OPTS } from './env.ts';

const rows = Array.from({ length: 9 }, (_, i) => `<tr id=row${i + 1} style="height:60px"><td style="width:1500px">第 ${i + 1} 列</td><td>${i === 7 ? '<button id=act style="width:200px;height:50px;font-size:24px" onclick="this.textContent=\'已點\'">操作</button>' : '—'}</td></tr>`).join('');
const PAGE = `<body style="margin:0;font-size:20px">
<div style="height:300px;background:#f3f4f6">上面</div>
<div id=wrap style="width:1000px;height:300px;overflow:auto;border:2px solid #000">
  <table style="width:1800px;border-collapse:collapse">${rows}</table>
</div>
<div style="height:1500px">中間</div>
<p id=bottom style="font-size:30px">最底下的一行</p>
<div style="height:600px"></div>
</body>`;

test('已經看得到的元素 t.scroll(locator) 仍對齊到上方三分之一（第 1 輪的行為）：容器內的列對到容器上方三分之一、整頁再把它對到畫面上方三分之一；容器本身也一樣', { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tutorial-scroll-align-'));
  const browser = await launchTutorialBrowser();
  try {
    const page = await newTutorialPage(browser);
    await page.setContent(PAGE);
    const t = await startChapter({ page, outDir: join(root, 'run'), chapter: '測試｜對齊', tts: silentProvider(), slots: { dir: join(root, 'slots') }, ...CAPTURE_OPTS });
    try {
      const wrap = page.locator('#wrap');
      const row3 = page.locator('#row3');
      const vh = await page.evaluate(() => innerHeight);
      const [wrapTop0, row3Top0] = [(await wrap.boundingBox())!.y, (await row3.boundingBox())!.y];
      assert.ok(row3Top0 > 0 && row3Top0 + 60 < vh && wrapTop0 > 0, `一開始就看得到：row3 y=${row3Top0}、wrap y=${wrapTop0}`);
      await t.step({ caption: '捲到第 3 列' }, async () => {
        await t.scroll(row3);
      });
      const clientH = await wrap.evaluate((el) => el.clientHeight);
      const st = await wrap.evaluate((el) => el.scrollTop);
      assert.ok(Math.abs(st - (120 - clientH * 0.3)) <= 3, `容器內：第 3 列頂端對到容器上方三分之一（scrollTop ${st}，期望 ${120 - clientH * 0.3}）`);
      const row3Top = (await row3.boundingBox())!.y;
      assert.ok(Math.abs(row3Top - vh * 0.3) <= 3, `整頁：第 3 列頂端對到畫面上方三分之一（y=${row3Top}，期望 ${vh * 0.3}）`);
      await t.step({ caption: '捲到容器本身' }, async () => {
        await t.scroll(wrap);
      });
      const wrapTop = (await wrap.boundingBox())!.y;
      assert.ok(Math.abs(wrapTop - vh * 0.3) <= 3, `容器本身（本來就看得到）也對到上方三分之一（y=${wrapTop}）`);
      const { events } = await t.finish();
      const ev = JSON.parse(readFileSync(events, 'utf8')) as ChapterEvents;
      const scrolls = ev.events.filter((e) => e.type === 'scroll');
      assert.equal(scrolls.length, 2, JSON.stringify(scrolls));
      assert.ok(scrolls[0].type === 'scroll' && scrolls[0].dy > 0 && scrolls[0].dx == null && scrolls[1].type === 'scroll' && scrolls[1].dy < 0, JSON.stringify(scrolls));
    } finally {
      await t.dispose();
    }
  } finally {
    await browser.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('t.click 點比畫面寬的表格最右邊、容器下半的操作鈕：先橫向＋直向捲動容器，再照新位置算游標；t.scroll 支援 { x, within } 與 locator', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tutorial-scroll-'));
  const browser = await launchTutorialBrowser();
  try {
    const page = await newTutorialPage(browser);
    await page.setContent(PAGE);
    const t = await startChapter({ page, outDir: join(root, 'run'), chapter: '測試｜橫向捲動', tts: silentProvider(), slots: { dir: join(root, 'slots') }, ...CAPTURE_OPTS });
    try {
      const wrap = page.locator('#wrap');
      const act = page.locator('#act');
      assert.deepEqual(await wrap.evaluate((el) => [el.scrollLeft, el.scrollTop]), [0, 0]);
      await t.step({ caption: '點操作' }, async () => {
        await t.click(act, false);
      });
      assert.equal(await act.textContent(), '已點', '按鈕真的被點到');
      const [sl, st] = await wrap.evaluate((el) => [el.scrollLeft, el.scrollTop]);
      assert.ok(sl > 400 && st > 100, `容器要橫向與直向都捲過：scrollLeft ${sl}、scrollTop ${st}`);
      // 游標：點擊座標 ＝ 捲完後元素中心 × 1.5，而且在頁面區裡
      const box = (await act.boundingBox())!;
      const zoom = await page.evaluate(() => devicePixelRatio);
      await t.step({ caption: '容器往左捲 200、整頁往下 300、捲到最底下那行' }, async () => {
        await t.scroll({ x: -200, within: wrap });
        await t.scroll(300);
        await t.scroll(page.locator('#bottom'));
      });
      const [sl2] = await wrap.evaluate((el) => [el.scrollLeft, el.scrollTop]);
      assert.ok(Math.abs(sl - sl2 - 200) <= 2, `容器往左 200：${sl} → ${sl2}`);
      const bottomBox = (await page.locator('#bottom').boundingBox())!;
      const vh = await page.evaluate(() => innerHeight);
      assert.ok(bottomBox.y > 0 && bottomBox.y < vh * 0.45, `locator 捲到畫面上方三分之一附近：y=${bottomBox.y}（viewport ${vh}）`);
      const { events } = await t.finish();
      const ev = JSON.parse(readFileSync(events, 'utf8')) as ChapterEvents;
      const click = ev.events.find((e) => e.type === 'click')!;
      assert.ok(click.type === 'click');
      assert.ok(Math.abs(click.x - (box.x + box.width / 2) * zoom) <= 2 && Math.abs(click.y - (box.y + box.height / 2) * zoom) <= 2, `click ${click.x},${click.y} vs 元素中心 ${(box.x + box.width / 2) * zoom},${(box.y + box.height / 2) * zoom}`);
      assert.ok(click.x > 0 && click.x < ev.page.width * zoom && click.y > 0 && click.y < ev.page.height * zoom, '點在頁面區內');
      const scrolls = ev.events.filter((e) => e.type === 'scroll');
      assert.ok(scrolls.length >= 4, JSON.stringify(scrolls));
      const auto = scrolls[0];
      assert.ok(auto.type === 'scroll' && (auto.dx ?? 0) > 600 && auto.dy > 150, `自動捲動要含橫向與直向（影片像素）：${JSON.stringify(auto)}`);
      assert.ok(scrolls.some((s) => s.type === 'scroll' && Math.abs((s.dx ?? 0) + 300) <= 3 && s.dy === 0), `{ x: -200, within } → dx −300：${JSON.stringify(scrolls)}`);
      assert.ok(scrolls.some((s) => s.type === 'scroll' && s.dx == null && Math.abs(s.dy - 450) <= 3), `scroll(300) → dy 450：${JSON.stringify(scrolls)}`);
      assert.ok(scrolls.every((s) => s.type === 'scroll' && s.endMs > s.startMs && s.endMs - s.startMs >= 500), '每段捲動都是平滑的（≥ 500 ms）');
    } finally {
      await t.dispose();
    }
  } finally {
    await browser.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// #412：系辦帳號表那種「黏頂列＋黏住的表頭」，自動捲動要扣掉它們，不然列被捲到表頭底下、點擊落在表頭上。
const stickyRows = (id: string, n: number) =>
  Array.from({ length: n }, (_, i) => `<tr style="height:50px"><td style="width:600px">第 ${i + 1} 列</td><td><button id=${id}${i + 1} style="width:120px;height:36px" onclick="this.textContent='已點'">恢復</button></td></tr>`).join('');
const STICKY_PAGE = `<body style="margin:0;font-size:18px">
<header style="position:sticky;top:0;height:56px;background:#333;color:#fff;z-index:50">黏頂列</header>
<div id=wrap style="width:900px;height:300px;overflow:auto">
  <table style="width:100%;border-collapse:collapse">
    <thead class=hd style="position:sticky;top:0;background:#ccc;z-index:10"><tr style="height:60px"><th>名稱</th><th>操作</th></tr></thead>
    <tbody>${stickyRows('c', 12)}</tbody>
  </table>
</div>
<div style="height:300px"></div>
<table id=tbl style="width:800px;border-collapse:collapse">
  <thead class=hd style="position:sticky;top:56px;background:#ccc;z-index:10"><tr style="height:40px"><th>名稱</th><th>操作</th></tr></thead>
  <tbody>${stickyRows('w', 12)}</tbody>
</table>
<div style="height:1200px"></div>
<script>window.headClicks = 0; document.querySelectorAll('.hd').forEach((h) => h.addEventListener('click', () => window.headClicks++));</script>
</body>`;

test('t.click 扣掉黏住的表頭與黏頂列（#412）：整頁表格最後一列被黏住的表頭蓋住、容器捲到底後點第一列，捲完都點得到按鈕、不會點到表頭', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tutorial-scroll-sticky-'));
  const browser = await launchTutorialBrowser();
  try {
    const page = await newTutorialPage(browser);
    await page.setContent(STICKY_PAGE);
    const t = await startChapter({ page, outDir: join(root, 'run'), chapter: '測試｜黏住的表頭', tts: silentProvider(), slots: { dir: join(root, 'slots') }, ...CAPTURE_OPTS });
    try {
      const covered = async (id: string) =>
        page.locator(`#${id}`).evaluate((el) => {
          const b = el.getBoundingClientRect();
          const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
          return !(hit && (hit === el || el.contains(hit)));
        });
      // 容器捲到底：第一列在容器上方看不到，以前捲到「容器頂端＋24」，按鈕中心在 60 px 高的表頭底下
      await page.locator('#wrap').evaluate((el) => el.scrollTo(0, el.scrollHeight));
      // 整頁：最後一列剛好在黏頂列下面，被黏在 56 px 的表頭蓋住（中心在網址列安全區以下，以前不捲）
      const lastTop = await page.locator('#w12').evaluate((el) => el.closest('tr')!.getBoundingClientRect().top + scrollY);
      await page.evaluate((y) => scrollTo(0, y - 60), lastTop);
      assert.ok(await covered('w12'), '前提：最後一列一開始被黏住的表頭蓋住');
      await t.step({ caption: '點整頁最後一列與容器第一列' }, async () => {
        await t.click(page.locator('#w12'), false);
        assert.ok(!(await covered('w12')), '最後一列捲完沒被蓋住');
        await t.click(page.locator('#c1'), false);
        assert.ok(!(await covered('c1')), '容器第一列捲完沒被蓋住');
      });
      assert.equal(await page.locator('#c1').textContent(), '已點', '容器第一列的按鈕被點到');
      assert.equal(await page.locator('#w12').textContent(), '已點', '最後一列的按鈕被點到');
      assert.equal(await page.evaluate(() => (window as unknown as { headClicks: number }).headClicks), 0, '沒有點到表頭');
      const { events } = await t.finish();
      const ev = JSON.parse(readFileSync(events, 'utf8')) as ChapterEvents;
      assert.equal(ev.events.filter((e) => e.type === 'click').length, 2);
      assert.ok(ev.events.filter((e) => e.type === 'scroll').length >= 2, '兩次都有自動捲動');
    } finally {
      await t.dispose();
    }
  } finally {
    await browser.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// #807 Review：比「沒被蓋住的可見區」還高的元素，捲完中心一定要在可見區裡（點擊打在中心）。
async function clickTall(html: string, before: (page: import('playwright').Page) => Promise<void>, chapter: string) {
  const root = mkdtempSync(join(tmpdir(), 'tutorial-scroll-tall-'));
  const browser = await launchTutorialBrowser();
  try {
    const page = await newTutorialPage(browser);
    await page.setContent(html);
    await before(page);
    const t = await startChapter({ page, outDir: join(root, 'run'), chapter, tts: silentProvider(), slots: { dir: join(root, 'slots') }, ...CAPTURE_OPTS });
    try {
      await t.step({ caption: '點很高的元素' }, async () => {
        await t.click(page.locator('#tall'), false);
      });
      assert.equal(await page.locator('#tall').textContent(), '已點', '很高的元素被點到');
      await t.finish();
    } finally {
      await t.dispose();
    }
  } finally {
    await browser.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test('黏頂列＋比畫面還高的元素（整頁）：捲完中心在沒被蓋住的範圍裡，點得到', { timeout: 90_000 }, async () => {
  await clickTall(
    `<body style="margin:0;font-size:18px">
<header style="position:sticky;top:0;height:56px;background:#333;color:#fff;z-index:50">黏頂列</header>
<div style="height:900px"></div>
<button id=tall style="display:block;width:400px;height:1300px" onclick="this.textContent='已點'">很高</button>
<div style="height:1500px"></div>
</body>`,
    async () => {},
    '測試｜整頁很高的元素',
  );
});

test('容器裡黏住的表頭＋比容器可見區還高的元素：捲完中心在容器可見區裡，點得到', { timeout: 90_000 }, async () => {
  const filler = Array.from({ length: 6 }, (_, i) => `<tr style="height:50px"><td>第 ${i + 3} 列</td></tr>`).join('');
  await clickTall(
    `<body style="margin:0;font-size:18px">
<div id=wrap style="width:600px;height:300px;overflow:auto">
  <table style="width:100%;border-collapse:collapse">
    <thead style="position:sticky;top:0;background:#ccc;z-index:10"><tr style="height:60px"><th>名稱</th></tr></thead>
    <tbody><tr style="height:50px"><td>第 1 列</td></tr><tr><td style="padding:0"><button id=tall style="display:block;width:300px;height:500px" onclick="this.textContent='已點'">很高</button></td></tr>${filler}</tbody>
  </table>
</div>
<div style="height:1200px"></div>
</body>`,
    (page) => page.locator('#wrap').evaluate((el) => el.scrollTo(0, el.scrollHeight)),
    '測試｜容器很高的元素',
  );
});
