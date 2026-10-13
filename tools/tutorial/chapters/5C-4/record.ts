// 5C-4 系辦｜通知與操作紀錄（分鏡 storyboard.md §4 5C-4）。
//   INSTANCE=4 tools/tutorial/env/reset.sh && node tools/tutorial/chapters/5C-4/setup.mjs && node tools/tutorial/chapters/5C-4/record.ts
// 輸出：~/work/tutorial-out/chapters/5C-4/（runs/ 底下是每次錄影的 run 目錄，成品複製成 5C-4.mp4＋events.json）。
// TUTORIAL_SILENT=1 改用無聲配音（只試定位器、不出成品）。

import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { launchTutorialBrowser, newTutorialPage, renderChapter, silentProvider, startChapter, type Chapter } from '../../engine/index.ts';

const ID = '5C-4';
const n = Number(process.env.INSTANCE ?? 4);
const baseURL = `http://localhost:${3300 + n}`;
const out = join(homedir(), 'work', 'tutorial-out', 'chapters', ID);
const accounts = JSON.parse(readFileSync(join(homedir(), 'work', 'tutorial-secrets', n ? `accounts-${n}.json` : 'accounts.json'), 'utf8')).accounts;
const admin = accounts.find((a: { create?: string }) => a.create === 'admin');

const browser = await launchTutorialBrowser();
let chapter: Chapter | undefined;
try {
  const page = await newTutorialPage(browser);
  const t = (chapter = await startChapter({
    page, id: ID, chapter: '系辦｜通知與操作紀錄', outRoot: join(out, 'runs'),
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
  const tab = (name: string | RegExp) => main.getByRole('link', { name, exact: typeof name === 'string' }).or(main.getByRole('button', { name, exact: typeof name === 'string' })).first();
  await t.goto('/dashboard/admin');

  await t.step({
    caption: '系辦的通知匣',
    narration: '系辦的通知是成績更正需要重新確認、背景工作需要處理這類；格式和師生一樣。',
    status: { kind: 'ok', evidence: 'story-3 第 19 步' },
  }, async () => {
    await t.click(nav('通知'));
    await t.hover(tab('全站'));
    await t.hover(tab('示範 114 屆（DEMO-114）'));
    await t.hover(main.getByText('示範：成績更正需要重新確認'));
  });

  await t.step({
    caption: '測試通知',
    narration: '測試站可以發一則測試通知確認背景工作活著；正式站沒有這塊。',
    status: { kind: 'ok', evidence: '既有保證（測試站專用）' },
  }, async () => {
    const form = main.locator('form').filter({ has: page.getByRole('button', { name: '發送測試通知' }) });
    await t.scroll(main.getByText('發一則測試通知').first());
    const recipient = form.getByLabel('收件人');
    // 選項文字帶 Email：用名字找到選項的值再選
    await t.select(recipient, (await recipient.locator('option', { hasText: '林彥廷' }).getAttribute('value'))!);
    await t.type(form.getByLabel(/^標題/), '示範：測試通知');
    await t.click(form.getByRole('button', { name: '發送測試通知' }));
    await t.waitStable({ ready: main.getByText(/^已發給 林彥廷/), offRecord: true });
    await t.hover(main.getByText(/^已發給 林彥廷/));
  });

  await t.step({
    caption: '操作紀錄',
    narration: '誰在什麼時候對誰做了什麼、理由是什麼，全部在操作紀錄；可以依角色篩。',
    status: { kind: 'ok', evidence: 'story-1 第 39 步；UX 新手系辦 任務 10' },
  }, async () => {
    await t.click(nav('操作紀錄'));
    await t.click(tab(/^管理員/));
    await t.hover(main.getByText(/^怎麼確認是本人：/));
    await t.hover(main.getByText('理由：教學示範'));
    await t.hover(main.getByText('屆別・示範 115 屆（DEMO-115）'));
  });

  await t.step({
    caption: '紀錄的範圍',
    narration: '這頁只列最近的紀錄，沒有姓名搜尋；紀錄多了要往下捲。',
    status: { kind: 'warn', say: '沒有姓名搜尋', evidence: 'UX 新手系辦 任務 10' },
  }, async () => {
    await t.scroll(-2000);
    await t.hover(main.getByText(/^近 7 天/));
    await t.scroll(400);
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
