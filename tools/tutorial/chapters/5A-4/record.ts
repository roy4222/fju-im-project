// 5A-4｜系辦｜專題時程、活動、測試用時間（分鏡 storyboard.md §4 5A-4，8 步）。
// 本段會新增、取消並刪除一個活動，並把測試用時間（原模擬時鐘）撥到第 2 階段；錄完（不論成敗）一定跑 clock-reset.sh 撥回真實時間。
//   INSTANCE=3 tools/tutorial/env/reset.sh && INSTANCE=3 node tools/tutorial/chapters/5A-4/setup.mjs
//   INSTANCE=3 node tools/tutorial/chapters/5A-4/record.ts
// 成品：~/work/tutorial-out/chapters/5A-4/5A-4.mp4＋events.json。
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { launchTutorialBrowser, newTutorialPage, renderChapter, startChapter, type Chapter } from '../../engine/index.ts';

const ID = '5A-4';
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
  const t = (chapter = await startChapter({ page, id: ID, chapter: '系辦｜專題時程、活動、測試用時間', baseURL: BASE, displayOrigin: 'test.fju.roy422.dev' }));
  console.log(`錄影目錄：${t.outDir}`);
  await t.offRecord(() => login(page, '系辦管理員'));
  await t.goto('/dashboard/admin');

  const nav = page.getByRole('navigation', { name: '後台導覽' });
  const event = '示範成果發表會';
  // 「兩個月後」：照網站顯示的系統時間往後推 61 天（seed-demo 的日期跟著種子當天平移）。
  const inTwoMonths = new Date(Date.now() + 61 * 86_400_000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });

  await t.step({
    caption: '專題時程',
    narration: '側欄「設定」底下的「專題時程」分頁：全屆共用的四個階段和日期；上面寫現在是哪個階段、時間過了多少。「系統時間」這個詞要不要改「目前時間（臺灣）」等你決定。',
    status: { kind: 'pending', say: '「系統時間」要不要改「目前時間（臺灣）」', evidence: '用詞#26（系統時間）' },
  }, async () => {
    await t.click(nav.getByRole('link', { name: '設定', exact: true }));
    await t.click(page.getByRole('navigation', { name: '設定分頁' }).getByRole('link', { name: '專題時程', exact: true }));
    await page.waitForURL(/\/dashboard\/admin\/timeline/);
    await t.hover(page.getByText(/・系統時間 /));
    await t.hover(page.getByRole('region', { name: '時間軸' }).getByText(/^目前・/));
    await t.hover(page.getByRole('region', { name: '時間軸' }).getByText(/時間已過 \d+%/));
  });

  await t.step({
    caption: '編輯階段',
    narration: '四個階段各有名稱、開始日、一句話說明；右邊即時預覽學生看到的樣子。',
    status: { kind: 'ok', evidence: 'story-1 第 11 步' },
  }, async () => {
    await t.click(page.getByRole('button', { name: '編輯階段與日期', exact: true }));
    const dialog = page.getByRole('dialog').last();
    await t.waitStable({ ready: dialog.getByRole('textbox', { name: '第 1 階段名稱' }) });
    await t.hover(dialog.getByRole('textbox', { name: '第 1 階段名稱' }));
    await t.hover(dialog.getByRole('textbox', { name: '第 1 階段開始日' }));
    await t.hover(dialog.getByRole('textbox', { name: /^第 1 階段一句話說明/ }));
    await t.hover(dialog.getByRole('complementary', { name: '學生看到的樣子' }));
    await t.click(dialog.getByRole('button', { name: '先不改' }));
  });

  await t.step({
    caption: '新增活動',
    narration: '說明會、發表會這類有日期的活動在這裡排；選誰看得到，公開的訪客首頁也會出現。',
    status: { kind: 'ok', evidence: 'story-1 第 12～13 步' },
  }, async () => {
    await t.click(page.getByRole('button', { name: '新增活動' }));
    const dialog = page.getByRole('dialog').last();
    await t.waitStable({ ready: dialog.getByRole('textbox', { name: '活動名稱' }) });
    await t.type(dialog.getByRole('textbox', { name: '活動名稱' }), event);
    // 原生日期欄逐字輸入會依點的位置落在不同欄位，所以游標移過去後直接填值。
    await t.hover(dialog.getByRole('textbox', { name: '日期' }));
    await dialog.getByRole('textbox', { name: '日期' }).fill(inTwoMonths);
    await t.click(dialog.getByRole('checkbox', { name: '全天' }));
    await t.select(dialog.getByRole('combobox', { name: '誰看得到' }), '公開（訪客也看得到）');
    await t.click(dialog.getByRole('button', { name: '建立活動' }));
    const done = page.getByText(`已新增活動「${event}」。`);
    await t.waitStable({ ready: done });
    await t.hover(done);
  });

  await t.step({
    caption: '改期與取消',
    narration: '活動可以改期或取消；取消的留在已取消面板、不會刪除，學生行事曆會標「已取消」。',
    status: { kind: 'ok', evidence: '規格 02 COH-03（10/12 驗收只看到入口）' },
  }, async () => {
    await t.scroll(page.getByRole('region', { name: '已排定的活動' }).getByText(event, { exact: true }));
    await t.hover(page.getByRole('button', { name: `改期：${event}` }));
    await t.click(page.getByRole('button', { name: `取消活動：${event}` }));
    const dialog = page.getByRole('dialog').last();
    await t.waitStable({ ready: dialog.getByRole('button', { name: '確定取消' }) });
    await t.click(dialog.getByRole('button', { name: '確定取消' }));
    const cancelled = page.getByRole('region', { name: '已取消的活動' });
    await t.waitStable({ ready: cancelled.getByRole('listitem').filter({ hasText: event }) });
    await t.scroll(cancelled);
    await t.hover(cancelled.getByRole('listitem').filter({ hasText: event }));
  });

  await t.step({
    caption: '刪除已取消的活動',
    narration: '只有已取消的活動可以刪，刪了不能恢復，只留操作紀錄；排定中的要先取消。',
    status: { kind: 'ok', evidence: '第三波 W11（10/12 驗收未走）' },
  }, async () => {
    const danger = page.getByRole('region', { name: '危險操作' });
    await t.scroll(danger);
    await t.click(danger.getByRole('button', { name: `刪除活動：${event}` }));
    const dialog = page.getByRole('dialog').last();
    await t.waitStable({ ready: dialog.getByRole('button', { name: '刪除這個活動' }) });
    await t.hover(dialog.getByText(/^從後台「已取消」清單/));
    await t.hover(dialog.getByText(/^不能。刪除紀錄會留在操作紀錄/));
    await t.click(dialog.getByRole('button', { name: '刪除這個活動' }));
        await t.wait(800);
  });

  // 第 2 階段開始日：照時間軸卡片上的日期（seed-demo 會平移日期，不寫死）。
  const stage2 = (await page.getByRole('list', { name: '本屆階段' }).getByRole('button', { name: /^題目與計畫書/ }).innerText()).match(/\d{4}-\d{2}-\d{2}/)![0];

  await t.step({
    caption: '測試用時間是什麼',
    narration: '「測試用時間」只有測試站有，沒有放在任何選單裡，要直接輸入網址進去：把系統認定的今天設到任何一秒，用來看階段切換和截止前後。正式站沒有這一頁。',
    status: { kind: 'ok', evidence: 'C2-02 模擬時鐘改名「測試用時間」、拿掉入口，路由 /dashboard/admin/clock 保留' },
  }, async () => {
    await t.goto('/dashboard/admin/clock', { ready: page.getByRole('heading', { name: '測試用時間', level: 1 }) });
    await t.hover(page.getByRole('heading', { name: '測試用時間', level: 1 }));
    await t.hover(page.getByText(/^測試站專用/));
  });

  await t.step({
    caption: '把時間撥到第 2 階段',
    narration: '設完後全站的今天就跳到第 2 階段；原因可以不寫，每次設定都留紀錄，不能改不能刪。',
    status: { kind: 'ok', evidence: '規格 02 COH-10' },
  }, async () => {
    const when = page.getByRole('textbox', { name: '要模擬的系統時間（臺灣時間，到秒）' });
    await t.hover(when);
    await when.fill(`${stage2}T09:00`);
    await t.type(page.getByRole('textbox', { name: /^原因/ }), '教學示範');
    await t.click(page.getByRole('button', { name: '設定模擬時間' }));
    const done = page.getByText(/^已設定模擬時間/);
    await t.waitStable({ ready: done });
    await t.hover(done);
  });

  await t.step({
    caption: '模擬後各頁跟著變',
    narration: '回首頁看，階段變成第 2 階段，眉標多了模擬鐘。錄完要設回真實時間。',
    status: { kind: 'ok', evidence: '規格 02 COH-04' },
  }, async () => {
    await t.click(nav.getByRole('link', { name: '首頁', exact: true }));
    await t.hover(page.getByText(/^現在是「階段 2/));
    await t.hover(page.getByText(/模擬鐘/).first());
  });

  await t.finish();
} finally {
  await chapter?.dispose();
  await browser.close();
  // 段尾一定把模擬時鐘撥回真實時間（失敗也要）。
  try {
    execFileSync(join(import.meta.dirname, '../../env/clock-reset.sh'), { env: { ...process.env, INSTANCE }, stdio: 'inherit' });
  } catch {
    console.error(`模擬時鐘沒有撥回真實時間：請手動跑 INSTANCE=${INSTANCE} tools/tutorial/env/clock-reset.sh`);
  }
}

const out = join(homedir(), 'work/tutorial-out/chapters', ID);
await renderChapter({ dir: chapter!.outDir });
mkdirSync(out, { recursive: true });
copyFileSync(join(chapter!.outDir, 'chapter.mp4'), join(out, `${ID}.mp4`));
copyFileSync(join(chapter!.outDir, 'events.json'), join(out, 'events.json'));
console.log(`成品：${join(out, `${ID}.mp4`)}`);
