// 5B-5 系辦｜檔案管理與首頁設定（分鏡 storyboard.md §4 5B-5）。
//   INSTANCE=4 tools/tutorial/env/reset.sh && node tools/tutorial/chapters/5B-5/setup.mjs && node tools/tutorial/chapters/5B-5/record.ts
// 輸出：~/work/tutorial-out/chapters/5B-5/（runs/ 底下是每次錄影的 run 目錄，成品複製成 5B-5.mp4＋events.json）。
// TUTORIAL_SILENT=1 改用無聲配音（只試定位器、不出成品）。

import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { launchTutorialBrowser, newTutorialPage, renderChapter, silentProvider, startChapter, type Chapter } from '../../engine/index.ts';

const ID = '5B-5';
const n = Number(process.env.INSTANCE ?? 4);
const baseURL = `http://localhost:${3300 + n}`;
const out = join(homedir(), 'work', 'tutorial-out', 'chapters', ID);
const accounts = JSON.parse(readFileSync(join(homedir(), 'work', 'tutorial-secrets', n ? `accounts-${n}.json` : 'accounts.json'), 'utf8')).accounts;
const admin = accounts.find((a: { create?: string }) => a.create === 'admin');
const jpg = join(import.meta.dirname, '示範首頁大圖.jpg');

const browser = await launchTutorialBrowser();
let chapter: Chapter | undefined;
try {
  const page = await newTutorialPage(browser);
  const t = (chapter = await startChapter({
    page, id: ID, chapter: '系辦｜檔案管理與首頁設定', outRoot: join(out, 'runs'),
    baseURL, displayOrigin: 'test.fju.roy422.dev', ...(process.env.TUTORIAL_SILENT ? { tts: silentProvider() } : {}),
  }));
  console.log(`錄影目錄：${t.outDir}`);
  await t.offRecord(async () => {
    await page.context().clearCookies();
    await page.goto(`${baseURL}/login`);
    await page.getByLabel('Email').fill(admin.email);
    await page.getByLabel('密碼', { exact: true }).fill(admin.password);
    await page.getByRole('button', { name: '登入', exact: true }).click();
    await page.waitForURL((u) => u.pathname.startsWith('/dashboard/admin'));
  });
  const main = page.getByRole('main');
  const nav = (name: string) => page.getByRole('navigation').getByRole('link', { name, exact: true });
  await t.goto('/dashboard/admin');

  await t.step({
    caption: '檔案管理',
    narration: '檔案管理列全站檔案：類型、用在哪裡、上傳者、大小、是否使用中；主機用量在上面。',
    status: 'ok', note: 'story-2 第 35 步',
  }, async () => {
    await t.click(nav('檔案管理'));
    await t.hover(main.getByText(/個檔案・/).first());
    await t.hover(main.getByRole('group', { name: '類型' }));
  });

  await t.step({
    caption: '被引用的檔案不能刪',
    narration: '還在被公告或繳交引用的檔案不能刪，點「去移除使用處」跳到那筆內容。這頁只能看和下載，沒有上傳和刪除。',
    status: 'warn', note: '只能看：沒有刪除未使用檔案的按鈕（FIL-01／02）',
  }, async () => {
    await t.type(main.getByRole('searchbox').or(main.getByPlaceholder('搜尋檔名')).first(), '專案計畫書');
    const row = main.getByRole('table', { name: '檔案列表' }).getByRole('row').nth(1);
    await t.hover(row.getByRole('cell').nth(2));
    await t.hover(row.getByRole('link', { name: '去移除使用處' }).or(row.getByText('使用中')).first());
  });

  await t.step({
    caption: '首頁設定能改什麼',
    narration: '首頁設定只有大圖和兩行標語；存了就生效，沒有發布步驟。',
    status: 'ok', note: 'story-4 第 9 步',
  }, async () => {
    await t.click(nav('首頁設定'));
    await t.hover(main.getByText(/^首頁大圖（PNG 或 JPG/));
    await t.hover(main.getByLabel(/^標語第一行/));
    await t.hover(main.getByLabel(/^標語第二行/));
    await t.hover(main.getByRole('link', { name: '開新分頁看前台首頁' }));
  });

  await t.step({
    caption: '換大圖與標語',
    narration: '上傳圖、填說明和標語，儲存後訪客重新整理就看到。',
    status: 'ok', note: 'story-4 第 9 步',
  }, async () => {
    await t.upload(main.getByLabel('選擇首頁大圖'), jpg, { via: main.getByText('上傳圖片', { exact: true }) });
    await t.waitStable({ ready: main.getByText('（儲存後才會換上）'), offRecord: true });
    await t.type(main.getByLabel(/^圖片說明/), '示範圖片');
    await t.type(main.getByLabel(/^標語第一行/), '示範：專題成果，從這裡開始');
    await t.type(main.getByLabel(/^標語第二行/), '示範標語：輔大資管系專題平台');
    await t.click(main.getByRole('button', { name: '儲存並更新首頁' }));
    await t.waitStable({ ready: main.getByText(/^首頁已更新，訪客重新整理就會看到/), offRecord: true });
    await t.hover(main.getByText(/^首頁已更新，訪客重新整理就會看到/));
  });

  await t.step({
    caption: '到前台看結果',
    narration: '前台首頁大標和說明已經換了。榮譽區照片、系辦聯絡、頁尾還是寫死的。',
    status: 'bad', note: 'P-35（story-4 N-57）：其他區塊還不能改',
  }, async () => {
    // 「開新分頁看前台首頁」開的是新分頁，錄影只錄這一頁：直接在這一頁開首頁
    await t.goto('/');
    await t.hover(page.getByRole('heading', { level: 1 }));
    await t.scroll(page.getByRole('contentinfo'));
  });

  await t.step({
    caption: '恢復預設',
    narration: '恢復預設清回校園照和預設標語。',
    status: 'ok', note: 'story-4 第 9 步',
  }, async () => {
    await t.goto('/dashboard/admin/home-settings');
    await t.click(main.getByRole('region', { name: '恢復預設' }).getByRole('button', { name: '恢復預設' }));
    const d = page.getByRole('dialog', { name: '恢復首頁預設？' });
    await t.waitStable({ ready: d, offRecord: true });
    await t.click(d.getByRole('button', { name: '恢復預設' }));
    await t.waitStable({ ready: main.getByText(/^已恢復預設，訪客重新整理就會看到/), offRecord: true });
    await t.hover(main.getByText(/^已恢復預設，訪客重新整理就會看到/));
  });

  await t.finish();
} finally {
  await chapter?.dispose();
  await browser.close();
}
if (!process.env.TUTORIAL_SILENT) {
  const { file } = await renderChapter({ dir: chapter!.outDir });
  mkdirSync(out, { recursive: true });
  copyFileSync(file, join(out, `${ID}.mp4`));
  copyFileSync(join(chapter!.outDir, 'events.json'), join(out, 'events.json'));
  console.log(`成品：${join(out, `${ID}.mp4`)}`);
}
