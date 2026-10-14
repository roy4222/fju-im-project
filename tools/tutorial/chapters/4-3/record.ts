// 4-3｜老師｜評分（分鏡 storyboard.md §4 4-3，10 步）。
//   INSTANCE=3 tools/tutorial/env/reset.sh && INSTANCE=3 node tools/tutorial/chapters/4-3/setup.mjs
//   INSTANCE=3 node tools/tutorial/chapters/4-3/record.ts
// 成品：~/work/tutorial-out/chapters/4-3/4-3.mp4＋events.json。
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { launchTutorialBrowser, newTutorialPage, renderChapter, startChapter, type Chapter } from '../../engine/index.ts';

const ID = '4-3';
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
  const t = (chapter = await startChapter({ page, id: ID, chapter: '老師｜評分', baseURL: BASE, displayOrigin: 'test.fju.roy422.dev' }));
  console.log(`錄影目錄：${t.outDir}`);
  await t.offRecord(() => login(page, '陳建宏'));
  await t.goto('/dashboard/teacher');

  const queue = page.getByRole('list', { name: '待評分清單' });
  const row = (code: string) => queue.getByRole('link', { name: new RegExp(`系統驗收 ${code}`) });
  const field = (n: number) => page.getByRole('textbox', { name: new RegExp(`^${n}\\. `) });
  const grade = (item: string, g: string) => page.getByRole('radiogroup', { name: item }).getByRole('radio', { name: g, exact: true });

  await t.step({
    caption: '我的評分清單',
    narration: '評分頁左邊是待評分清單：被系辦退回的標紅、草稿寫填了幾項、未開始；送出後會變鎖頭。只列你被指派的組。',
    status: { kind: 'ok', evidence: 'story-1 N-11（「評分佇列」已改）；UX 評分老師 任務 1' },
  }, async () => {
    await t.click(page.getByRole('navigation', { name: '後台導覽' }).getByRole('link', { name: '評分', exact: true }));
    await t.hover(row('G04'));
    await t.hover(row('G02'));
  });

  await t.step({
    caption: '打開評分表',
    narration: '評分表照系辦發布的評分規則列項目、滿分、權重；有數字題也有等第 A 到 F。',
    status: { kind: 'ok', evidence: 'story-3 第 7 步' },
  }, async () => {
    await t.click(row('G07'));
    await t.hover(page.getByText('滿分 100・占 15%'));
  });

  await t.step({
    caption: '填分數看預覽',
    narration: '邊填邊算預覽總分；填錯範圍會紅字提醒。',
    status: { kind: 'ok', evidence: 'story-3 第 8 步' },
  }, async () => {
    const scores = ['85', '88', '90', '80', '84'];
    for (const [i, s] of scores.entries()) await t.type(field(i + 1), s);
    await t.click(grade('文件與可維護性', 'A'));
    await t.click(grade('簡報與答辯', 'B'));
    await t.hover(page.getByText(/預覽總分/));
  });

  await t.step({
    caption: '暫存草稿',
    narration: '暫存不算正式分數，只有你和系辦看得到；系辦看得到草稿是定案。「暫存」這個詞要不要改「儲存評分草稿」等你圈選。',
    status: { kind: 'pending', say: '「暫存」要不要改「儲存評分草稿」', evidence: '用詞#31（暫存／評分草稿 → 儲存評分草稿）；系辦可見草稿分數 ✅ Q37' },
  }, async () => {
    await t.click(page.getByRole('button', { name: '暫存' }));
    await t.waitStable({ ready: '已暫存到伺服器' });
  });

  await t.step({
    caption: '正式送出',
    narration: '正式送出前再確認一次分數；送出後鎖定，要改得請系辦退回。',
    status: { kind: 'ok', evidence: 'story-3 第 10 步' },
  }, async () => {
    await t.click(page.getByRole('button', { name: '正式送出' }));
    await t.waitStable({ ready: page.getByRole('dialog') });
    await t.hover(page.getByRole('dialog').getByText(/這一份分數是/));
    await t.wait(1500);
    await t.click(page.getByRole('dialog').getByRole('button', { name: '確認送出' }));
    await t.waitStable({ ready: page.getByRole('dialog', { name: '已送出' }) });
  });

  await t.step({
    caption: '送出回執',
    narration: '回執寫計入成績的分數和時間；多位老師評同一組取平均；學生永遠看不到分數。',
    status: { kind: 'ok', evidence: 'story-3 第 10 步' },
  }, async () => {
    await t.hover(page.getByText(/計入成績的分數/).first());
    await t.wait(4500);
    await t.click(page.getByRole('button', { name: '知道了' }));
  });

  await t.step({
    caption: '鎖定後的樣子',
    narration: '送出後欄位變灰，按鈕消失。',
    status: { kind: 'ok', evidence: 'story-3 第 10 步' },
  }, async () => {
    await t.hover(field(1));
    await t.hover(page.getByText('已正式送出並鎖定；要修改請聯絡系辦退回。'));
  });

  await t.step({
    caption: '繼續草稿',
    narration: '切到有草稿的組，之前暫存的分數都在，底部告訴你還差幾項。',
    status: { kind: 'ok', evidence: 'story-3 第 8 步' },
  }, async () => {
    await t.click(row('G02'));
    await t.hover(field(2));
    await t.hover(page.getByRole('button', { name: /還差 \d+ 項/ }));
  });

  await t.step({
    caption: '評分時看繳交',
    narration: '評分表旁列這組每個整組項目最新一次正式送出，點了看內容，附件可下載。這裡的「v2」是第 2 次送出。',
    status: { kind: 'pending', say: '「v2」要不要改「第 2 次送出」', evidence: '用詞#9（「v2」→「第 2 次送出」）' },
  }, async () => {
    const panel = page.getByRole('region', { name: '本組正式繳交' });
    await t.scroll(panel);
    await t.hover(panel.getByRole('listitem').filter({ hasText: 'v2' }).first());
  });

  await t.step({
    caption: '被退回後重送',
    narration: '系辦退回時表單上方寫理由，原分數填回來；改完重新正式送出就再鎖定。退回和改派的操作在系辦那章。',
    status: { kind: 'ok', evidence: 'story-3 第 20 步' },
  }, async () => {
    await t.click(row('G04'));
    await t.hover(page.getByRole('status').filter({ hasText: '退回了這一份評分' }));
    await field(3).fill('');
    await t.type(field(3), '92');
    await t.click(page.getByRole('button', { name: '正式送出' }));
    await t.waitStable({ ready: page.getByRole('dialog') });
    await t.click(page.getByRole('dialog').getByRole('button', { name: '確認送出' }));
    await t.waitStable({ ready: page.getByRole('dialog', { name: '已送出' }) });
    await t.wait(800);
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
