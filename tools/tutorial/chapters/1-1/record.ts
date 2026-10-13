// 1-1｜訪客｜首頁與導覽（分鏡 §4 第 1 章）。
//   INSTANCE=2 tools/tutorial/env/reset.sh && node chapters/1-1/setup.mjs && node chapters/1-1/record.ts
// 成品：~/work/tutorial-out/chapters/1-1/1-1.mp4＋events.json（run 目錄在 runs/ 下）。

import { copyFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { launchTutorialBrowser, newTutorialPage, renderChapter, startChapter, type Chapter } from '../../engine/index.ts';

const ID = '1-1';
const BASE = process.env.TUTORIAL_BASE ?? 'http://localhost:3302';

const browser = await launchTutorialBrowser();
let chapter: Chapter | undefined;
try {
  const page = await newTutorialPage(browser);
  const main = page.getByRole('main');
  const region = (name: string) => main.getByRole('region', { name, exact: true });
  const t = (chapter = await startChapter({ page, id: ID, chapter: '訪客｜首頁與導覽', baseURL: BASE, displayOrigin: 'test.fju.roy422.dev' }));
  console.log(`錄影目錄：${t.outDir}`);
  await t.goto('/');

  await t.step({
    caption: '打開專題平台首頁',
    narration: '這是輔大資管系專題平台的首頁，不用登入就能看。右上角只有橘色「登入」，表示現在是訪客。',
    status: 'ok', note: 'story-1 第 2 步',
  }, async () => {
    await t.hover(main.getByRole('heading', { level: 1, name: '輔仁大學資訊管理學系專題管理平台' }));
    await t.wait(1200);
    await t.hover(page.getByRole('banner').getByRole('link', { name: '登入', exact: true }));
  });

  await t.step({
    caption: '導覽列與下拉選單',
    narration: '導覽列有最新公告、專題規則、優秀專題、榮譽榜四項。競賽資訊收在最新公告的下拉裡。',
    status: 'pending', note: 'UX N-15：競賽資訊藏在下拉，Roy 決定要不要放到第一層',
  }, async () => {
    const nav = page.getByRole('navigation', { name: '主導覽' });
    await t.hover(nav.getByRole('link', { name: '最新公告', exact: true }));
    await t.wait(800);
    await t.hover(nav.getByRole('link', { name: '公告列表', exact: true }));
    await t.wait(500);
    await t.hover(nav.getByRole('link', { name: '競賽資訊', exact: true }));
  });

  await t.step({
    caption: '首頁的公告區',
    narration: '往下是最新公告，左邊兩張照片卡是置頂與最新，右邊是列表；「查看更多」進公告列表。',
    status: 'ok', note: 'story-1 第 2 步',
  }, async () => {
    await t.scroll(region('最新公告'));
    await t.waitStable({ offRecord: true });
    await t.hover(region('最新公告').getByRole('link', { name: '查看更多' }));
  });

  await t.step({
    caption: '近期活動',
    narration: '系辦排的公開活動會出現在這裡，例如專題說明會。活動日期和公告內文現在是同一條時間線。',
    status: 'ok', note: 'UX N-01（10/13 已修：示範資料的日期與公告對齊）',
  }, async () => {
    await t.scroll(region('近期活動'));
    await t.hover(region('近期活動').getByRole('listitem').filter({ hasText: '專題說明會' }));
  });

  await t.step({
    caption: '優秀專題與榮譽',
    narration: '優秀專題是歷屆得獎作品的輪播；榮譽與競賽放得獎紀錄和進行中的競賽。',
    status: 'ok', note: 'UX N-02（10/13 已修：seed-demo 自帶 5 件優秀專題與 6 筆榮譽）',
  }, async () => {
    await t.scroll(region('優秀專題'));
    await t.waitStable({ offRecord: true });
    await t.hover(region('優秀專題').getByRole('listitem').first());
    await t.wait(600);
    await t.scroll(region('榮譽與競賽'));
    await t.waitStable({ offRecord: true });
    await t.hover(region('榮譽與競賽').getByRole('heading', { name: '榮譽與競賽' }));
  });

  await t.step({
    caption: '快速入口與系辦聯絡',
    narration: '最下面三欄是快速入口：規則、登入或我的入口、系辦聯絡。系辦聯絡照系網資料寫死，後台沒有地方改。',
    status: 'bad', note: 'P-35：系辦聯絡資訊、頂列、頁尾的管理入口，Roy 決定之後再做',
  }, async () => {
    await t.scroll(region('快速入口'));
    await t.hover(region('快速入口').getByRole('link', { name: /^電話/ }));
  });

  await t.step({
    caption: '頁尾',
    narration: '頁尾每頁都一樣：系所地址電話、內容連結、使用連結。業界合作也是請直接聯絡系辦。',
    status: 'bad', note: 'P-35（同上）',
  }, async () => {
    const footer = page.getByRole('contentinfo');
    await t.scroll(2000);
    await t.hover(footer.getByText('輔仁大學資訊管理學系', { exact: true }));
    await t.wait(500);
    await t.hover(footer.getByRole('link', { name: '02-2905-2666' }));
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
