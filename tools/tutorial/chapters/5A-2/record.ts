// 5A-2｜系辦｜帳號管理（分鏡 storyboard.md §4 5A-2，12 步）。上傳用的 CSV／TXT 由 setup.mjs 產生。
//   INSTANCE=3 tools/tutorial/env/reset.sh && INSTANCE=3 node tools/tutorial/chapters/5A-2/setup.mjs
//   INSTANCE=3 node tools/tutorial/chapters/5A-2/record.ts
// 成品：~/work/tutorial-out/chapters/5A-2/5A-2.mp4＋events.json。
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { launchTutorialBrowser, newTutorialPage, renderChapter, startChapter, type Chapter } from '../../engine/index.ts';

const ID = '5A-2';
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
  const t = (chapter = await startChapter({ page, id: ID, chapter: '系辦｜帳號管理', baseURL: BASE, displayOrigin: 'test.fju.roy422.dev' }));
  console.log(`錄影目錄：${t.outDir}`);
  await t.offRecord(() => login(page, '系辦管理員'));
  await t.goto('/dashboard/admin');

  const dialog = page.getByRole('dialog').last();
  const pending = page.getByRole('region', { name: '待審核' });
  const accounts = page.getByRole('table', { name: '帳號列表' });
  const search = page.getByRole('searchbox', { name: '搜尋姓名、學號或 Email' });
  // 示範資料有兩位周子瑜（114 屆組長 411410300、113 屆已停用的 410410500），用學號鎖定 114 屆那位。
  const zhou = accounts.getByRole('row').filter({ hasText: '411410300' });

  await t.step({
    caption: '帳號管理總覽',
    narration: '名單匯入、註冊審核、停用、匯出、臨時密碼都在這一頁。系統不存可查看的密碼，只能發一次性臨時密碼。',
    status: { kind: 'ok', evidence: 'story-1 第 40 步' },
  }, async () => {
    await t.click(page.getByRole('navigation', { name: '後台導覽' }).getByRole('link', { name: '帳號管理', exact: true }));
    await t.hover(page.getByRole('link', { name: /^待審核 \d/ }));
    await t.hover(page.getByRole('link', { name: /^已停用 \d/ }));
    await t.hover(page.getByRole('button', { name: '發臨時密碼', exact: true }));
    await t.hover(page.getByRole('button', { name: '新增老師' }));
  });

  await t.step({
    caption: '名單比對結果',
    narration: '名單比對只協助判斷，不會自動核准；每筆寫符合、不符或不在名單上。',
    status: { kind: 'ok', evidence: 'story-2 第 2 步' },
  }, async () => {
    await t.hover(pending.getByRole('columnheader', { name: '比對結果' }));
    await t.hover(pending.getByText('資料不符'));
    await t.hover(pending.getByText('不在本屆名單上').first());
  });

  await t.step({
    caption: '審核對話框',
    narration: '審核把申請資料和名冊並排，差在哪一欄一眼看出來。',
    status: { kind: 'ok', evidence: 'story-1 第 24 步' },
  }, async () => {
    await t.click(page.getByRole('button', { name: '審核 許庭瑋' }));
    await t.waitStable({ ready: dialog.getByRole('table', { name: '申請資料與名冊並列' }) });
    await t.hover(dialog.getByRole('row', { name: /^姓名/ }));
  });

  await t.step({
    caption: '核准一位',
    narration: '核准一定要選怎麼確認是本人，方式和說明都寫進操作紀錄。退回則一定要寫理由，申請人看得到。',
    status: { kind: 'ok', evidence: 'story-1 第 24 步' },
  }, async () => {
    await t.click(dialog.getByRole('radio', { name: '當面核對學生證或其他身分證件' }));
    await t.type(dialog.getByRole('textbox', { name: /^理由/ }), '櫃台核對學生證，名單誤字已確認');
    await t.click(dialog.getByRole('button', { name: '核准' }));
    await t.waitStable({ ready: dialog.getByText(/^已開通，進入/) });
    await t.hover(dialog.getByText(/^已開通，進入/));
    await t.click(dialog.getByRole('button', { name: '關閉' }));
  });

  await t.step({
    caption: '批次核准',
    narration: '可以勾多位一起核准，但不在名單上的會被略過、要個別審。按鈕的人數現在只算還在清單上的人。',
    status: { kind: 'pending', say: '名單外的人能不能批次核准', evidence: 'UX N-03（10/13 已修）；UX N-22：名單外的人能不能用同一方式批次核准' },
  }, async () => {
    await t.click(page.getByRole('checkbox', { name: '勾選待審 陳冠宇' }));
    await t.click(page.getByRole('checkbox', { name: '勾選待審 劉思妤' }));
    await t.click(page.getByRole('button', { name: '核准勾選的 2 位' }));
    await t.waitStable({ ready: dialog.getByRole('heading', { name: '批次核准預覽' }) });
    await t.hover(dialog.getByText(/^略過：/).first());
    await t.click(dialog.getByRole('button', { name: '取消' }));
  });

  await t.step({
    caption: '新增老師',
    narration: '老師不用註冊也不用審核。直接新增會產生只顯示一次的臨時密碼，交給老師本人，第一次登入必須改密碼。',
    status: { kind: 'ok', evidence: 'story-1 第 27 步；UX 新手系辦 任務 4' },
  }, async () => {
    await t.click(page.getByRole('button', { name: '新增老師' }));
    await t.waitStable({ ready: dialog.getByRole('heading', { name: '新增老師' }) });
    await t.click(dialog.getByRole('radio', { name: /^直接新增/ }));
    await t.type(dialog.getByRole('textbox', { name: '登入 Email' }), 'demo.teacher@demo.invalid');
    await t.type(dialog.getByRole('textbox', { name: '姓名' }), '示範新老師');
    await t.click(dialog.getByRole('radio', { name: '當面核對身分證件（教職員證、身分證）' }));
    await t.click(dialog.getByRole('button', { name: '建立並產生臨時密碼' }));
    await t.waitStable({ ready: dialog.getByRole('button', { name: '複製' }) });
    await t.hover(dialog.getByRole('button', { name: '複製' }));
    await t.click(dialog.getByRole('button', { name: '關閉' }));
  });

  await t.step({
    caption: '匯入本屆名單',
    narration: '名單用 CSV 匯入：先看欄名對照和範例檔，上傳後先預覽有效、重複、缺欄、衝突，確認才匯入。這裡只預覽。',
    status: { kind: 'pending', say: 'CSV、UTF-8、英文欄名的用詞', evidence: '用詞#16、#17、#19～23（CSV、UTF-8、英文欄名要不要改白話）；流程本身 ✅ story-1 第 19 步' },
  }, async () => {
    await t.click(page.getByRole('button', { name: '匯入名單 CSV' }));
    await t.waitStable({ ready: dialog.getByRole('table', { name: '名單欄名對照' }) });
    await t.hover(dialog.getByRole('table', { name: '名單欄名對照' }));
    await t.upload(dialog.locator('input[type=file]'), join(FIXTURES, 'roster.csv'), { via: dialog.getByRole('button', { name: '選擇名單 CSV 檔' }) });
    await t.waitStable({ ready: dialog.getByRole('button', { name: /^匯入 \d+ 筆$/ }) });
    await t.hover(dialog.getByText('有效', { exact: true }));
    await t.hover(dialog.getByRole('combobox', { name: '匯入到哪一屆' }));
    await t.hover(dialog.getByRole('button', { name: /^匯入 \d+ 筆$/ }));
    await t.click(dialog.getByRole('button', { name: '關閉' }));
  });

  await t.step({
    caption: '匯出名單',
    narration: '篩選後整批匯出 CSV，或勾選幾筆只匯出勾的；檔名帶屆別和時間。',
    status: { kind: 'warn', say: '匯出的狀態欄寫「已核准」不是「啟用」', evidence: 'story-6 N-08：CSV「狀態」欄寫「已核准」，驗收預期「啟用」，尚未改' },
  }, async () => {
    await t.scroll(page.getByRole('heading', { name: '全部帳號' }));
    await t.click(page.getByRole('button', { name: '篩選角色' }));
    await t.click(page.getByRole('menuitemradio', { name: '學生' }));
    await t.waitStable({ ready: page.getByRole('button', { name: /^匯出全部篩選結果/ }) });
    await t.click(page.getByRole('button', { name: /^匯出全部篩選結果/ }));
    await t.waitStable({ ready: page.getByRole('status').filter({ hasText: /^已匯出/ }) });
    await t.hover(page.getByRole('status').filter({ hasText: /^已匯出/ }));
  });

  await t.step({
    caption: '停用帳號',
    narration: '停用不是刪除：資料保留、登入立刻失效、可以恢復。停組長時要指定接任的組長。',
    status: { kind: 'ok', evidence: 'story-6 第 13～14 步' },
  }, async () => {
    await t.type(search, '周子瑜');
    await t.press('Enter'); // 搜尋要按 Enter 才會篩選
    await t.waitStable({ ready: zhou });
    await t.click(zhou.getByRole('button', { name: '更多 周子瑜' }));
    await t.click(page.getByRole('menuitem', { name: '停用 周子瑜' }));
    await t.waitStable({ ready: dialog.getByRole('heading', { name: '停用 周子瑜' }) });
    await t.select(dialog.getByRole('combobox', { name: /^接任 G01 組長/ }), '許哲瑋（411410301）');
    await t.type(dialog.getByRole('textbox', { name: /^理由/ }), '休學');
    await t.click(dialog.getByRole('button', { name: '確認停用' }));
    await t.waitStable({ ready: dialog.getByText(/的組長已改由/) });
    await t.hover(dialog.getByText(/的組長已改由/));
    await t.click(dialog.getByRole('button', { name: '關閉' }));
  });

  await t.step({
    caption: '恢復帳號',
    narration: '恢復後角色和學籍不變，原密碼還能登入。',
    status: { kind: 'ok', evidence: 'story-6 第 16 步；⚠️ story-6 N-50：被停用的人登入頁沒說明原因（建議）' },
  }, async () => {
    // 停用後列表會刷新（「更多」換成「恢復」）；等刷新完再點，免得點在刷新前的位置。
    await t.waitStable({ ready: zhou.getByRole('button', { name: '恢復 周子瑜' }) });
    await t.click(zhou.getByRole('button', { name: '恢復 周子瑜' }));
    await t.waitStable({ ready: dialog.getByRole('heading', { name: '恢復 周子瑜' }) });
    await t.type(dialog.getByRole('textbox', { name: /^理由/ }), '復學');
    await t.click(dialog.getByRole('button', { name: '確認恢復' }));
    await t.waitStable({ ready: dialog.getByText('已恢復', { exact: true }) });
    await t.hover(dialog.getByText('已恢復', { exact: true }));
    await t.click(dialog.getByRole('button', { name: '關閉' }));
  });

  await t.step({
    caption: '批次停用',
    narration: '畢業生一次停用很多人：貼學號或上傳 TXT，先預覽再確認。它放在頁面底部的危險操作區，和匯出分開。',
    status: { kind: 'pending', say: '「TXT」這個用詞', evidence: 'story-1 N-04（10/12 已修）；用詞#18（TXT）' },
  }, async () => {
    await t.scroll(page.getByRole('region', { name: '危險操作' }));
    await t.click(page.getByRole('button', { name: '批次停用（TXT）' }));
    await t.waitStable({ ready: dialog.getByRole('button', { name: '選擇 TXT 檔' }) });
    await t.upload(dialog.locator('input[type=file]'), join(FIXTURES, 'disable.txt'), { via: dialog.getByRole('button', { name: '選擇 TXT 檔' }) });
    await t.click(dialog.getByRole('button', { name: '預覽' }));
    await t.waitStable({ ready: dialog.getByRole('heading', { name: '批次停用預覽' }) });
    await t.hover(dialog.getByText('將停用', { exact: true }).first());
    await t.hover(dialog.getByRole('textbox', { name: /^理由/ }));
    await t.click(dialog.getByRole('button', { name: '上一步' }));
    await t.click(dialog.getByRole('button', { name: '取消' }));
  });

  await t.step({
    caption: '刪除個人資料（保留紀錄）',
    narration: '刪個資會留下紀錄但去掉姓名學號，不能恢復，所以要照打 Email 確認。這裡只看不按。',
    status: { kind: 'ok', evidence: '規格 01 ACC-14；⚠️ 10/12 驗收沒有實際執行這一步' },
  }, async () => {
    await search.fill('');
    await t.type(search, '呂承恩');
    await t.press('Enter'); // 搜尋要按 Enter 才會篩選
    await t.waitStable({ ready: accounts.getByRole('row').filter({ hasText: '呂承恩' }) });
    await t.click(accounts.getByRole('button', { name: '更多 呂承恩' }));
    await t.click(page.getByRole('menuitem', { name: '刪除 呂承恩 的個人資料' }));
    await t.waitStable({ ready: dialog.getByRole('heading', { name: /的個人資料（保留紀錄）$/ }) });
    await t.hover(dialog.getByText('做了就不能復原'));
    await t.hover(dialog.getByRole('textbox', { name: '照打登入 Email 確認' }));
    await t.click(dialog.getByRole('button', { name: '取消' }));
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
