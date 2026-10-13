// 2-2｜學生｜個人資料、改密碼、忘記密碼、登出（分鏡 §4）。
//   INSTANCE=2 tools/tutorial/env/reset.sh && node chapters/2-2/setup.mjs && node chapters/2-2/record.ts
// 成品：~/work/tutorial-out/chapters/2-2/2-2.mp4＋events.json（run 目錄在 runs/ 下）。
// 登入（林彥廷）在 offRecord 裡用登入 API 換 cookie，不入鏡；2-2-4 只示範驗證，不真的改密碼。

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { request, type Cookie, type Page } from 'playwright';
import { launchTutorialBrowser, newTutorialPage, renderChapter, startChapter, type Chapter } from '../../engine/index.ts';

const ID = '2-2';
const BASE = process.env.TUTORIAL_BASE ?? 'http://localhost:3302';
const INSTANCE = process.env.INSTANCE ?? '2';
const accounts = JSON.parse(readFileSync(join(homedir(), 'work', 'tutorial-secrets', `accounts-${INSTANCE}.json`), 'utf8')).accounts as { name: string; password: string }[];

/** 示範名稱 → 登入 Email（帳號設定檔只寫名稱；照 env 的 accounts.mjs list 從這個實例的資料庫查）。 */
function emailOf(name: string): string {
  const out = execFileSync(process.execPath, [join(import.meta.dirname, '../../env/accounts.mjs'), 'list'], { env: { ...process.env, INSTANCE }, encoding: 'utf8' });
  const cols = out.split('\n').map((l) => l.trim().split(/\s{2,}/)).find((c) => c[1] === name);
  if (!cols?.[2]) throw new Error(`accounts.mjs list 找不到「${name}」`);
  return cols[2];
}

function passwordOf(name: string): string {
  const password = accounts.find((a) => a.name === name)?.password;
  if (!password) throw new Error(`accounts-${INSTANCE}.json 沒有「${name}」`);
  return password;
}

/** 用獨立的 request context 走登入 API，回傳那個身分的 cookie（不碰錄影分頁）。 */
async function sessionOf(name: string, email = emailOf(name), password = passwordOf(name)): Promise<Cookie[]> {
  const ctx = await request.newContext({ baseURL: BASE, extraHTTPHeaders: { origin: BASE } });
  try {
    const res = await ctx.post('/api/auth/sign-in/email', { data: { email, password } });
    if (!res.ok()) throw new Error(`「${name}」登入失敗：HTTP ${res.status()}`);
    return (await ctx.storageState()).cookies;
  } finally {
    await ctx.dispose();
  }
}

/** 錄影分頁換成另一個身分：清掉原本的 cookie、換上那個身分的（要包在 offRecord 裡）。 */
async function switchTo(page: Page, cookies: Cookie[]): Promise<void> {
  await page.context().clearCookies();
  await page.context().addCookies(cookies);
}

