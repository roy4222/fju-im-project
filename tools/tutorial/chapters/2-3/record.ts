// 2-3｜老師｜老師第一次登入（分鏡 §4）。
//   INSTANCE=2 tools/tutorial/env/reset.sh && node chapters/2-3/setup.mjs && node chapters/2-3/record.ts
// 成品：~/work/tutorial-out/chapters/2-3/2-3.mp4＋events.json（run 目錄在 runs/ 下）。
// 「示範新老師」由 setup.mjs 以系辦「新增老師」建立；臨時密碼從 ~/work/tutorial-secrets/rec2-2-3-<實例>.json 讀，新密碼每次隨機產生。

import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { launchTutorialBrowser, newTutorialPage, renderChapter, startChapter, type Chapter } from '../../engine/index.ts';

const ID = '2-3';
const BASE = process.env.TUTORIAL_BASE ?? 'http://localhost:3302';
const INSTANCE = process.env.INSTANCE ?? '2';
const teacher = JSON.parse(readFileSync(join(homedir(), 'work', 'tutorial-secrets', `rec2-2-3-${INSTANCE}.json`), 'utf8')) as { name: string; email: string; tempPassword: string };
const newPassword = `Demo-${randomBytes(9).toString('base64url')}`;

const browser = await launchTutorialBrowser();
let chapter: Chapter | undefined;
try {
  const page = await newTutorialPage(browser);
  const main = page.getByRole('main');
  const t = (chapter = await startChapter({ page, id: ID, chapter: '註冊與登入｜老師第一次登入', baseURL: BASE, displayOrigin: 'test.fju.roy422.dev' }));
  console.log(`錄影目錄：${t.outDir}`);
  await t.offRecord(() => page.context().clearCookies());
  await t.goto('/login');

  await t.step({
    caption: '用臨時密碼登入',
    narration: '系辦建好老師帳號會給一組臨時密碼。第一次登入先被帶來改密碼，改好前不能用其他功能。',
    status: { kind: 'ok', evidence: 'story-1 第 28 步' },
  }, async () => {
    await t.type(main.getByLabel('Email'), teacher.email);
    await t.type(main.getByLabel('密碼', { exact: true }), teacher.tempPassword, { secret: true });
    await t.click(main.getByRole('button', { name: '登入', exact: true }));
    await page.waitForURL(/\/account\/change-password/);
    const title = main.getByRole('heading', { name: '請先更改密碼' });
    await t.waitStable({ ready: title, offRecord: true });
    await t.hover(title);
  });

  await t.step({
    caption: '設定新密碼',
    narration: '輸入臨時密碼和新密碼，新密碼至少 12 字且不能和舊的一樣。',
    status: { kind: 'ok', evidence: 'story-1 第 28 步' },
  }, async () => {
    await t.type(main.getByLabel('目前的一次性密碼'), teacher.tempPassword, { secret: true });
    await t.type(main.getByLabel('新密碼', { exact: true }), newPassword, { secret: true });
    await t.type(main.getByLabel('再輸入一次新密碼'), newPassword, { secret: true });
    await t.click(main.getByRole('button', { name: '設定新密碼' }));
    await page.waitForURL(/\/account\/setup/);
    await t.waitStable({ ready: main.getByRole('heading', { name: /^第一次登入/ }), offRecord: true });
  });

  await t.step({
    caption: '補上老師資料',
    narration: '接著補姓名和聯絡資料，之後在我的帳號可以再改。',
    status: { kind: 'ok', evidence: 'story-1 第 28 步' },
  }, async () => {
    // 姓名與聯絡 Email 已由系辦新增時帶入，只補手機
    await t.hover(main.getByRole('textbox', { name: '姓名' }));
    await t.wait(300);
    await t.hover(main.getByRole('textbox', { name: '聯絡 Email' }));
    await t.type(main.getByRole('textbox', { name: '手機' }), '0912-000-777');
    await t.click(main.getByRole('button', { name: '儲存並進入老師首頁' }));
    await page.waitForURL(/\/dashboard\/teacher/);
    await t.waitStable({ ready: main.getByRole('heading', { name: new RegExp(`歡迎回來，${teacher.name}`) }), offRecord: true });
  });

  await t.step({
    caption: '進老師首頁',
    narration: '存好直接進老師首頁。新老師還沒指導任何組，各區塊都是空狀態。',
    status: { kind: 'ok', evidence: 'story-1 第 31 步' },
  }, async () => {
    await t.hover(main.getByRole('heading', { name: new RegExp(`歡迎回來，${teacher.name}`) }));
    await t.wait(600);
    await t.scroll(400);
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
