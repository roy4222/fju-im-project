// 1-3｜訪客｜優秀專題與榮譽榜（分鏡 §4 第 1 章）。
//   INSTANCE=2 tools/tutorial/env/reset.sh && node chapters/1-3/setup.mjs && node chapters/1-3/record.ts
// 成品：~/work/tutorial-out/chapters/1-3/1-3.mp4＋events.json（run 目錄在 runs/ 下）。

import { copyFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { launchTutorialBrowser, newTutorialPage, renderChapter, startChapter, type Chapter } from '../../engine/index.ts';

const ID = '1-3';
const BASE = process.env.TUTORIAL_BASE ?? 'http://localhost:3302';

const browser = await launchTutorialBrowser();
let chapter: Chapter | undefined;
try {
  const page = await newTutorialPage(browser);
  const main = page.getByRole('main');
  const nav = page.getByRole('navigation', { name: '主導覽' });
  const dialog = page.getByRole('dialog');
  const t = (chapter = await startChapter({ page, id: ID, chapter: '訪客｜優秀專題與榮譽榜', baseURL: BASE, displayOrigin: 'test.fju.roy422.dev' }));
  console.log(`錄影目錄：${t.outDir}`);
  await t.goto('/');

  await t.step({
    caption: '優秀專題列表',
    narration: '優秀專題只放有獎項的作品，可以依屆別篩、依獎項排序。',
    status: { kind: 'ok', evidence: 'UX N-02（10/13 已修）' },
  }, async () => {
    await t.click(nav.getByRole('link', { name: '優秀專題', exact: true }));
    await t.hover(main.getByRole('navigation', { name: '屆別篩選' }).getByRole('link', { name: '全部屆別' }));
    await t.select(main.getByRole('combobox', { name: '排序方式' }), '優秀專題優先');
    await t.waitStable();
  });

  await t.step({
    caption: '一圖一文對話框',
    narration: '點卡片開一圖一文：海報、獎項、屆別、組別；上一件下一件可以連著看。',
    status: { kind: 'ok', evidence: 'story-1 第 4 步' },
  }, async () => {
    await t.click(main.getByRole('button', { name: /城市微光：公共資訊可讀性改善/ }));
    await t.waitStable({ ready: dialog });
    await t.hover(dialog.getByRole('heading', { level: 2 }));
    await t.wait(600);
    await t.click(dialog.getByRole('button', { name: '下一件' }));
    await t.waitStable();
    await t.wait(600);
    // 回到「城市微光」：下一步看它的詳情頁（有影片入口）
    await t.click(dialog.getByRole('button', { name: '上一件' }));
    await t.waitStable({ ready: dialog.getByRole('heading', { name: '城市微光：公共資訊可讀性改善' }) });
  });

  await t.step({
    caption: '作品詳情頁',
    narration: '訪客可看摘要、海報及影片入口；組員與指導老師登入後才顯示。',
    status: { kind: 'ok', evidence: '既有保證（SHW-03）' },
  }, async () => {
    await t.click(dialog.getByRole('link', { name: '查看完整資料' }));
    const article = main.getByRole('article');
    await t.hover(article.getByRole('heading', { name: '摘要' }));
    await t.wait(400);
    await t.hover(main.getByRole('figure', { name: '成果海報' }));
    await t.wait(400);
    await t.hover(article.getByRole('link', { name: /播放三分鐘影片/ }));
    await t.wait(400);
    await t.hover(main.getByRole('link', { name: '回到優秀專題' }));
  });

  await t.step({
    caption: '榮譽榜',
    narration: '榮譽榜收得獎紀錄和照片，依年份篩。說明裡的「歷屆專題」現在可以點。',
    status: { kind: 'ok', evidence: 'UX N-13（10/13 已修）' },
  }, async () => {
    await t.click(nav.getByRole('link', { name: '榮譽榜', exact: true }));
    await t.hover(main.getByRole('navigation', { name: '年份篩選' }));
    await t.wait(300);
    await t.hover(main.getByRole('link', { name: '歷屆專題' }));
    await t.wait(300);
    await t.click(main.getByRole('button', { name: /全國大專校院資訊應用服務創新競賽/ }).first());
    await t.waitStable({ ready: dialog });
  });

  await t.step({
    caption: '榮譽榜排序',
    narration: '排序切換馬上生效，不用重新整理。',
    status: { kind: 'ok', evidence: '既有保證' },
  }, async () => {
    await t.click(dialog.getByRole('button', { name: '關閉' }));
    await t.select(main.getByRole('combobox', { name: '排序方式' }), '日期（舊到新）');
    await t.waitStable();
    await t.hover(main.getByRole('listitem').first());
  });

  await t.finish();
} finally {
  await chapter?.dispose();
  await browser.close();
}

const { file, meta } = await renderChapter({ dir: chapter!.outDir });
const dest = join(homedir(), 'work', 'tutorial-out', 'chapters', ID);
mkdirSync(dest, { recursive: true });
copyFileSync(file, join(dest, `${ID}.mp4`));
copyFileSync(join(chapter!.outDir, 'events.json'), join(dest, 'events.json'));
console.log(`${join(dest, `${ID}.mp4`)}  ${(meta.durationMs / 1000).toFixed(1)} 秒（run：${chapter!.outDir}）`);
