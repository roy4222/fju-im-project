// 5A-5｜系辦｜分組總覽與指導老師（分鏡 storyboard.md §4 5A-5，9 步）。批次指派 CSV 由 setup.mjs 產生。
//   INSTANCE=3 tools/tutorial/env/reset.sh && INSTANCE=3 node tools/tutorial/chapters/5A-5/setup.mjs
//   INSTANCE=3 node tools/tutorial/chapters/5A-5/record.ts
// 成品：~/work/tutorial-out/chapters/5A-5/5A-5.mp4＋events.json。
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { launchTutorialBrowser, newTutorialPage, renderChapter, startChapter, type Chapter } from '../../engine/index.ts';

const ID = '5A-5';
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

const FIXTURES = join(homedir(), 'work/tutorial-out/chapters', ID, 'fixtures');

const browser = await launchTutorialBrowser();
let chapter: Chapter | undefined;
try {
  const page = await newTutorialPage(browser);
  const t = (chapter = await startChapter({ page, id: ID, chapter: '系辦｜分組總覽與指導老師', baseURL: BASE, displayOrigin: 'test.fju.roy422.dev' }));
  console.log(`錄影目錄：${t.outDir}`);
  await t.offRecord(async () => {
    await login(page, '系辦管理員');
    // 5A-5-7「複製整組信箱」要用剪貼簿，沒授權會失敗。
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  });
  await t.goto('/dashboard/admin');

  const dialog = page.getByRole('dialog').last();
  const groups = page.getByRole('region', { name: '全部組別' });
  const toast = (text: RegExp) => page.getByRole('status').filter({ hasText: text });

  await t.step({
    caption: '分組總覽',
    narration: '系辦看全屆分組：幾組、幾人、幾組還沒老師。「分組期」旁已經有白話說明。',
    status: { kind: 'ok', evidence: 'story-1 第 17 步；story-1 N-10（Q40 已補字）' },
  }, async () => {
    await t.click(page.getByRole('navigation', { name: '後台導覽' }).getByRole('link', { name: '分組總覽', exact: true }));
    await t.hover(page.getByText(/人已分組/).first());
    await t.hover(page.getByText(/組尚未指派/).first());
  });

  await t.step({
    caption: '分組設定',
    narration: '每組人數上下限和提案幾天內要確認完，在這裡改。',
    status: { kind: 'ok', evidence: 'story-1 第 17 步' },
  }, async () => {
    await t.click(page.getByRole('button', { name: '分組設定' }));
    await t.waitStable({ ready: dialog.getByRole('spinbutton', { name: '每組最少人數' }) });
    await t.hover(dialog.getByRole('spinbutton', { name: '每組最少人數' }));
    await t.hover(dialog.getByRole('spinbutton', { name: '每組最多人數' }));
    await t.hover(dialog.getByRole('spinbutton', { name: '提案預設天數' }));
    await t.click(dialog.getByRole('button', { name: '先不改' }));
  });

  await t.step({
    caption: '未分組與組隊中',
    narration: '未分組學生和進行中的提案都看得到；系辦可以把人直接加進某組，或作廢卡住的提案。',
    status: { kind: 'ok', evidence: 'story-2 第 12 步' },
  }, async () => {
    const ungrouped = page.getByRole('region', { name: '未分組學生' });
    await t.scroll(ungrouped);
    await t.hover(ungrouped.getByText('公開找組員', { exact: true }).first());
    await t.hover(ungrouped.getByText('未公開', { exact: true }));
    await t.hover(ungrouped.getByRole('button', { name: '加入某組：鞠柏宇' }));
    const forming = page.getByRole('region', { name: '組隊中（等全員確認）' });
    await t.scroll(forming);
    await t.hover(forming.getByRole('cell', { name: /（待確認）/ }));
    await t.hover(forming.getByRole('button', { name: '作廢：應宥丞的提案' }));
  });

  await t.step({
    caption: '指派一般組的指導老師',
    narration: '一般組由系辦依抽籤結果指派，必填理由；指派後學生和老師都收到通知。已有老師的組是「重派」「解除」。',
    status: { kind: 'ok', evidence: 'story-2 第 12 步' },
  }, async () => {
    await t.scroll(groups.getByRole('button', { name: '指派指導老師：G09' }));
    await t.click(groups.getByRole('button', { name: '指派指導老師：G09' }));
    await t.waitStable({ ready: dialog.getByRole('combobox', { name: '指導老師' }) });
    const wang = (await dialog.getByRole('combobox', { name: '指導老師' }).locator('option').allInnerTexts()).find((o) => o.startsWith('王雅玲（'))!;
    await t.select(dialog.getByRole('combobox', { name: '指導老師' }), wang);
    await t.type(dialog.getByRole('textbox', { name: '理由（必填）' }), '依公開抽籤結果');
    await t.click(dialog.getByRole('button', { name: '確認指派' }));
    await t.waitStable({ ready: toast(/^已指派/) });
    await t.hover(groups.getByRole('button', { name: '重派指導老師：G09' }));
  });

  await t.step({
    caption: '批次指派',
    narration: '學年初一次指派很多組用 CSV：先預覽分類，重派要勾確認並填理由，新老師不會自動拿到評分權。',
    status: { kind: 'pending', say: '「CSV」這個用詞', evidence: 'story-6 第 2～7 步；🟡 用詞#16（CSV）' },
  }, async () => {
    await t.scroll(groups);
    await t.click(groups.getByRole('button', { name: '批次指派（CSV）' }));
    await t.waitStable({ ready: dialog.getByRole('button', { name: '選擇批次指派 CSV 檔' }) });
    await t.upload(dialog.locator('input[type=file]'), join(FIXTURES, 'assign.csv'), { via: dialog.getByRole('button', { name: '選擇批次指派 CSV 檔' }) });
    await t.waitStable({ ready: dialog.getByRole('heading', { name: /^預覽・/ }) });
    await t.hover(dialog.getByText('屬於重派', { exact: true }).first());
    await t.click(dialog.getByRole('checkbox', { name: /^確認重派/ }));
    await t.hover(dialog.getByRole('textbox', { name: '理由（必填，整批共用）' }));
    await t.click(dialog.getByRole('button', { name: '關閉' }));
  });

  await t.step({
    caption: '組別詳情與成員異動',
    narration: '點組別代碼開詳情：可以移出成員、換組長，每筆都要理由、都進異動歷程。解散整組的功能還沒開放。',
    status: { kind: 'bad', say: '還不能解散整組', evidence: '解散：抽屜註記「解散功能之後才會開放」（規格 03 GRP-13）' },
  }, async () => {
    await t.click(groups.getByRole('button', { name: 'G07 詳情' }));
    await t.waitStable({ ready: dialog.getByRole('list', { name: '成員名單' }) });
    await t.hover(dialog.getByRole('list', { name: '成員名單' }).getByText('組長', { exact: true }));
    await t.hover(dialog.getByRole('button', { name: '移出：鄭凱文' }));
    await t.hover(dialog.getByRole('button', { name: '換組長' }));
    await t.hover(dialog.getByRole('region', { name: '異動歷程' }));
    await t.click(dialog.getByRole('button', { name: '關閉' }));
  });

  await t.step({
    caption: '複製整組信箱',
    narration: '要寄信給某一組，按一下就複製全組信箱。',
    status: { kind: 'ok', evidence: 'UX 新手系辦 任務 8' },
  }, async () => {
    // 組員信箱欄在表格右側、超出畫面寬度；引擎只會上下捲，所以先把表格平滑橫捲到按鈕。
    const copy = groups.getByRole('button', { name: '複製本組信箱：G07' });
    await t.scroll(copy);
    await copy.evaluate((el) => el.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' }));
    await t.wait(900);
    await t.click(copy);
    await t.waitStable({ ready: toast(/^已複製/) });
    await t.hover(toast(/^已複製/));
  });

  await t.step({
    caption: '匯出組別名單',
    narration: '組別名單可以匯出 CSV 或 XLSX，一位組員一列，含組長和老師標示。',
    status: { kind: 'ok', evidence: 'story-6 第 9～10 步' },
  }, async () => {
    await t.scroll(groups.getByRole('button', { name: '匯出篩選結果（CSV）' }));
    await t.click(groups.getByRole('button', { name: '匯出篩選結果（CSV）' }));
    await t.waitStable({ ready: toast(/^已匯出/) });
    await t.hover(toast(/^已匯出/));
    await t.hover(groups.getByRole('button', { name: '匯出篩選結果（XLSX）' }));
  });

  await t.step({
    caption: '沒成立的提案',
    narration: '被拒絕、逾期、作廢的提案留在這裡，看得到原因。',
    status: { kind: 'ok', evidence: 'story-2 第 12 步' },
  }, async () => {
    const ended = page.getByRole('region', { name: '最近終止的提案' });
    await t.scroll(ended);
    await t.hover(ended.getByRole('heading', { name: '最近終止的提案' }));
    await t.hover(ended.getByText(/還沒有終止的提案|作廢理由/).first());
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
