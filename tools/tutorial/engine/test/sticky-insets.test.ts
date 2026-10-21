// t.click 捲動扣掉固定元素（#412）的頁面內函式：只量「可見區四邊被蓋掉多少」，不錄影，無頭瀏覽器就能跑（Linux 也行）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STICKY_INSETS_JS, launchTutorialBrowser } from '../recorder.ts';

type Box = { left: number; top: number; right: number; bottom: number };

// 黏頂列 56 px；表格在可捲容器裡、表頭黏在容器頂端 40 px、首欄黏在左邊 120 px；另一張表在整頁裡、表頭黏在黏頂列下面
const rows = (id: string, n: number) =>
  Array.from({ length: n }, (_, i) => `<tr style="height:50px"><td style="position:sticky;left:0;width:120px;padding:0;background:#eee">第 ${i + 1} 列</td><td style="width:1400px">—</td><td><button id=${id}${i + 1} style="width:100px;height:36px">操作</button></td></tr>`).join('');
const PAGE = `<body style="margin:0;font-size:16px">
<header id=hdr style="position:sticky;top:0;height:56px;background:#333;color:#fff;z-index:50">黏頂列</header>
<div id=wrap style="width:900px;height:300px;overflow:auto">
  <table style="width:1700px;border-collapse:collapse">
    <thead style="position:sticky;top:0;background:#ccc;z-index:10"><tr style="height:40px"><th>名稱</th><th>說明</th><th>操作</th></tr></thead>
    <tbody>${rows('c', 12)}</tbody>
  </table>
</div>
<div style="height:200px"></div>
<table style="width:800px;border-collapse:collapse">
  <thead style="position:sticky;top:56px;background:#ccc;z-index:10"><tr style="height:40px"><th>名稱</th><th>說明</th><th>操作</th></tr></thead>
  <tbody>${rows('w', 12)}</tbody>
</table>
<div id=toast style="position:fixed;bottom:0;left:0;width:300px;height:60px;pointer-events:none">不擋點擊的提示</div>
<div style="height:1200px"></div>
</body>`;

test('可見區四邊被 sticky／fixed 蓋掉的量：容器內的黏住表頭與首欄、整頁的黏頂列加上黏在它下面的表頭；pointer-events: none、不同欄、自己的祖先都不算', { timeout: 60_000 }, async () => {
  const browser = await launchTutorialBrowser({ headless: true });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 587 } })).newPage();
    await page.setContent(PAGE);
    const insets = (sel: string, within: string | null) =>
      page.locator(sel).evaluate(
        (el, { js, within }) => {
          const f = new Function(`return ${js}`)() as (el: Element, r: Box) => Box;
          if (!within) return f(el, { left: 0, top: 0, right: innerWidth, bottom: innerHeight });
          const sc = document.querySelector(within)!;
          const b = sc.getBoundingClientRect();
          return f(el, { left: b.left + sc.clientLeft, top: b.top + sc.clientTop, right: b.left + sc.clientLeft + sc.clientWidth, bottom: b.top + sc.clientTop + sc.clientHeight });
        },
        { js: STICKY_INSETS_JS, within },
      );

    // 容器捲到最底：表頭仍黏在容器頂端；操作鈕那一欄跟首欄不同列無關（首欄只蓋同一列的左邊）
    await page.locator('#wrap').evaluate((el) => el.scrollTo(400, 9999));
    const c = await insets('#c12', '#wrap');
    assert.equal(c.top, 40, `容器上邊被表頭蓋 40：${JSON.stringify(c)}`);
    assert.equal(c.left, 120, `同一列的黏住首欄蓋左邊 120：${JSON.stringify(c)}`);
    assert.equal(c.bottom, 0);
    assert.equal(c.right, 0);

    // 整頁：捲到第二張表的表頭黏在黏頂列下面 → 上邊 56＋40；fixed 的提示是 pointer-events: none，下邊不算
    const tableTop = await page.locator('table').nth(1).evaluate((el) => el.getBoundingClientRect().top + scrollY);
    await page.evaluate((y) => scrollTo(0, y), tableTop + 200);
    const w = await insets('#w8', null);
    assert.equal(w.top, 96, `黏頂列 56＋黏住的表頭 40：${JSON.stringify(w)}`);
    assert.equal(w.bottom, 0, `pointer-events: none 的提示不算：${JSON.stringify(w)}`);

    // 沒黏住、在畫面中間的表頭不算（不跟上邊相連）
    await page.evaluate((y) => scrollTo(0, y), tableTop - 300);
    const mid = await insets('#w8', null);
    assert.equal(mid.top, 56, `只有黏頂列：${JSON.stringify(mid)}`);

    // 目標本身在黏住的元素裡（點表頭、點黏頂列裡的按鈕）：自己的祖先不算
    const self = await insets('#hdr', null);
    assert.equal(self.top, 0, JSON.stringify(self));
  } finally {
    await browser.close();
  }
});
