// 2-1｜新生→系辦→新生｜註冊、等待審核、核准、登入（分鏡 §4 第 2 章）。
//   INSTANCE=2 tools/tutorial/env/reset.sh && node chapters/2-1/setup.mjs && node chapters/2-1/record.ts
// 成品：~/work/tutorial-out/chapters/2-1/2-1.mp4＋events.json（run 目錄在 runs/ 下）。
//
// 換身分：系辦在獨立的 request context 走登入 API，只把它的 cookie 換進錄影分頁（換之前先清掉新生的），
// 整段在 offRecord 裡，影片直接切到系辦首頁。分鏡的「登出」都在 offRecord 裡清 cookie，不入鏡。

import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { request, type Cookie, type Page } from 'playwright';
import { launchTutorialBrowser, newTutorialPage, renderChapter, startChapter, type Chapter } from '../../engine/index.ts';

const ID = '2-1';
const BASE = process.env.TUTORIAL_BASE ?? 'http://localhost:3302';
const INSTANCE = process.env.INSTANCE ?? '2';
const secrets = join(homedir(), 'work', 'tutorial-secrets');
const accounts = JSON.parse(readFileSync(join(secrets, `accounts-${INSTANCE}.json`), 'utf8')).accounts as { name: string; password: string }[];
const student = JSON.parse(readFileSync(join(secrets, `rec2-2-1-${INSTANCE}.json`), 'utf8')) as {
  name: string; studentId: string; className: string; phone: string; email: string; password: string;
};

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
  const t = (chapter = await startChapter({ page, id: ID, chapter: '註冊與登入｜註冊、等待審核、核准、登入', baseURL: BASE, displayOrigin: 'test.fju.roy422.dev' }));
  console.log(`錄影目錄：${t.outDir}`);
  await t.offRecord(() => page.context().clearCookies());
  await t.goto('/');

  await t.step({
    caption: '從登入頁找到註冊',
    narration: '學生自己註冊；老師帳號由系辦建，不在這裡註冊。註冊入口在登入頁下面，首頁快速入口也有。',
    status: { kind: 'ok', evidence: 'story-1 第 21 步' },
  }, async () => {
    await t.click(banner.getByRole('link', { name: '登入', exact: true }));
    await t.click(main.getByRole('link', { name: '註冊', exact: true }));
  });

  await t.step({
    caption: '填註冊表單',
    narration: '填學籍上的姓名和學號、系級、手機、登入用的 Email 和密碼。登入 Email 之後不能自己換。',
    status: { kind: 'ok', evidence: 'story-1 第 21 步' },
  }, async () => {
    await t.type(main.getByLabel('姓名'), student.name);
    await t.type(main.getByLabel('學號'), student.studentId);
    await t.type(main.getByLabel('系級'), student.className);
    await t.type(main.getByLabel('手機'), student.phone);
    await t.type(main.getByLabel('登入 Email'), student.email);
    await t.type(main.getByLabel('密碼', { exact: true }), student.password, { secret: true });
    await t.type(main.getByLabel('確認密碼'), student.password, { secret: true });
    await t.click(main.getByRole('button', { name: '送出註冊' }));
    await page.waitForURL(/\/register\/pending/);
    await t.waitStable({ ready: main.getByRole('heading', { name: '等待系辦審核' }) });
  });

  await t.step({
    caption: '等待審核頁',
    narration: '送出後進等待審核。頁面說系辦會核對名單和本人；不會告訴你有沒有在名單上，也沒寫大概要等多久。',
    status: { kind: 'pending', say: '要不要寫大概要等多久', evidence: 'UX N-12' },
  }, async () => {
    await t.hover(main.getByRole('heading', { name: '等待系辦審核' }));
    await t.wait(400);
    await t.hover(main.getByText('系辦核對名單與本人身分後才會開通'));
    await t.scroll(main.getByText('資料版本'));
  });

  await t.step({
    caption: '待審期間可改資料',
    narration: '審核期間自己可以改資料，每次修改都留版本，狀態還是待審核。',
    status: { kind: 'ok', evidence: '規格 01 §2.4（10/12 驗收未單獨走）' },
  }, async () => {
    const phone = main.getByRole('textbox', { name: '手機' });
    await t.scroll(main.getByRole('heading', { name: '修改資料' }));
    await t.click(phone, false);
    await phone.fill('');
    await t.type(phone, '0912-000-889');
    await t.click(main.getByRole('button', { name: '儲存修改' }));
    await t.waitStable({ ready: main.getByText(/第 2 版/).first() });
    await t.hover(main.getByText(/第 2 版/).first());
  });

  await t.step({
    caption: '待審的人能逛什麼',
    narration: '待審的人只能看訪客看得到的頁面；點檔案下載或後台都會回到申請進度。',
    status: { kind: 'ok', evidence: 'story-1 第 23 步' },
  }, async () => {
    await t.goto('/files', { ready: main.getByRole('heading', { name: '等待系辦審核' }) });
    await t.hover(banner.getByRole('link', { name: '申請進度' }));
  });

  await t.step({
    caption: '系辦看到待審申請',
    narration: '換系辦登入。首頁的待審磚直接進帳號管理，新申請旁寫著「不在本屆名單上」，提醒系辦要自己核實。',
    status: { kind: 'ok', evidence: 'story-2 第 2 步' },
  }, async () => {
    await t.offRecord(async () => {
      await switchTo(page, await sessionOf('系辦管理員'));
      await t.goto('/dashboard/admin');
    });
    await t.click(main.getByRole('link', { name: /^審核帳號 \d+ ／/ }));
    const row = main.getByRole('region', { name: '待審核' }).getByRole('row').filter({ hasText: student.name });
    await t.scroll(row);
    await t.hover(row.getByRole('cell', { name: '不在本屆名單上' }));
  });

  await t.step({
    caption: '核准註冊',
    narration: '審核要選怎麼確認是本人，沒選會被擋。核准後他就歸到「新註冊加入這屆」的屆別。',
    status: { kind: 'ok', evidence: 'story-1 第 24 步' },
  }, async () => {
    await t.click(main.getByRole('button', { name: `審核 ${student.name}` }));
    const dialog = page.getByRole('dialog', { name: `審核 ${student.name}` });
    await t.waitStable({ ready: dialog });
    await t.hover(dialog.getByRole('combobox', { name: '核准進哪一屆' }));
    await t.click(dialog.getByRole('radio', { name: '當面核對學生證或其他身分證件' }));
    await t.type(dialog.getByRole('textbox', { name: /^理由/ }), '當面核對學生證，資料無誤');
    await t.click(dialog.getByRole('button', { name: '核准' }));
    const done = dialog.getByRole('status').getByText('已核准');
    await t.waitStable({ ready: done });
    await t.hover(dialog.getByRole('status').getByText(/已開通，進入 示範 114 屆/));
  });

  await t.step({
    caption: '密碼錯會怎樣',
    narration: '換回新生登入，先故意打錯密碼：錯誤寫在欄位下面，不會透露帳號存不存在。連錯十次會鎖十分鐘，訊息現在會寫等候時間。',
    status: { kind: 'ok', evidence: 'UX N-21（10/13 已修）' },
  }, async () => {
    await t.offRecord(async () => {
      await page.context().clearCookies(); // 等同登出系辦
      await t.goto('/login');
    });
    await t.type(main.getByLabel('Email'), student.email);
    await t.type(main.getByLabel('密碼', { exact: true }), 'wrong-password-0000', { secret: true });
    await t.click(main.getByRole('button', { name: '登入', exact: true }));
    const alert = main.getByRole('alert').filter({ hasText: 'Email 或密碼不正確。' });
    await t.waitStable({ ready: alert });
    await t.hover(alert);
  });

  await t.step({
    caption: '核准後第一次登入',
    narration: '打錯一次後連 Email 也被清空，兩欄都要重打。密碼對了直接進學生首頁，顯示現在的階段和還沒分組。',
    status: { kind: 'warn', say: '打錯密碼後 Email 也被清掉', evidence: '錄影 2 發現' },
  }, async () => {
    // 密碼錯一次後整張表單會被清空（Email 也是）：先讓畫面停在空的 Email 欄，再重打兩欄
    const email = main.getByLabel('Email');
    const pw = main.getByLabel('密碼', { exact: true });
    await t.hover(email);
    await t.wait(1000);
    await t.type(email, student.email);
    await pw.fill('');
    await t.type(pw, student.password, { secret: true });
    await t.click(main.getByRole('button', { name: '登入', exact: true }));
    await page.waitForURL(/\/dashboard\/student/);
    const hello = main.getByRole('heading', { name: `歡迎回來，${student.name}` });
    await t.waitStable({ ready: hello });
    await t.hover(hello);
    await t.wait(400);
    await t.hover(main.getByText(/現在是「階段 1/));
    await t.wait(400);
    await t.hover(main.getByText('還沒分組', { exact: true }));
  });

  await t.step({
    caption: 'Google 登入',
    narration: '也可以用 Google 登入或註冊，同一個 Email 會合併成同一個帳號。本機沒有 Google 憑證，影片只講不點。',
    status: { kind: 'warn', say: '本機無法示範 Google 登入', evidence: '本機環境無 Google 憑證（測試站有整合測試）' },
  }, async () => {
    await t.offRecord(async () => {
      await page.context().clearCookies(); // 等同登出
      await t.goto('/login');
    });
    await t.hover(main.getByRole('button', { name: '使用 Google 帳號登入' }));
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
