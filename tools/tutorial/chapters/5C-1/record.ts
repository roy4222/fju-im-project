// 5C-1 系辦｜成績管理（分鏡 storyboard.md §4 5C-1）。
//   INSTANCE=4 tools/tutorial/env/reset.sh && node tools/tutorial/chapters/5C-1/setup.mjs && node tools/tutorial/chapters/5C-1/record.ts
// 輸出：~/work/tutorial-out/chapters/5C-1/（runs/ 底下是每次錄影的 run 目錄，成品複製成 5C-1.mp4＋events.json）。
// TUTORIAL_SILENT=1 改用無聲配音（只試定位器、不出成品）。

import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { launchTutorialBrowser, newTutorialPage, renderChapter, silentProvider, startChapter, type Chapter } from '../../engine/index.ts';

const ID = '5C-1';
const n = Number(process.env.INSTANCE ?? 4);
const baseURL = `http://localhost:${3300 + n}`;
const out = join(homedir(), 'work', 'tutorial-out', 'chapters', ID);
const accounts = JSON.parse(readFileSync(join(homedir(), 'work', 'tutorial-secrets', n ? `accounts-${n}.json` : 'accounts.json'), 'utf8')).accounts;
const admin = accounts.find((a: { create?: string }) => a.create === 'admin');

