// 5A-1｜系辦｜系辦首頁與側欄（分鏡 storyboard.md §4 5A-1，4 步）。段首不用補資料（reset.sh 已把示範 114 屆設為後台預設查看的屆別）。
//   INSTANCE=3 tools/tutorial/env/reset.sh && INSTANCE=3 node tools/tutorial/chapters/5A-1/setup.mjs
//   INSTANCE=3 node tools/tutorial/chapters/5A-1/record.ts
// 成品：~/work/tutorial-out/chapters/5A-1/5A-1.mp4＋events.json。
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { launchTutorialBrowser, newTutorialPage, renderChapter, startChapter, type Chapter } from '../../engine/index.ts';

const ID = '5A-1';
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
  const t = (chapter = await startChapter({ page, id: ID, chapter: '系辦｜系辦首頁與側欄', baseURL: BASE, displayOrigin: 'test.fju.roy422.dev' }));
  console.log(`錄影目錄：${t.outDir}`);
  await t.offRecord(() => login(page, '系辦管理員'));
  await t.goto('/dashboard/admin');

  const nav = page.getByRole('navigation', { name: '後台導覽' });

  await t.step({
    caption: '系辦首頁',
    narration: '系辦首頁第一行就是今天有幾件待處理、本屆分組到哪。還沒設屆別時這裡會有「前往屆別設定」按鈕。',
    status: { kind: 'ok', evidence: 'story-1 N-09（10/12 已修：首頁入口）' },
  }, async () => {
    await t.hover(page.getByRole('heading', { name: /^歡迎回來/ }));
    await t.hover(page.getByText(/^現在是「階段/));
  });

  await t.step({
    caption: '五張統計磚',
    narration: '五張磚：待審帳號、逾期未繳、還沒評完的老師、等老師同意的組、主機儲存用量。前四張可以點進對應頁；主機儲存只顯示用量。',
    status: { kind: 'ok', evidence: 'story-2 第 44 步；「缺評老師」已改白話（story-3 N-15）' },
  }, async () => {
    await t.hover(page.getByRole('link', { name: /^審核帳號 \d/ }));
    await t.hover(page.getByRole('link', { name: /^逾期未繳/ }));
    await t.hover(page.getByRole('link', { name: /^尚未完成評分的老師/ }));
    await t.hover(page.getByRole('link', { name: /^等老師同意/ }));
    await t.hover(page.getByText('主機儲存（整台）'));
  });

  await t.step({
    caption: '四個面板',
    narration: '下面四個面板：每個繳交項目的完成率、分組甜甜圈、老師評分進度、我發的公告。點一列進未繳名單。',
    status: { kind: 'ok', evidence: 'story-2 第 44 步' },
  }, async () => {
    await t.scroll(page.getByRole('heading', { name: '各繳交項目完成率' }));
    await t.hover(page.getByRole('link', { name: /^指導老師意願調查表/ }));
    await t.hover(page.getByRole('heading', { name: '本屆分組' }));
    await t.scroll(page.getByRole('heading', { name: '老師評分進度' }));
    await t.hover(page.getByRole('heading', { name: '我發的公告' }));
  });

  await t.step({
    caption: '側欄怎麼分',
    narration: '側欄分五組；帳號、屆別、操作紀錄在最下面的系統管理。「專題事務」這個名字看不出包含公告、規則和繳交。',
    status: { kind: 'pending', say: '側欄長度與「專題事務」名稱', evidence: 'UX N-16（側欄長，系統管理要往下捲）、N-17（「專題事務」名稱）' },
  }, async () => {
    await t.hover(nav.getByText('總覽', { exact: true }));
    await t.hover(nav.getByRole('link', { name: '專題事務', exact: true }));
    await t.hover(nav.getByText('分組與產學', { exact: true }));
    await t.hover(nav.getByText('評分與同意書', { exact: true }));
    await t.hover(nav.getByText('系統管理', { exact: true }));
    await t.hover(nav.getByRole('link', { name: '操作紀錄', exact: true }));
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
