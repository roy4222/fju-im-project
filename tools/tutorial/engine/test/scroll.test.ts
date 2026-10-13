// 橫向與容器內捲動：比畫面寬的表格，操作欄在容器右下角看不到的地方，t.click 要自己把它捲出來再點對位置。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChapterEvents } from '../events.ts';
import { launchTutorialBrowser, newTutorialPage, startChapter } from '../recorder.ts';
import { silentProvider } from '../tts.ts';

const rows = Array.from({ length: 9 }, (_, i) => `<tr style="height:60px"><td style="width:1500px">第 ${i + 1} 列</td><td>${i === 7 ? '<button id=act style="width:200px;height:50px;font-size:24px" onclick="this.textContent=\'已點\'">操作</button>' : '—'}</td></tr>`).join('');
const PAGE = `<body style="margin:0;font-size:20px">
<div style="height:300px;background:#f3f4f6">上面</div>
<div id=wrap style="width:1000px;height:300px;overflow:auto;border:2px solid #000">
  <table style="width:1800px;border-collapse:collapse">${rows}</table>
</div>
<div style="height:1500px">中間</div>
<p id=bottom style="font-size:30px">最底下的一行</p>
<div style="height:600px"></div>
</body>`;

test('t.click 點比畫面寬的表格最右邊、容器下半的操作鈕：先橫向＋直向捲動容器，再照新位置算游標；t.scroll 支援 { x, within } 與 locator', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tutorial-scroll-'));
  const browser = await launchTutorialBrowser();
  try {
    const page = await newTutorialPage(browser);
    await page.setContent(PAGE);
    const t = await startChapter({ page, outDir: join(root, 'run'), chapter: '測試｜橫向捲動', tts: silentProvider(), slots: { dir: join(root, 'slots') } });
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
