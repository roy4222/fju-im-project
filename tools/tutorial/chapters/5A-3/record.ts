// 5A-3｜系辦｜屆別（分鏡 storyboard.md §4 5A-3，5 步）。本段新增「示範 115 屆」，不轉進行中、不改旗標。
//   INSTANCE=3 tools/tutorial/env/reset.sh && INSTANCE=3 node tools/tutorial/chapters/5A-3/setup.mjs
//   INSTANCE=3 node tools/tutorial/chapters/5A-3/record.ts
// 成品：~/work/tutorial-out/chapters/5A-3/5A-3.mp4＋events.json。
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { launchTutorialBrowser, newTutorialPage, renderChapter, startChapter, type Chapter } from '../../engine/index.ts';

const ID = '5A-3';
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
  const t = (chapter = await startChapter({ page, id: ID, chapter: '系辦｜屆別', baseURL: BASE, displayOrigin: 'test.fju.roy422.dev' }));
  console.log(`錄影目錄：${t.outDir}`);
  await t.offRecord(() => login(page, '系辦管理員'));
  await t.goto('/dashboard/admin');

  const row = (code: string) => page.getByRole('row').filter({ hasText: code });
  const danger = page.getByRole('region', { name: '危險操作' });

  await t.step({
    caption: '屆別總表',
    narration: '一屆就是一個年度的名單、組別和工作。兩個全站旗標：後台預設看哪一屆、新註冊的學生進哪一屆。',
    status: { kind: 'ok', evidence: 'story-1 第 15 步' },
  }, async () => {
    await t.click(page.getByRole('navigation', { name: '後台導覽' }).getByRole('link', { name: '屆別', exact: true }));
    await t.scroll(page.getByRole('heading', { name: '全部屆別' }));
    await t.hover(page.getByRole('columnheader', { name: '狀態' }));
    await t.hover(row('DEMO-114').getByText('後台預設查看中'));
    await t.hover(row('DEMO-114').getByText('新註冊加入這屆'));
  });

  await t.step({
    caption: '新增屆別',
    narration: '新屆別一開始是尚未開始、設定中，先排時間軸再轉進行中。',
    status: { kind: 'ok', evidence: 'story-1 第 9 步；UX 新手系辦 任務 1' },
  }, async () => {
    await t.scroll(page.getByRole('heading', { name: '新增屆別' }));
    await t.type(page.getByRole('textbox', { name: '代碼' }), 'DEMO-115');
    await t.type(page.getByRole('textbox', { name: '名稱' }), '示範 115 屆');
    await t.click(page.getByRole('button', { name: '新增屆別' }));
    await t.waitStable({ ready: page.getByText(/^已新增屆別/) });
    await t.hover(page.getByText(/^已新增屆別/));
  });

  await t.step({
    caption: '沒排時程不能轉進行中',
    narration: '沒填四個階段和年度結束日會被擋下來，訊息現在會寫屆別名稱。',
    status: { kind: 'ok', evidence: 'story-1 N-03（10/12 已修）' },
  }, async () => {
    await t.click(danger.getByRole('button', { name: '把 DEMO-115 轉為進行中' }));
    const dialog = page.getByRole('dialog').last();
    await t.waitStable({ ready: dialog.getByRole('button', { name: '確定轉為進行中' }) });
    await t.click(dialog.getByRole('button', { name: '確定轉為進行中' }));
    const blocked = page.getByText(/還沒設定階段與年度結束日/).first();
    await t.waitStable({ ready: blocked });
    await t.hover(blocked);
  });

  await t.step({
    caption: '轉進行中不能回頭',
    narration: '轉為進行中立即生效、不能轉回，所以放在危險操作區，按前會列出後果。',
    status: { kind: 'ok', evidence: 'story-1 第 14 步' },
  }, async () => {
    await t.hover(row('DEMO-114').getByText('進行中', { exact: true }));
    await t.scroll(danger);
    await t.hover(danger.getByText(/^轉為進行中：/));
    await t.click(danger.getByRole('button', { name: '把 DEMO-115 轉為進行中' }));
    const dialog = page.getByRole('dialog').last();
    await t.waitStable({ ready: dialog.getByText('能不能恢復') });
    await t.hover(dialog.getByText('能不能恢復'));
    await t.click(dialog.getByRole('button', { name: '先不要' }));
  });

  await t.step({
    caption: '兩個旗標怎麼換',
    narration: '旗標同時只能一屆持有，換屆時按一下就換過去。封存屆別的功能還沒有畫面。',
    status: { kind: 'bad', say: '封存／解封沒有操作入口', evidence: '規格 02 COH-05、COH-09；程式只有狀態標籤' },
  }, async () => {
    await t.scroll(page.getByRole('heading', { name: '全部屆別' }));
    await t.hover(page.getByRole('button', { name: '把 DEMO-115 設為後台預設查看的屆別' }));
    await t.hover(page.getByRole('button', { name: '把 DEMO-115 設為新註冊學生加入的屆別' }));
    await t.hover(row('DEMO-113').getByText('已封存'));
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
