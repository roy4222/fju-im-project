// 5B-1 系辦｜專題事務工作台與快速發布公告（分鏡 storyboard.md §4 5B-1）。
//   INSTANCE=4 tools/tutorial/env/reset.sh && node tools/tutorial/chapters/5B-1/setup.mjs && node tools/tutorial/chapters/5B-1/record.ts
// 輸出：~/work/tutorial-out/chapters/5B-1/（runs/ 底下是每次錄影的 run 目錄，成品複製成 5B-1.mp4＋events.json）。
// TUTORIAL_SILENT=1 改用無聲配音（只試定位器、不出成品）。

import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { launchTutorialBrowser, newTutorialPage, renderChapter, silentProvider, startChapter, type Chapter } from '../../engine/index.ts';

const ID = '5B-1';
const n = Number(process.env.INSTANCE ?? 4);
const baseURL = `http://localhost:${3300 + n}`;
const out = join(homedir(), 'work', 'tutorial-out', 'chapters', ID);
const accounts = JSON.parse(readFileSync(join(homedir(), 'work', 'tutorial-secrets', n ? `accounts-${n}.json` : 'accounts.json'), 'utf8')).accounts;
const admin = accounts.find((a: { create?: string }) => a.create === 'admin');
const pdf = join(import.meta.dirname, '示範檔案.pdf');

const browser = await launchTutorialBrowser();
let chapter: Chapter | undefined;
try {
  const page = await newTutorialPage(browser);
  const t = (chapter = await startChapter({
    page, id: ID, chapter: '系辦｜專題事務工作台與快速發布公告', outRoot: join(out, 'runs'),
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
  await t.goto('/dashboard/admin');

  const main = page.getByRole('main');
  const filter = (name: string) => main.getByRole('navigation', { name: '種類' }).getByRole('link', { name, exact: true });
  const dialog = page.getByRole('dialog', { name: '新增項目' });

  await t.step({
    caption: '專題事務是什麼',
    narration: '公告、資源下載、文件繳交、專題規則、榮譽都是「專題事務項目」，同一個入口管。名稱看不出包含這麼多，等 Roy 決定要不要改。',
    status: { kind: 'pending', say: '「專題事務」要不要改名', evidence: 'UX N-17' },
  }, async () => {
    await t.click(page.getByRole('navigation').getByRole('link', { name: '專題事務', exact: true }));
    await t.hover(main.getByText(/示範 114 屆（DEMO-114）・進行中/));
    await t.hover(filter('全部'));
    await t.hover(filter('榮譽'));
  });

  await t.step({
    caption: '列表怎麼看',
    narration: '每列寫狀態、誰看得到、截止、需要繳交幾組。「繳交」進名單頁、「編輯」進編輯器、「前台頁面」看學生看到的。',
    status: { kind: 'ok', evidence: 'story-2 第 43 步' },
  }, async () => {
    await t.click(filter('文件繳交'));
    await t.waitStable();
    const row = main.getByRole('listitem').filter({ hasText: '專題分組名單確認表' });
    await t.hover(row.getByText(/需要繳交 \d+ 組/));
    await t.hover(row.getByRole('link', { name: /^繳交：/ }));
    await t.hover(row.getByRole('link', { name: /^編輯：/ }));
    await t.click(filter('全部'));
    await t.waitStable();
    await t.hover(main.getByRole('link', { name: '前台頁面' }).first());
  });

  await t.step({
    caption: '快速建立：選類型、定對象',
    narration: '新增項目三步：先選類型、寫標題、選誰看得到。文件繳交只能發給本屆學生或指定組別。',
    status: { kind: 'ok', evidence: 'story-2 第 14～17 步' },
  }, async () => {
    await t.click(main.getByRole('button', { name: '新增項目' }));
    await t.waitStable({ ready: dialog.getByText('顯示在哪一區') });
    await t.click(dialog.getByText('公告', { exact: true }).first());
    await t.type(dialog.getByLabel('標題'), '示範：期中發表時間說明');
    await t.select(dialog.getByLabel('誰看得到'), '本屆學生');
    await t.click(dialog.getByRole('button', { name: /下一步/ }));
  });

  await t.step({
    caption: '快速建立：內容與附件',
    narration: '第二步寫說明、加附件；附件的下載權限跟著這一筆的對象走。',
    status: { kind: 'ok', evidence: 'story-2 第 16 步' },
  }, async () => {
    await t.type(dialog.getByLabel('說明'), '期中發表訂在第 9 週。各組報告 10 分鐘。');
    const picker = dialog.locator('label').filter({ hasText: '加入附件' });
    await t.upload(picker.locator('input[type=file]'), pdf, { via: picker });
    await t.waitStable({ ready: dialog.getByText('示範檔案.pdf') });
    await t.click(dialog.getByRole('button', { name: /下一步/ }));
  });

  await t.step({
    caption: '發布前檢查',
    narration: '發布前列出檢查結果，寫清楚勾了重要公告會通知幾個人，右邊是學生看到的樣子。',
    status: { kind: 'ok', evidence: 'story-2 N-12（10/12 已修）' },
  }, async () => {
    await t.hover(dialog.getByText('沒問題').first());
    await t.hover(dialog.getByText(/若勾選「重要公告」，會通知 \d+ 位/));
    await t.hover(dialog.getByText('學生看到的樣子'));
    await t.click(dialog.getByRole('checkbox', { name: /^重要公告/ }));
  });

  await t.step({
    caption: '發布與回執',
    narration: '發布回執寫實際開放時間和建立了幾則通知。',
    status: { kind: 'ok', evidence: 'story-2 第 16 步' },
  }, async () => {
    await t.click(dialog.getByRole('button', { name: '發布', exact: true }));
    await t.waitStable({ ready: dialog.getByRole('heading', { name: '已發布' }) });
    await t.hover(dialog.getByText(/已發布到公告/));
    await t.click(dialog.getByRole('button', { name: '回列表' }));
  });

  await t.step({
    caption: '完整編輯器與榮譽',
    narration: '要細調欄位、分類、封面就用完整編輯器；榮譽榜的得獎消息從榮譽分頁新增。',
    status: { kind: 'ok', evidence: 'story-4 第 8 步' },
  }, async () => {
    await t.hover(main.getByRole('link', { name: '用完整編輯器建立' }));
    await t.click(filter('榮譽'));
    await t.waitStable();
    await t.hover(main.getByRole('link', { name: '新增榮譽' }));
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
