// 1-4｜訪客｜需要登入的頁與找不到頁面（分鏡 §4 第 1 章）。
//   INSTANCE=2 tools/tutorial/env/reset.sh && node chapters/1-4/setup.mjs && node chapters/1-4/record.ts
// 成品：~/work/tutorial-out/chapters/1-4/1-4.mp4＋events.json（run 目錄在 runs/ 下）。
// 分鏡的動作是「goto」：換頁本身不進影片，畫面直接切到被帶去的登入頁（假網址列顯示實際網址 /login?next=…）。

import { copyFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { launchTutorialBrowser, newTutorialPage, renderChapter, startChapter, type Chapter } from '../../engine/index.ts';

const ID = '1-4';
const BASE = process.env.TUTORIAL_BASE ?? 'http://localhost:3302';

const browser = await launchTutorialBrowser();
let chapter: Chapter | undefined;
try {
  const page = await newTutorialPage(browser);
  const main = page.getByRole('main');
  const note = main.getByText('登入後會回到你原本要去的頁面。');
  const t = (chapter = await startChapter({ page, id: ID, chapter: '訪客｜需要登入的頁與找不到頁面', baseURL: BASE, displayOrigin: 'test.fju.roy422.dev' }));
  console.log(`錄影目錄：${t.outDir}`);
  await t.goto('/');

  await t.step({
    caption: '歷屆專題要登入',
    narration: '歷屆專題一覽要登入才能看。直接打網址會帶到登入頁，登入後回原頁。',
    status: { kind: 'ok', evidence: 'story-1 第 5 步' },
  }, async () => {
    await t.goto('/projects', { ready: note });
    await t.hover(note);
    await t.wait(400);
    await t.hover(main.getByRole('heading', { name: '登入', level: 1 }));
  });

  await t.step({
    caption: '產學合作要登入',
    narration: '產學合作的公司和需求也要登入；訪客導覽列不會出現這兩項。',
    status: { kind: 'ok', evidence: 'story-1 第 5 步' },
  }, async () => {
    await t.goto('/industry', { ready: note });
    await t.hover(note);
    await t.wait(400);
    await t.hover(page.getByRole('navigation', { name: '主導覽' }));
  });

  await t.step({
    caption: '檔案下載要登入',
    narration: '檔案下載同樣要登入，附件網址也一樣會被擋。',
    status: { kind: 'ok', evidence: 'story-4 第 23、28 步' },
  }, async () => {
    await t.goto('/files', { ready: note });
    await t.hover(note);
  });

  await t.step({
    caption: '後台網址要登入',
    narration: '打後台網址不會看到任何後台內容，一樣帶去登入。',
    status: { kind: 'ok', evidence: 'story-1 第 6 步' },
  }, async () => {
    await t.goto('/dashboard/admin', { ready: note });
    await t.hover(main.getByRole('heading', { name: '登入', level: 1 }));
  });

  await t.step({
    caption: '找不到頁面',
    narration: '打錯網址是中文的找不到頁面，有頁首頁尾和回首頁。',
    status: { kind: 'ok', evidence: 'story-1 第 6 步' },
  }, async () => {
    await t.goto('/news/不存在的-id', { ready: main.getByRole('heading', { name: '找不到這個頁面' }) });
    await t.hover(main.getByRole('heading', { name: '找不到這個頁面' }));
    await t.wait(400);
    await t.hover(main.getByRole('link', { name: '回首頁' }));
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