const browser = await launchTutorialBrowser();
let chapter: Chapter | undefined;
try {
  const page = await newTutorialPage(browser);
  const t = (chapter = await startChapter({
    page, id: ID, chapter: '系辦｜成績管理', outRoot: join(out, 'runs'),
    baseURL, displayOrigin: 'test.fju.roy422.dev', ...(process.env.TUTORIAL_SILENT ? { tts: silentProvider() } : {}),
  }));
  console.log(`錄影目錄：${t.outDir}`);
  await t.offRecord(async () => {
    await page.context().clearCookies();
    await page.goto(`${baseURL}/login`);
    await page.getByLabel('Email').fill(admin.email);
    await page.getByLabel('密碼', { exact: true }).fill(admin.password);
    await page.getByRole('button', { name: '登入', exact: true }).click();
    await page.waitForURL((u) => u.pathname.startsWith('/dashboard/admin'));
  });
  const main = page.getByRole('main');
  const scheme = main.getByRole('region', { name: '評分規則' });
  await t.goto('/dashboard/admin');

  await t.step({
    caption: '評分規則',
    narration: '成績管理先看評分規則：階段、項目、權重。老師開始評分後就鎖定，要改得建新版。頁底的 Σ 公式和「權重」對第一次用的系辦太難。',
    status: { kind: 'pending', say: '公式和權重要不要改白話', evidence: 'UX N-04、N-20；用詞#5' },
  }, async () => {
    await t.click(page.getByRole('navigation').getByRole('link', { name: '成績管理', exact: true }));
    await t.scroll(scheme);
    await t.hover(scheme.getByTestId('scheme-status'));
    await t.hover(scheme.getByText('評分項目與權重不能再改；要改請建立新版評分規則'));
    await t.hover(scheme.getByText(/^最終成績 = 系統驗收 × 60%/));
  });

  await t.step({
    caption: '建新版評分規則',
    narration: '新版可以改權重、加減項目；型態有分數、等第 A–F、通過／不通過。合計不到 100% 不能建。',
    status: { kind: 'warn', say: '建完後頁首標題被擠成直排', evidence: 'story-3 第 2、22 步；錄影時發現：成功訊息擠在頁首右側' },
  }, async () => {
    await t.click(main.getByRole('button', { name: '建立新版評分規則' }));
    const d = page.getByRole('dialog', { name: '建立新版評分規則' });
    await t.waitStable({ ready: d.getByText('階段合計') });
    const weight = (n: number) => d.getByRole('listitem', { name: `第 ${n} 個階段` }).getByLabel('占總成績 %');
    await t.hover(d.getByRole('listitem', { name: '第 1 個階段' }).getByRole('columnheader', { name: '權重 %' }));
    await weight(1).fill('');
    await t.type(weight(1), '70');
    await weight(2).fill('');
    await t.type(weight(2), '30');
    await t.hover(d.getByText(/^階段合計 100%/));
    await t.click(d.getByRole('button', { name: '建立草稿' }));
    await t.waitStable({ ready: main.getByText(/版本紀錄（2）/) });
  });

  await t.step({
    caption: '版本紀錄與發布',
    narration: '草稿要到版本紀錄裡才有發布鈕；成功訊息有指路，但沒有直接的發布入口。',
    status: { kind: 'pending', say: '建完草稿要不要直接給發布鈕', evidence: 'UX N-05' },
  }, async () => {
    // 網站現況：這則成功訊息擠在頁首右側，把標題擠成一字一行（回報給主腦，不改網站）
    await t.hover(main.getByText(/^已建立評分規則第 2 版（草稿）/));
    await t.scroll(scheme);
    await t.click(scheme.getByRole('button', { name: '版本紀錄（2）' }));
    const d = page.getByRole('dialog', { name: '評分規則各版' });
    await t.waitStable({ ready: d.getByRole('table', { name: '評分規則各版' }) });
    await t.hover(d.getByRole('row').filter({ hasText: '第 1 版' }));
    await t.hover(d.getByRole('row').filter({ hasText: '第 2 版' }));
  });

  await t.step({
    caption: '看新版的重算影響',
    narration: '套用新版前先看每組成績會從多少變成多少；套用後不能退回，所以放在危險操作。這裡只看不套用。',
    status: { kind: 'ok', evidence: 'story-3 第 22 步；用詞#6' },
  }, async () => {
    await t.click(page.getByRole('dialog', { name: '評分規則各版' }).getByRole('link', { name: '查看第 2 版重算影響（尚不套用）' }));
    await t.hover(main.getByRole('table', { name: '套用影響' }));
    await t.scroll(main.getByRole('heading', { name: '危險操作' }));
    await t.hover(main.getByRole('button', { name: '確認套用第 2 版' }));
    await t.click(main.getByRole('link', { name: '取消（不重算）' }));
  });

  await t.step({
    caption: '評分指派',
    narration: '每組每階段設需要幾位老師，再逐位指派。老師的草稿分數系辦這裡看得到，方便協助。',
    status: { kind: 'ok', evidence: 'story-3 第 4、9 步；Q37' },
  }, async () => {
    await t.click(main.getByRole('button', { name: '評分要求與指派' }));
    const d = page.getByRole('dialog', { name: '評分要求與指派' });
    await t.waitStable({ ready: d.getByRole('table', { name: '系統驗收 評分指派' }) });
    await t.hover(d.getByRole('navigation', { name: '選擇階段' }));
    await t.hover(d.getByTestId('grading-row-G02').getByText(/評分草稿（未送出）/));
  });

  await t.step({
    caption: '指派老師評分',
    narration: '指派後老師收到通知，評分頁多一組。',
    status: { kind: 'ok', evidence: 'story-3 第 4 步' },
  }, async () => {
    const row = page.getByRole('dialog', { name: '評分要求與指派' }).getByTestId('grading-row-G07');
    await t.scroll(row);
    await t.select(row.getByLabel('G07「系統驗收」評分老師'), '王雅玲');
    await t.click(row.getByRole('button', { name: '指派' }));
    await t.waitStable({ ready: row.getByRole('status') });
    await t.hover(row.getByRole('status'));
  });

  await t.step({
    caption: '各組成績',
    narration: '各組成績表列每階段平均和最終成績，完成狀態一眼看出哪組還缺份。',
    status: { kind: 'ok', evidence: 'story-3 第 15 步' },
  }, async () => {
    await t.click(page.getByRole('dialog', { name: '評分要求與指派' }).getByRole('button', { name: '關閉' }));
    await t.scroll(main.getByRole('table', { name: '成績表' }));
    await t.click(main.getByRole('button', { name: '篩選完成狀態' }));
    await t.click(page.getByRole('menuitemradio', { name: '已完成' }));
    await t.waitStable();
    const g04 = main.getByRole('table', { name: '成績表' }).getByRole('row').filter({ hasText: /^G04/ });
    await t.hover(g04.getByRole('cell').nth(3));
    await t.click(g04.getByRole('link', { name: '計算明細' }));
  });

  await t.step({
    caption: '計算明細',
    narration: '計算明細把每位老師的原始輸入、四捨五入前的分數和算式都列出來。',
    status: { kind: 'ok', evidence: 'story-3 第 16 步；story-3 N-16' },
  }, async () => {
    await t.hover(main.getByText(/× 60% ＋/).first());
    await t.hover(main.getByRole('table', { name: '系統驗收 計入成績的評分' }).getByRole('columnheader', { name: '分數（四捨五入前）' }));
    await t.scroll(main.getByText('評分指派紀錄'));
  });

  await t.step({
    caption: '系辦更正最終成績',
    narration: '系辦可以更正最終成績，老師原始輸入不動、理由必填，成績表標已更正。',
    status: { kind: 'ok', evidence: 'story-3 第 17 步' },
  }, async () => {
    await t.scroll(main.getByRole('button', { name: '更正最終成績' }));
    await t.click(main.getByRole('button', { name: '更正最終成績' }));
    const d = page.getByRole('dialog', { name: '更正最終成績' });
    await t.waitStable({ ready: d });
    await t.type(d.getByLabel(/^更正後的最終成績/), '88');
    await t.type(d.getByLabel('更正理由'), '示範：口試加分經系務會議通過');
    await t.click(d.getByRole('button', { name: '確認更正' }));
    await t.waitStable({ ready: main.getByText(/已更正：原/) });
    await t.hover(main.getByText(/已更正：原/));
  });

  await t.step({
    caption: '退回老師的評分',
    narration: '退回後那份變未完成，老師收到理由重評；之前的更正變成「需要重新確認」，等老師重送後系辦再決定保留或改。',
    status: { kind: 'ok', evidence: 'story-3 第 18～21 步' },
  }, async () => {
    const back = main.getByRole('button', { name: '退回 陳建宏 老師的「系統驗收」評分' });
    await t.scroll(back);
    await t.click(back);
    const d = page.getByRole('dialog', { name: '退回評分' });
    await t.waitStable({ ready: d });
    await t.type(d.getByLabel('退回理由（老師看得到）'), '請補系統展示項目的說明');
    await t.click(d.getByRole('button', { name: '確認退回' }));
    await t.waitStable({ ready: main.getByText(/更正需要重新確認/).first() });
    await t.scroll(main.getByText(/更正需要重新確認/).first());
    await t.hover(main.getByText(/更正需要重新確認/).first());
  });

  await t.step({
    caption: '匯出成績',
    narration: '成績匯出 CSV 或 Excel，一位學生一列，含各階段老師分數、最終成績和更正註記。',
    status: { kind: 'ok', evidence: 'story-3 第 23 步、story-6 第 17～18 步' },
  }, async () => {
    await t.scroll(-3000);
    await t.click(main.getByRole('link', { name: '← 評分' }));
    await t.scroll(main.getByRole('table', { name: '成績表' }));
    await t.click(main.getByRole('button', { name: '匯出 CSV' }));
    await t.waitStable({ ready: main.getByText(/^已匯出 \d+ 組/) });
    await t.hover(main.getByText(/^已匯出 \d+ 組/));
    await t.hover(main.getByRole('button', { name: '匯出 Excel（XLSX）' }));
  });

  await t.finish();
} finally {
  await chapter?.dispose();
  await browser.close();
}
if (!process.env.TUTORIAL_SILENT) {
  const { file } = await renderChapter({ dir: chapter!.outDir });
  mkdirSync(out, { recursive: true });
  copyFileSync(file, join(out, `${ID}.mp4`));
  copyFileSync(join(chapter!.outDir, 'events.json'), join(out, 'events.json'));
  console.log(`成品：${join(out, `${ID}.mp4`)}`);
}
