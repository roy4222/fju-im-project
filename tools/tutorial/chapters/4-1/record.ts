// 4-1｜老師｜老師首頁、公告、通知（分鏡 §4）。
//   INSTANCE=2 tools/tutorial/env/reset.sh && node chapters/4-1/setup.mjs && node chapters/4-1/record.ts
// 成品：~/work/tutorial-out/chapters/4-1/4-1.mp4＋events.json（run 目錄在 runs/ 下）。
// 登入（陳建宏）在 offRecord 裡用登入 API 換 cookie，不入鏡；通知匣的那一則由 setup.mjs 以系辦發的「全部老師」重要公告產生。

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { request, type Cookie, type Page } from 'playwright';
import { launchTutorialBrowser, newTutorialPage, renderChapter, startChapter, type Chapter } from '../../engine/index.ts';

const ID = '4-1';
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
  const section = (name: string) => main.getByRole('heading', { name, exact: true, level: 2 });
  const t = (chapter = await startChapter({ page, id: ID, chapter: '老師｜老師首頁、公告、通知', baseURL: BASE, displayOrigin: 'test.fju.roy422.dev' }));
  console.log(`錄影目錄：${t.outDir}`);
  await t.offRecord(async () => {
    await switchTo(page, await sessionOf('陳建宏'));
    await t.goto('/dashboard/teacher');
  });

  await t.step({
    caption: '老師首頁一眼看什麼',
    narration: '老師首頁第一行是現在階段，接著直接說還有幾份評分沒送、幾組同意書等你。',
    status: { kind: 'ok', evidence: 'story-1 第 31 步；UX 指導老師 任務 1' },
  }, async () => {
    const now = main.getByRole('region', { name: '現在階段' });
    await t.hover(now.getByRole('heading', { name: /歡迎回來，陳建宏/ }));
    await t.wait(300);
    await t.hover(now.getByText(/評分還有 \d+ 份沒正式送出/));
    await t.wait(300);
    for (const name of [/^未開始/, /^草稿/, /^已送出/, /^待我同意/]) await t.hover(now.getByRole('link', { name }));
    await t.hover(now.getByRole('link', { name: /^繼續評分/ }));
  });

  await t.step({
    caption: '評分進度',
    narration: '評分進度環分已送出、草稿、未開始；我的評分列出每一組每階段，按鈕直接進評分表。',
    status: { kind: 'ok', evidence: 'UX 評分老師 任務 1' },
  }, async () => {
    await t.scroll(section('評分進度'));
    await t.hover(main.getByRole('img', { name: /已送出 \d+、草稿/ }));
    await t.wait(300);
    const mine = main.getByRole('listitem').filter({ has: page.getByRole('link', { name: /系統驗收/ }) });
    await t.hover(mine.filter({ hasText: '草稿' }).first());
    await t.wait(300);
    await t.hover(mine.filter({ hasText: '已送出' }).first());
    await t.wait(300);
    await t.hover(mine.filter({ hasText: '未開始' }).first());
  });

  await t.step({
    caption: '給老師的公告與活動',
    narration: '給老師的公告只列三種：全部老師、所有已登入、我指導的組。公開公告不列，要看去前台。本屆活動列我指導屆別的活動。',
    status: { kind: 'ok', evidence: '2026-09-26 定案 Q13／Q14、AC-31（story-2 N-52 已解）' },
  }, async () => {
    await t.scroll(section('給老師的公告'));
    await t.hover(main.getByText('・全部老師、所有已登入、我指導的組'));
    await t.wait(400);
    await t.hover(section('本屆活動'));
  });

  await t.step({
    caption: '其他工作區塊',
    narration: '下面是有才出現的區塊：等人擔任指導的產學組、同意書進度、我指導的組、我的合作案。',
    status: { kind: 'ok', evidence: 'story-1 第 31 步' },
  }, async () => {
    await t.scroll(section('待指導的產學組'));
    await t.hover(section('待指導的產學組'));
    await t.wait(300);
    await t.hover(main.getByText('學生都同意了・輪到你'));
    await t.scroll(section('指導中的組別'));
    await t.hover(section('指導中的組別'));
    await t.wait(300);
    await t.hover(section('合作案'));
  });

  await t.step({
    caption: '老師的通知匣',
    narration: '評分指派、退回、同意書輪到你、指導老師更新都會進通知匣，依屆別篩。',
    status: { kind: 'pending', say: '說明文字「事件」要不要換詞', evidence: '用詞#11' },
  }, async () => {
    await t.click(page.getByRole('navigation', { name: '後台導覽' }).getByRole('link', { name: '通知', exact: true }));
    await t.hover(main.getByText(/跟你有關的事件都會出現在這裡/));
    await t.click(main.getByRole('navigation', { name: '依屆別篩選' }).getByRole('link', { name: '示範 114 屆（DEMO-114）' }));
    await t.waitStable({ offRecord: true });
    await t.click(main.getByRole('region', { name: '通知列表' }).getByRole('button', { name: /標為已讀$/ }).first());
    await t.waitStable({ offRecord: true });
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
