// 4-2｜老師｜分組總覽、擔任產學組指導老師、各組繳交（分鏡 §4）。
//   INSTANCE=2 tools/tutorial/env/reset.sh && node chapters/4-2/setup.mjs && node chapters/4-2/record.ts
// 成品：~/work/tutorial-out/chapters/4-2/4-2.mp4＋events.json（run 目錄在 runs/ 下）。
// 登入（李孟儒→陳建宏）在 offRecord 裡用登入 API 換 cookie，不入鏡。

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { request, type Cookie, type Page } from 'playwright';
import { launchTutorialBrowser, newTutorialPage, renderChapter, startChapter, type Chapter } from '../../engine/index.ts';

const ID = '4-2';
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
  const sidebar = page.getByRole('navigation', { name: '後台導覽' });
  const t = (chapter = await startChapter({ page, id: ID, chapter: '老師｜分組總覽、擔任產學組指導老師、各組繳交', baseURL: BASE, displayOrigin: 'test.fju.roy422.dev' }));
  console.log(`錄影目錄：${t.outDir}`);
  await t.offRecord(async () => {
    await switchTo(page, await sessionOf('李孟儒'));
    await t.goto('/dashboard/teacher');
  });

  await t.step({
    caption: '分組總覽',
    narration: '老師看得到本屆所有組別。一般組由系辦抽籤指派，產學組由第一位確認的老師擔任指導。',
    status: { kind: 'ok', evidence: 'story-1 第 31 步' },
  }, async () => {
    await t.click(sidebar.getByRole('link', { name: '分組總覽', exact: true }));
    await t.hover(main.getByText(/產學 \d+ 組（\d+ 組未指派老師）・你指導 \d+ 組・產學組可擔任 \d+ 組/));
  });

  const claim = main.getByRole('region', { name: '擔任產學組指導老師' });
  await t.step({
    caption: '等老師擔任的產學組',
    narration: '這張表列出產學組；標「可擔任」的還沒有指導老師，已經有老師的組也會列出來。看得到組員、組長和合作案。',
    status: { kind: 'ok', evidence: 'story-2 第 13 步' },
  }, async () => {
    await t.scroll(claim);
    await t.hover(claim.getByRole('row', { name: /^G03 / }).getByRole('cell').first());
    await t.wait(300);
    await t.hover(claim.getByRole('row', { name: /^G06 / }).getByRole('cell', { name: /昱鋼精機工業/ }));
    await t.wait(300);
    await t.hover(claim.getByRole('row', { name: /^G06 / }).getByRole('cell', { name: '可擔任' }));
    await t.wait(300);
    await t.hover(claim.getByRole('row', { name: /^G02 / }).getByRole('cell', { name: /^已有指導老師/ }));
  });

  await t.step({
    caption: '擔任指導老師',
    narration: '按下去先確認，說明第一位確認的老師就是指導老師、全組會收到通知；之後要換老師找系辦。',
    status: { kind: 'ok', evidence: 'story-2 第 13 步；「認領」已改成「擔任指導老師」（用詞第 1 輪 #36）' },
  }, async () => {
    await t.click(claim.getByRole('button', { name: '擔任 G06 的指導老師' }));
    const dialog = page.getByRole('dialog', { name: '擔任 G06 的指導老師' });
    await t.waitStable({ ready: dialog });
    await t.hover(dialog.getByText(/第一位確認的老師就是指導老師/));
    await t.wait(400);
    await t.click(dialog.getByRole('button', { name: '指定為我的組別' }));
    const done = dialog.getByRole('heading', { name: 'G06 已指定為你的組別' });
    await t.waitStable({ ready: done });
    await t.hover(done);
  });

  await t.step({
    caption: '全部組別表',
    narration: '全部組別可以搜尋、依類型和指導老師篩選；剛接的那組已經寫上你的名字。',
    status: { kind: 'ok', evidence: 'story-1 第 31 步' },
  }, async () => {
    await t.click(page.getByRole('dialog', { name: '擔任 G06 的指導老師' }).getByRole('button', { name: /關閉/ }).first());
    const all = main.getByRole('region', { name: '全部組別' });
    await t.scroll(all);
    await t.type(all.getByRole('textbox', { name: '搜尋組別或組員…' }), 'G06');
    await t.waitStable();
    await t.hover(all.getByRole('row', { name: /^G06 / }).getByRole('cell', { name: '李孟儒（你）' }));
  });

  await t.step({
    caption: '各組繳交總表',
    narration: '換陳建宏。各組繳交是指導組乘以整組繳交項目的矩陣，應該只列你指導的組。多出的 G03、G04 是以前屆別的組，網站沒有排除已封存的屆別，修不修等你決定。',
    status: { kind: 'warn', say: '多出別屆的組（已查到原因）', evidence: '錄影 2 發現；原因：G03、G04 是以前屆別的組，總表沒有排除已封存的屆別（功能本身 ✅ story-2 第 41 步）' },
  }, async () => {
    await t.offRecord(async () => {
      await switchTo(page, await sessionOf('陳建宏'));
      await t.goto('/dashboard/teacher');
    });
    await t.click(sidebar.getByRole('link', { name: '各組繳交', exact: true }));
    const table = main.getByRole('table', { name: '各組繳交總表' });
    await t.hover(table.getByRole('columnheader', { name: /^專題分組名單確認表/ }));
    await t.wait(300);
    await t.hover(table.getByRole('row', { name: /^G07 / }).getByRole('cell', { name: 'G07', exact: true }));
    await t.wait(300);
    await t.hover(table.getByRole('row', { name: /^G03 / }).getByRole('cell', { name: 'G03', exact: true }));
    await t.wait(300);
    await t.hover(table.getByRole('row', { name: /^G04 / }).getByRole('cell', { name: 'G04', exact: true }));
  });

  const g07 = main.getByRole('table', { name: '各組繳交總表' }).getByRole('row', { name: /^G07 / });
  await t.step({
    caption: '看懂格子顏色',
    narration: '綠色是已繳第幾次，游標停在格子上會顯示說明；未繳是白格，逾期未繳會變紅。老師看不到草稿。',
    status: { kind: 'ok', evidence: 'UX 指導老師 任務 2' },
  }, async () => {
    await t.hover(g07.getByRole('link', { name: '已繳第 1 次' }));
    await t.wait(1200);
    await t.hover(g07.getByRole('link', { name: '未繳' }).first());
    await t.wait(800);
  });

  await t.step({
    caption: '看某一組的版本',
    narration: '點格子進那一組的版本清單，再點查看看那次送出的內容和附件。',
    status: { kind: 'ok', evidence: 'story-2 第 41 步' },
  }, async () => {
    await t.click(g07.getByRole('link', { name: '已繳第 1 次' }));
    const versions = main.getByRole('table', { name: '正式送出的版本' });
    await t.hover(versions.getByRole('row', { name: /^第 1 次/ }).getByRole('cell').first());
    await t.wait(300);
    await t.click(versions.getByRole('link', { name: '查看內容' }));
  });

  await t.step({
    caption: '版本內容與證明編號',
    narration: '內容唯讀，跟送出當時一樣；有爭議時展開繳交證明編號。這次送出沒有附件，沒有示範下載時的身分確認。',
    status: { kind: 'pending', say: '「繳交證明編號」「表單第 N 版」用詞', evidence: '用詞#8（分鏡寫「檔案核對碼」，畫面是「繳交證明編號」）、#10（表單第 N 版）' },
  }, async () => {
    const view = main.getByRole('region', { name: /第 1 次送出$/ });
    await t.hover(view.getByText('唯讀・這是第 1 次送出當時的內容'));
    await t.wait(300);
    await t.hover(view.getByRole('definition').filter({ hasText: '第 1 版' }));
    await t.wait(300);
    await t.click(view.getByRole('group').getByText('顯示'));
    await t.waitStable();
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
