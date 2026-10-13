// 格式樣片「1｜訪客前台（樣片）」：只讀測試站公開頁，不登入、不送出任何表單。
//   node engine/samples/visitor-sample.ts [輸出資料夾]   （預設 ~/work/tutorial-out）

import { homedir } from 'node:os';
import { join } from 'node:path';
import { launchTutorialBrowser, newTutorialPage, renderChapter, sayProvider, startChapter } from '../index.ts';

const outRoot = process.argv[2] ?? join(homedir(), 'work', 'tutorial-out');
const dir = join(outRoot, 'sample-visitor');

const browser = await launchTutorialBrowser();
const page = await newTutorialPage(browser);
const nav = (name: string) => page.getByRole('banner').getByRole('link', { name, exact: true });

const t = await startChapter({ page, outDir: dir, chapter: '訪客前台（樣片）', number: 1, baseURL: 'https://test.fju.roy422.dev', tts: sayProvider({ rate: 180 }) });
await t.offRecord(() => t.goto('/')); // 開頭直接是載好的首頁

await t.step({
  caption: '平台首頁：不用登入就能看',
  narration: '歡迎來到輔大資管系專題管理平台。這一段先示範，還沒登入的訪客可以看到哪些公開頁面。',
  status: 'ok', note: '公開頁面，免登入',
}, async () => {
  await t.hover(page.getByRole('heading', { level: 1 }));
});

await t.step({
  caption: '往下看：最新公告與近期活動',
  narration: '首頁往下捲，可以看到最新公告、近期活動，以及優秀專題和榮譽榜的精選。',
}, async () => {
  await t.scroll(page.getByRole('heading', { name: '最新公告', exact: true }));
  await t.wait(800);
  await t.scroll(page.getByRole('heading', { name: '優秀專題', exact: true }));
});

await t.step({
  caption: '點「查看更多」進入公告列表',
  narration: '想看全部公告，就點最新公告區塊右上角的查看更多。',
}, async () => {
  await t.scroll(page.getByRole('heading', { name: '最新公告', exact: true }));
  await t.click(page.getByRole('link', { name: '查看更多' }).first());
});

await t.step({
  caption: '用分類篩選公告',
  narration: '公告列表可以依分類篩選，例如只看競賽資訊。',
}, async () => {
  await t.click(page.getByRole('main').getByRole('link', { name: '競賽資訊', exact: true }));
});

await t.step({
  caption: '優秀專題：歷屆得獎作品',
  narration: '接著打開上方選單的優秀專題，這裡收錄歷屆校級優秀專題與競賽得獎作品。',
  status: 'warn', note: '測試站目前是示範屆別（DEMO）資料',
}, async () => {
  await t.click(nav('優秀專題'));
});

await t.step({
  caption: '依屆別篩選',
  narration: '上方的屆別按鈕可以只看某一屆，例如示範一一三屆。',
}, async () => {
  await t.click(page.getByRole('main').getByRole('link', { name: /示範 113 屆/ }));
});

await t.step({
  caption: '卡片上看得到屆別、組別與獎項',
  narration: '每張卡片標出屆別、組別和獎項；點開卡片可以看海報、說明，完整摘要與影片在詳情頁。',
}, async () => {
  await t.hover(page.getByRole('main').getByRole('listitem').getByRole('button').first());
  await t.wait(600);
  await t.hover(page.getByRole('main').getByRole('listitem').getByRole('button').nth(1));
});

await t.step({
  caption: '榮譽榜：系上得獎紀錄',
  narration: '榮譽榜整理系上學生的競賽得獎紀錄，可以依年度切換。',
}, async () => {
  await t.click(nav('榮譽榜'));
  await t.scroll(300);
});

await t.step({
  caption: '更多功能請登入',
  narration: '要繳交作業、填寫意願或查看分組，需要先登入。登入流程會在下一章示範。',
  status: 'pending', note: '登入流程在下一章',
}, async () => {
  await t.scroll(-300);
  await t.hover(page.getByRole('banner').getByRole('link', { name: '登入' }));
});

await t.finish();
await browser.close();
const { file, meta } = await renderChapter({ dir, out: join(outRoot, 'sample-visitor.mp4') });
console.log(`${file}  ${(meta.durationMs / 1000).toFixed(1)} 秒`);