const browser = await launchTutorialBrowser();
let chapter: Chapter | undefined;
try {
  const page = await newTutorialPage(browser);
  const main = page.getByRole('main');
  const banner = page.getByRole('banner');
  const t = (chapter = await startChapter({ page, id: ID, chapter: '註冊與登入｜個人資料、改密碼、忘記密碼、登出', baseURL: BASE, displayOrigin: 'test.fju.roy422.dev' }));
  console.log(`錄影目錄：${t.outDir}`);
  await t.offRecord(async () => {
    await switchTo(page, await sessionOf('林彥廷'));
    await t.goto('/');
  });

  await t.step({
    caption: '我的帳號在哪',
    narration: '登入後右上角是頭像和名字，點開有我的帳號、我的後台、登出。',
    status: { kind: 'ok', evidence: 'UX 新生 任務 3' },
  }, async () => {
    await t.click(banner.getByRole('button', { name: '帳號選單' }));
    const menu = page.getByRole('menu', { name: '帳號選單' });
    await t.waitStable({ ready: menu, offRecord: true });
    await t.hover(menu.getByRole('menuitem', { name: '登出' }));
    await t.wait(300);
    await t.click(menu.getByRole('menuitem', { name: '我的帳號' }));
    await page.waitForURL(/\/account$/);
    await t.waitStable({ ready: main.getByRole('heading', { name: '我的帳號' }), offRecord: true });
  });

  await t.step({
    caption: '改手機與聯絡 Email',
    narration: '姓名、學號、系級、屆別由系辦維護；手機和聯絡 Email 自己改。',
    status: { kind: 'ok', evidence: 'UX 新生 任務 3' },
  }, async () => {
    await t.hover(main.getByRole('region', { name: '基本資料' }).getByText('由系辦維護').first());
    const phone = main.getByRole('textbox', { name: '手機' });
    await t.click(phone, false);
    await phone.fill('');
    await t.type(phone, '0912-345-678');
    await t.click(main.getByRole('button', { name: '儲存變更' }));
    const done = main.getByText('聯絡資料已更新。');
    await t.waitStable({ ready: done, offRecord: true });
    await t.hover(done);
  });

  await t.step({
    caption: '登入方式',
    narration: '這裡看得到已經連結 Google 沒有、密碼設了沒。連結 Google 的 Email 要和登入 Email 相同。',
    status: { kind: 'warn', say: '本機無法示範連結 Google', evidence: '本機環境無 Google 憑證' },
  }, async () => {
    const methods = main.getByRole('list', { name: '登入方式' });
    await t.scroll(main.getByRole('heading', { name: '登入方式' }));
    await t.hover(methods.getByRole('button', { name: '連結 Google' }));
    await t.wait(400);
    await t.hover(methods.getByRole('link', { name: '更改密碼' }));
  });

  await t.step({
    caption: '更改密碼',
    narration: '改密碼要輸入目前的密碼，新密碼至少 12 字。這裡只示範驗證，不真的改，改完其他裝置都會被登出。',
    status: { kind: 'ok', evidence: 'story-1 第 28 步（老師改密流程通過）' },
  }, async () => {
    await t.click(main.getByRole('list', { name: '登入方式' }).getByRole('link', { name: '更改密碼' }));
    await t.type(main.getByLabel('目前的密碼'), passwordOf('林彥廷'), { secret: true });
    await t.type(main.getByLabel('新密碼', { exact: true }), 'Demo-new-pass-01', { secret: true });
    await t.type(main.getByLabel('再輸入一次新密碼'), 'Demo-new-pass-02', { secret: true });
    await t.click(main.getByRole('button', { name: '設定新密碼' }));
    const err = main.getByText('兩次輸入的新密碼不一樣。');
    await t.waitStable({ ready: err, offRecord: true });
    await t.hover(err);
  });

  await t.step({
    caption: '誤打別人的後台',
    narration: '學生打系辦網址只會看到找不到頁面，不說沒有權限；按鈕回自己的首頁。',
    status: { kind: 'ok', evidence: 'story-1 第 36 步（Q35）' },
  }, async () => {
    await t.goto('/dashboard/admin', { ready: main.getByRole('heading', { name: '找不到這個頁面' }) });
    await t.hover(main.getByRole('heading', { name: '找不到這個頁面' }));
    await t.wait(400);
    await t.hover(main.getByRole('link', { name: '回到自己的首頁' }));
  });

  await t.step({
    caption: '登出',
    narration: '登出在帳號選單最下面，回到訪客狀態。',
    status: { kind: 'ok', evidence: '既有保證' },
  }, async () => {
    await t.click(banner.getByRole('button', { name: '帳號選單' }));
    const menu = page.getByRole('menu', { name: '帳號選單' });
    await t.waitStable({ ready: menu, offRecord: true });
    await t.click(menu.getByRole('menuitem', { name: '登出' }));
    const login = banner.getByRole('link', { name: '登入', exact: true });
    await t.waitStable({ ready: login, offRecord: true });
    await t.hover(login);
  });

  await t.step({
    caption: '忘記密碼怎麼辦',
    narration: '本站不寄重設信：用 Google 的回去按 Google 登入；用密碼的打電話給系辦，系辦發一組只顯示一次的臨時密碼。',
    status: { kind: 'ok', evidence: '既有保證（Email 寄送延後是產品決定）' },
  }, async () => {
    await t.goto('/forgot-password', { ready: main.getByRole('heading', { name: '忘記密碼' }) });
    await t.hover(main.getByRole('heading', { name: '用 Google 帳號登入的' }));
    await t.wait(400);
    await t.hover(main.getByRole('heading', { name: '用 Email 與密碼登入的' }));
    await t.wait(400);
    await t.hover(main.getByRole('link', { name: '回登入頁' }));
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
