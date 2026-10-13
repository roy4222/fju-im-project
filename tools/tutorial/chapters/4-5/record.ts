// 4-5｜老師｜站內同意書（分鏡 storyboard.md §4 4-5，5 步）。段首不用補資料（乾淨 seed-demo：G02 輪到陳建宏、G07 學生 3／5）。
//   INSTANCE=3 tools/tutorial/env/reset.sh && INSTANCE=3 node tools/tutorial/chapters/4-5/setup.mjs
//   INSTANCE=3 node tools/tutorial/chapters/4-5/record.ts
// 成品：~/work/tutorial-out/chapters/4-5/4-5.mp4＋events.json。
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { launchTutorialBrowser, newTutorialPage, renderChapter, startChapter, type Chapter } from '../../engine/index.ts';

const ID = '4-5';
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
  const t = (chapter = await startChapter({ page, id: ID, chapter: '老師｜站內同意書', baseURL: BASE, displayOrigin: 'test.fju.roy422.dev' }));
  console.log(`錄影目錄：${t.outDir}`);
  await t.offRecord(() => login(page, '陳建宏'));
  await t.goto('/dashboard/teacher');

  const card = (code: string) => page.getByRole('region', { name: '我的指導組別' }).getByRole('listitem').filter({ hasText: `${code}・` });
  const progress = page.getByRole('region', { name: '進度' });

  await t.step({
    caption: '同意書清單',
    narration: '老師只看自己指導的組；全部學生同意後才輪到老師，前面寫等待學生幾位。',
    status: { kind: 'ok', evidence: 'story-3 第 30、37 步' },
  }, async () => {
    await t.click(page.getByRole('navigation', { name: '後台導覽' }).getByRole('link', { name: '站內同意書', exact: true }));
    await t.hover(page.getByText(/^待我同意 \d+ 份/));
    await t.hover(card('G02').getByText('輪到你'));
    await t.hover(card('G07').getByText(/等待學生 \d+ 位/));
  });

  await t.step({
    caption: '還沒輪到老師',
    narration: '學生沒齊時老師可以先讀全文，但沒有同意按鈕；系辦提醒時老師也會收到，文案會說明還沒輪到。',
    status: { kind: 'ok', evidence: 'Q38（10/12 定案：提醒照發給尚未輪到的老師，文案說明尚未輪到；story-3 N-55 已解）' },
  }, async () => {
    await t.click(card('G07').getByRole('link', { name: '閱讀全文與進度' }));
    await t.scroll(page.getByRole('status').filter({ hasText: '全部學生同意後才輪到你' }));
    await t.hover(page.getByRole('status').filter({ hasText: '全部學生同意後才輪到你' }));
  });

  await t.step({
    caption: '輪到老師的那一份',
    narration: '輪到你的那份有全文、附件、授權範圍和檢查碼，跟學生看到的是同一份。',
    status: { kind: 'pending', say: '「文件一致性檢查碼」用詞待決', evidence: '用詞#7（文件一致性檢查碼）' },
  }, async () => {
    await t.click(page.getByRole('link', { name: '回站內同意書' }));
    await t.click(card('G02').getByRole('link', { name: '閱讀全文並回覆' }));
    await t.hover(page.getByText(/文件一致性檢查碼/));
    await t.scroll(page.getByRole('region', { name: '全文' }));
    await t.scroll(page.getByRole('region', { name: /^授權範圍/ }));
  });

  await t.step({
    caption: '進度',
    narration: '進度列每位學生同意的時間；老師那列寫輪到老師。',
    status: { kind: 'ok', evidence: 'story-3 第 37 步' },
  }, async () => {
    await t.scroll(progress);
    await t.hover(progress.getByRole('listitem').first());
    await t.hover(progress.getByRole('listitem').filter({ hasText: '輪到老師' }));
  });

  await t.step({
    caption: '老師同意，同意書完成',
    narration: '勾了已閱讀才能同意，再確認一次。老師同意後整份完成，參與者都會收到通知；不同意要填理由、全組重簽。',
    status: { kind: 'ok', evidence: 'story-3 第 38 步；UX 指導老師 任務 3' },
  }, async () => {
    await t.click(page.getByRole('checkbox', { name: '我已完整閱讀這一版的全文與附件' }));
    await t.click(page.getByRole('button', { name: '以指導老師身分同意' }));
    const dialog = page.getByRole('dialog', { name: '確認同意' });
    await t.waitStable({ ready: dialog });
    await t.click(dialog.getByRole('button', { name: '以指導老師身分同意' }));
    const done = page.getByRole('status').filter({ hasText: '你已同意' });
    await t.waitStable({ ready: done });
    await t.hover(done);
    await t.scroll(page.getByRole('heading', { level: 2 }));
    await t.hover(page.getByRole('article').getByText('已完成', { exact: true }));
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
