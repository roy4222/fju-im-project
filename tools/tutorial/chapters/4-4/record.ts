// 4-4｜老師｜我的合作案（分鏡 storyboard.md §4 4-4，6 步）。段首不用補資料（乾淨 seed-demo）。
//   INSTANCE=3 tools/tutorial/env/reset.sh && INSTANCE=3 node tools/tutorial/chapters/4-4/setup.mjs
//   INSTANCE=3 node tools/tutorial/chapters/4-4/record.ts
// 成品：~/work/tutorial-out/chapters/4-4/4-4.mp4＋events.json。
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { launchTutorialBrowser, newTutorialPage, renderChapter, startChapter, type Chapter } from '../../engine/index.ts';

const ID = '4-4';
const INSTANCE = process.env.INSTANCE ?? '3';
const BASE = `http://localhost:${3300 + Number(INSTANCE)}`;

function account(name: string): { email: string; password: string } {
  const file = join(homedir(), 'work/tutorial-secrets', INSTANCE === '0' ? 'accounts.json' : `accounts-${INSTANCE}.json`);
  const acc = JSON.parse(readFileSync(file, 'utf8')).accounts.find((a: { name: string }) => a.name === name);
  const list = execFileSync('node', [join(import.meta.dirname, '../../env/accounts.mjs'), 'list'], { env: { ...process.env, INSTANCE }, encoding: 'utf8' });
  const email = acc.email ?? list.split('\n').map((l) => l.trim().split(/\s+/)).find((c) => c[1] === name)?.[2];
  return { email, password: acc.password };
}

async function login(page: Page, name: string): Promise<void> {
  const { email, password } = account(name);
  await page.context().clearCookies();
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('密碼').fill(password);
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}

const browser = await launchTutorialBrowser();
let chapter: Chapter | undefined;
try {
  const page = await newTutorialPage(browser);
  const t = (chapter = await startChapter({ page, id: ID, chapter: '老師｜我的合作案', baseURL: BASE, displayOrigin: 'test.fju.roy422.dev' }));
  console.log(`錄影目錄：${t.outDir}`);
  await t.offRecord(() => login(page, '李孟儒'));
  await t.goto('/dashboard/teacher');

  const list = page.getByRole('list', { name: '合作案清單' });
  const dialog = page.getByRole('dialog');
  const company = '示範智慧物流';

  await t.step({
    caption: '我的合作案',
    narration: '老師在這裡建立、編輯、下架自己的合作案；全部分頁看別的老師發布的。',
    status: 'ok', note: 'story-2 第 3 步',
  }, async () => {
    await t.click(page.getByRole('navigation', { name: '後台導覽' }).getByRole('link', { name: '產學合作', exact: true }));
    await t.hover(page.getByRole('link', { name: /^我的 \d+ 件$/ }));
    await t.hover(page.getByRole('link', { name: /^全部 \d+ 件$/ }));
    await t.hover(list.getByText('已連結 1 組'));
  });

  await t.step({
    caption: '新增合作案',
    narration: '新增只有公司、部門、內容、條件是必填或公開的；負責老師和發布日系統帶入。',
    status: 'ok', note: 'story-2 第 3 步',
  }, async () => {
    await t.click(page.getByRole('button', { name: '新增合作案' }));
    await t.waitStable({ ready: dialog });
    await t.type(dialog.getByRole('textbox', { name: '公司名稱＊' }), company);
    await t.type(dialog.getByRole('textbox', { name: '需求部門＊' }), '倉儲營運部');
    await t.type(dialog.getByRole('textbox', { name: '專題／合作內容＊' }), '用手機掃描貨架條碼，建立即時庫存看板。');
    await t.type(dialog.getByRole('textbox', { name: '對學生的條件／需求' }), '熟悉網頁開發，每月到場一次。');
  });

  await t.step({
    caption: '聯絡資訊只有你和系辦看得到',
    narration: '地址、聯絡人、電話、Email 不會因為發布而公開，學生畫面沒有這一區。',
    status: 'ok', note: 'story-2 第 5 步',
  }, async () => {
    await t.hover(dialog.getByText('以下只有你（負責老師）與系辦看得到'));
    await t.type(dialog.getByRole('textbox', { name: '公司地址' }), '新北市新莊區示範路 1 號');
    await t.type(dialog.getByRole('textbox', { name: '聯絡人' }), '王示範 經理');
    await t.click(dialog.getByRole('radio', { name: '只有我與系辦' }));
  });

  await t.step({
    caption: '先存草稿',
    narration: '可以先存草稿，確認後再發布給學生看。',
    status: 'ok', note: '既有保證（GRP-08）',
  }, async () => {
    await t.click(dialog.getByRole('button', { name: '儲存草稿' }));
    await t.waitStable({ ready: page.getByRole('status').filter({ hasText: '已儲存草稿' }) });
    await t.hover(list.getByRole('listitem').filter({ hasText: company }).getByText('尚未連結組別'));
  });

  await t.step({
    caption: '發布',
    narration: '發布後登入的學生與老師看得到公司、部門、內容與條件。',
    status: 'ok', note: 'story-2 第 3 步',
  }, async () => {
    await t.click(page.getByRole('button', { name: new RegExp(`^發布：${company}`) }));
    await t.waitStable({ ready: dialog });
    await t.click(dialog.getByRole('button', { name: '確認發布' }));
    await t.waitStable({ ready: page.getByRole('status').filter({ hasText: '已發布' }) });
    await t.hover(page.getByRole('status').filter({ hasText: '已發布' }));
  });

  await t.step({
    caption: '下架會怎樣',
    narration: '下架後學生列表看不到、不收新組；已連結的 G06 保留關係並標示已下架。這裡只看說明不真的下架。',
    status: 'ok', note: '既有保證（規格 03 §6.3）',
  }, async () => {
    await t.click(page.getByRole('button', { name: /^下架：昱鋼精機工業/ }));
    await t.waitStable({ ready: dialog });
    await t.hover(dialog.getByText(/下架後列表不再顯示/));
    await t.wait(3000);
    await t.click(dialog.getByRole('button', { name: '關閉對話框' }));
  });

  await t.finish();
} finally {
  await chapter?.dispose();
  await browser.close();
}

const out = join(homedir(), 'work/tutorial-out/chapters', ID);
await renderChapter({ dir: chapter!.outDir });
mkdirSync(out, { recursive: true });
copyFileSync(join(chapter!.outDir, 'chapter.mp4'), join(out, `${ID}.mp4`));
copyFileSync(join(chapter!.outDir, 'events.json'), join(out, 'events.json'));
console.log(`成品：${join(out, `${ID}.mp4`)}`);
