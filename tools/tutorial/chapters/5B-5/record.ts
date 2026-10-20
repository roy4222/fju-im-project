// 5B-5 系辦｜檔案與前台編輯首頁（分鏡 storyboard.md §4 5B-5）。
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
    page, id: ID, chapter: '系辦｜檔案與前台編輯首頁', outRoot: join(out, 'runs'),
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
    narration: '檔案在側欄「公告與作業」的最後一個分頁，列全站檔案：類型、用在哪裡、上傳者、大小、是否使用中。',
    status: { kind: 'ok', evidence: 'story-2 第 35 步' },
  }, async () => {
    await t.click(nav('公告與作業'));
    await t.click(page.getByRole('navigation', { name: '公告與作業分頁' }).getByRole('link', { name: '檔案', exact: true }));
    await t.hover(main.getByText(/個檔案・/).first());
    await t.hover(main.getByRole('group', { name: '類型' }));
  });

  await t.step({
    caption: '被引用的檔案不能刪',
    narration: '還在被公告或繳交引用的檔案不能刪，點「去移除使用處」跳到那筆內容。這頁只能看和下載，沒有上傳和刪除。',
    status: { kind: 'warn', say: '只能看，不能刪除檔案', evidence: '規格 10 FIL-01／FIL-02；story-2 第 35 步' },
  }, async () => {
    await t.type(main.getByRole('searchbox').or(main.getByPlaceholder('搜尋檔名')).first(), '專案計畫書');
    const row = main.getByRole('table', { name: '檔案列表' }).getByRole('row').nth(1);
    await t.hover(row.getByRole('cell').nth(2));
    await t.hover(row.getByRole('link', { name: '去移除使用處' }).or(row.getByText('使用中')).first());
  });

  const layer = page.getByTestId('front-edit-layer');
  const editor = page.getByRole('dialog');

  await t.step({
    caption: '首頁改在前台直接編輯',
    narration: '後台不再有「首頁設定」頁。系辦回到前台首頁，右下角按「編輯頁面」，要改的區塊就出現虛線框和「編輯」；只有系辦看得到，訪客一個位元組都不多。',
    status: { kind: 'ok', evidence: 'story-4 第 9 步；C2-16／C2-17 首頁設定搬到前台編輯' },
  }, async () => {
    await t.goto('/');
    await t.click(page.getByRole('button', { name: '編輯頁面' }));
    await t.waitStable({ ready: layer });
    await t.hover(layer.getByRole('button', { name: '編輯首頁橫幅' }));
  });

  await t.step({
    caption: '換大圖與標語',
    narration: '按首頁橫幅的「編輯」，上傳圖、填說明和兩行標語，按儲存就生效，訪客重新整理就看到，沒有發布步驟。',
    status: { kind: 'ok', evidence: 'story-4 第 9 步；C2-17 首頁橫幅表單' },
  }, async () => {
    await t.click(layer.getByRole('button', { name: '編輯首頁橫幅' }));
    await t.waitStable({ ready: editor.getByRole('textbox', { name: /^標語第一行/ }) });
    await t.upload(editor.getByLabel('選擇首頁大圖'), jpg, { via: editor.getByText('上傳圖片', { exact: true }) });
    await t.waitStable({ ready: editor.getByText('（儲存後才會換上）') });
    await t.type(editor.getByLabel(/^圖片說明/), '示範圖片');
    await t.type(editor.getByLabel(/^標語第一行/), '示範：專題成果，從這裡開始');
    await t.type(editor.getByLabel(/^標語第二行/), '示範標語：輔大資管系專題平台');
    await t.click(editor.getByRole('button', { name: '儲存', exact: true }));
    const saved = page.getByRole('status').filter({ hasText: '已儲存' });
    await t.waitStable({ ready: saved });
    await t.hover(saved);
  });

  await t.step({
    caption: '看結果',
    narration: '前台首頁的大標和說明已經換了。頁尾聯絡、隱私權政策、三張快速入口卡也是同樣在原頁按「編輯」。',
    status: { kind: 'ok', evidence: 'P-35；story-4 N-57；C2-17 頁尾、快速入口、隱私權可前台編輯' },
  }, async () => {
    await t.hover(page.getByRole('heading', { level: 1 }));
    await t.wait(2500);
    await t.scroll(page.getByRole('contentinfo'));
    await t.hover(layer.getByRole('button', { name: /^編輯/ }).last());
  });

  await t.step({
    caption: '恢復預設',
    narration: '要恢復預設，打開首頁橫幅的編輯，按「改用預設照片」，把兩行標語清空再儲存，就回到校園照和預設標語。',
    status: { kind: 'ok', evidence: 'story-4 第 9 步；C2-17 恢復預設併進橫幅表單' },
  }, async () => {
    await t.scroll(0 - 5000);
    await t.click(layer.getByRole('button', { name: '編輯首頁橫幅' }));
    await t.waitStable({ ready: editor.getByRole('button', { name: '改用預設照片' }) });
    await t.click(editor.getByRole('button', { name: '改用預設照片' }));
    await editor.getByLabel(/^標語第一行/).fill('');
    await editor.getByLabel(/^標語第二行/).fill('');
    await t.hover(editor.getByText(/就是恢復預設/));
    await t.click(editor.getByRole('button', { name: '儲存', exact: true }));
    const saved = page.getByRole('status').filter({ hasText: '已儲存' });
    await t.waitStable({ ready: saved });
    await t.hover(saved);
    await t.click(page.getByRole('button', { name: '完成編輯' }));
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
