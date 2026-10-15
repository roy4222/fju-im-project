// 1-2｜訪客｜公告、競賽、規則（分鏡 §4 第 1 章）。
//   INSTANCE=2 tools/tutorial/env/reset.sh && node chapters/1-2/setup.mjs && node chapters/1-2/record.ts
// 成品：~/work/tutorial-out/chapters/1-2/1-2.mp4＋events.json（run 目錄在 runs/ 下）。

import { copyFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { launchTutorialBrowser, newTutorialPage, renderChapter, startChapter, type Chapter } from '../../engine/index.ts';

const ID = '1-2';
const BASE = process.env.TUTORIAL_BASE ?? 'http://localhost:3302';

const browser = await launchTutorialBrowser();
let chapter: Chapter | undefined;
try {
  const page = await newTutorialPage(browser);
  const main = page.getByRole('main');
  const nav = page.getByRole('navigation', { name: '主導覽' });
  const t = (chapter = await startChapter({ page, id: ID, chapter: '訪客｜公告、競賽、規則', baseURL: BASE, displayOrigin: 'test.fju.roy422.dev' }));
  console.log(`錄影目錄：${t.outDir}`);
  await t.goto('/');

  await t.step({
    caption: '公告列表',
    narration: '公告列表上面是分類，右邊有搜尋。訪客只看得到公開的公告。',
    status: { kind: 'ok', evidence: 'story-1 第 3 步' },
  }, async () => {
    await t.hover(nav.getByRole('link', { name: '最新公告', exact: true }));
    await t.wait(400);
    await t.click(nav.getByRole('link', { name: '公告列表', exact: true }));
    await t.hover(main.getByRole('navigation', { name: '公告分類' }));
    await t.wait(400);
    await t.hover(main.getByRole('searchbox', { name: '搜尋公告' }));
  });

  await t.step({
    caption: '用分類篩公告',
    narration: '點分類只看那一類；再點全部回到完整列表。',
    status: { kind: 'ok', evidence: 'story-1 第 3 步' },
  }, async () => {
    const cats = main.getByRole('navigation', { name: '公告分類' });
    await t.click(cats.getByRole('link', { name: '專題事務', exact: true }));
    await t.wait(1200);
    await t.click(cats.getByRole('link', { name: '全部', exact: true }));
  });

  await t.step({
    caption: '搜尋公告',
    narration: '搜尋是用標題找，按 Enter 才會送出。',
    status: { kind: 'ok', evidence: 'story-1 第 3 步' },
  }, async () => {
    await t.type(main.getByRole('searchbox', { name: '搜尋公告' }), '分組');
    await t.wait(300);
    await t.press('Enter'); // 畫面顯示鍵帽；送出後換網址（?q=）
    await page.waitForURL(/[?&]q=/);
    await t.waitStable();
    await t.hover(main.getByRole('link', { name: /114 學年度專題分組作業與指導老師意願調查開始受理/ }));
  });

  await t.step({
    caption: '公告內頁與附件',
    narration: '內頁有全文和附件，訪客也能下載。右邊是同分類公告。內文寫產學組由老師「認領」，要不要改「擔任指導老師」等你圈選。',
    status: { kind: 'pending', say: '「認領」要不要改說法', evidence: '用詞#12；內頁本身 ✅ story-2 第 19 步' },
  }, async () => {
    await t.click(main.getByRole('link', { name: /114 學年度專題分組作業與指導老師意願調查開始受理/ }));
    const article = main.getByRole('article');
    await t.scroll(article.getByRole('region', { name: '附件' }));
    await t.hover(article.getByRole('region', { name: '附件' }).getByRole('link').first());
    await t.wait(400);
    await t.hover(main.getByRole('complementary').getByRole('heading', { name: '同分類公告' }));
    await t.wait(400);
    await t.hover(article.getByText(/產學合作組別則由老師直接認領/));
  });

  await t.step({
    caption: '競賽資訊',
    narration: '競賽資訊其實是分類為「競賽資訊」的公告，狀態用截止日和活動日自動算。',
    status: { kind: 'ok', evidence: 'story-1 第 3 步；系辦那頭的入口混淆見 5B-4' },
  }, async () => {
    await t.hover(nav.getByRole('link', { name: '最新公告', exact: true }));
    await t.wait(400);
    await t.click(nav.getByRole('link', { name: '競賽資訊', exact: true }));
    await t.click(main.getByRole('navigation', { name: '狀態篩選' }).getByRole('link', { name: '報名中', exact: true }));
  });

  await t.step({
    caption: '專題規則與目錄',
    narration: '專題規則九節，左邊目錄點了會跳到那一節。這一節講產學組可以優先指定，但沒有白話解釋產學組是什麼，新生和高中生看不懂。',
    status: { kind: 'pending', say: '產學組要不要補白話解釋', evidence: 'UX N-11、N-14' },
  }, async () => {
    await t.click(nav.getByRole('link', { name: '專題規則', exact: true }));
    await t.click(main.getByRole('navigation', { name: '規則目錄' }).getByRole('link', { name: '四、專題分組、選取指導老師' }));
    await t.waitStable();
    await t.hover(main.getByText(/註四：若老師有產學合作/));
  });

  await t.step({
    caption: '規則章節順序',
    narration: '規則每一節是系辦在專題事務發布的一筆內容，但章節順序沒有地方調。',
    status: { kind: 'bad', say: '規則章節順序不能調', evidence: 'P-34' },
  }, async () => {
    await t.scroll(main.getByRole('region', { name: '九、獎懲方式' }));
    await t.hover(main.getByRole('heading', { name: '九、獎懲方式' }));
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
