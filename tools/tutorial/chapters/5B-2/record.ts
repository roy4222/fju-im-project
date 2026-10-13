// 5B-2 系辦｜完整編輯器：建一個繳交項目（分鏡 storyboard.md §4 5B-2）。
//   INSTANCE=4 tools/tutorial/env/reset.sh && node tools/tutorial/chapters/5B-2/setup.mjs && node tools/tutorial/chapters/5B-2/record.ts
// 輸出：~/work/tutorial-out/chapters/5B-2/（runs/ 底下是每次錄影的 run 目錄，成品複製成 5B-2.mp4＋events.json）。
// TUTORIAL_SILENT=1 改用無聲配音（只試定位器、不出成品）。

import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { launchTutorialBrowser, newTutorialPage, renderChapter, silentProvider, startChapter, type Chapter } from '../../engine/index.ts';

const ID = '5B-2';
const n = Number(process.env.INSTANCE ?? 4);
const baseURL = `http://localhost:${3300 + n}`;
const out = join(homedir(), 'work', 'tutorial-out', 'chapters', ID);
const accounts = JSON.parse(readFileSync(join(homedir(), 'work', 'tutorial-secrets', n ? `accounts-${n}.json` : 'accounts.json'), 'utf8')).accounts;
const admin = accounts.find((a: { create?: string }) => a.create === 'admin');
const pdf = join(import.meta.dirname, '示範檔案.pdf');

const browser = await launchTutorialBrowser();
let chapter: Chapter | undefined;
try {
  const page = await newTutorialPage(browser);
  const t = (chapter = await startChapter({
    page, id: ID, chapter: '系辦｜完整編輯器：建一個繳交項目', outRoot: join(out, 'runs'),
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
  // 截止：14 天後 23:59（臺灣時間），datetime-local 的值
  const due = `${new Date(Date.now() + 14 * 86_400_000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' })}T23:59`;
  await t.goto('/dashboard/admin/affairs');

  await t.step({
    caption: '完整編輯器長什麼樣',
    narration: '完整編輯器四區：內容、繳交欄位、發布設定、預覽確認。頂列是標題、儲存狀態和發布按鈕。',
    status: { kind: 'ok', evidence: 'story-2 第 36 步' },
  }, async () => {
    await t.click(main.getByRole('link', { name: '用完整編輯器建立' }));
    await t.hover(main.getByText(/綁定屆別：示範 114 屆（DEMO-114）（建立後不能換）/));
    await t.type(main.getByLabel('標題', { exact: true }), '示範：期中報告初稿');
  });

  await t.step({
    caption: '內容區',
    narration: '正文可以直接打字，進階排版用 HTML；公告分類填「競賽資訊」才會出現在前台競賽頁並多出日期欄。',
    status: { kind: 'pending', say: 'HTML 說明和競賽分類怎麼改', evidence: '用詞#15；UX N-18、N-19' },
  }, async () => {
    await t.type(main.getByLabel('正文'), '請上傳期中報告初稿 PDF。\n內容含題目、動機與進度。');
    await t.hover(main.getByText('可以直接打字；進階排版可用 HTML'));
    const picker = main.locator('label').filter({ hasText: '加入附件' });
    await t.upload(picker.locator('input[type=file]'), pdf, { via: picker });
    await t.waitStable({ ready: main.getByText('示範檔案.pdf') });
    await t.hover(main.getByLabel(/^摘要/));
    await t.hover(main.getByTestId('category-competition'));
  });

  await t.step({
    caption: '啟用繳交、新增欄位',
    narration: '新項目預設不收資料，先按啟用繳交。欄位有 13 種類型，例如短文字、長文字、檔案上傳。每個欄位設標籤、說明、必填。',
    status: { kind: 'ok', evidence: 'story-2 第 36、38 步' },
  }, async () => {
    await t.click(main.getByRole('button', { name: '啟用繳交（改為文件繳交）' }));
    await t.select(main.getByLabel('要新增的欄位類型'), '短文字');
    await t.click(main.getByRole('button', { name: '新增欄位' }));
    const label = main.getByLabel(/^第 1 個欄位的/);
    await label.fill('');
    await t.type(label, '題目');
    await t.click(main.getByRole('checkbox', { name: '必填' }));
    await t.click(main.getByRole('button', { name: '完成', exact: true }));
  });

  await t.step({
    caption: '檔案上傳欄位',
    narration: '檔案上傳欄位可以限制副檔名和大小；也有「套用專題需求表欄位」一鍵帶入整組表單。',
    status: { kind: 'ok', evidence: 'story-2 第 38 步' },
  }, async () => {
    await t.select(main.getByLabel('要新增的欄位類型'), '檔案上傳');
    await t.click(main.getByRole('button', { name: '新增欄位' }));
    const label = main.getByLabel(/^第 2 個欄位的/);
    await label.fill('');
    await t.type(label, '報告 PDF');
    const pdfBox = main.getByRole('checkbox', { name: 'pdf', exact: true });
    if (!(await pdfBox.isChecked())) await t.click(pdfBox);
    const max = main.getByRole('spinbutton');
    await max.fill('');
    await t.type(max, '20');
    await t.click(main.getByRole('checkbox', { name: '必填' }));
    await t.click(main.getByRole('button', { name: '完成', exact: true }));
    await t.hover(main.getByRole('button', { name: /套用專題需求表欄位/ }));
  });

  await t.step({
    caption: '發布設定',
    narration: '文件繳交一定要有階段和截止；整組一份還是個人一份在這裡選，有人作答後就鎖定不能換。',
    status: { kind: 'ok', evidence: 'story-2 第 38 步（PUB-06）' },
  }, async () => {
    await t.scroll(main.getByRole('heading', { name: '發布設定' }));
    await t.select(main.getByLabel('顯示在哪一區', { exact: true }), '文件繳交');
    await t.select(main.getByLabel('誰看得到'), '本屆學生');
    await t.click(main.getByRole('radio', { name: '整組一份' }));
    const stage = main.getByLabel('所屬階段');
    await t.select(stage, (await stage.locator('option').nth(1).textContent())!);
    await t.click(main.getByLabel(/^截止時間/));
    await main.getByLabel(/^截止時間/).fill(due);
  });

  await t.step({
    caption: '三種視角預覽',
    narration: '預覽可以切訪客、學生、老師視角，訪客看不到的會直接寫「訪客看不到這一筆」。',
    status: { kind: 'ok', evidence: 'story-2 第 38 步' },
  }, async () => {
    await t.click(main.getByRole('button', { name: '檢查與預覽' }));
    await t.waitStable({ ready: main.getByRole('group', { name: '預覽視角' }) });
    await t.click(main.getByRole('button', { name: '訪客視角' }));
    await t.hover(main.getByText('訪客看不到這一筆'));
    await t.click(main.getByRole('button', { name: '學生視角' }));
    await t.click(main.getByRole('button', { name: '老師視角' }));
  });

  await t.step({
    caption: '發布繳交項目',
    narration: '繳交項目一定通知名單上的人。回執後清單多一列，學生那邊的我的繳交馬上出現。',
    status: { kind: 'ok', evidence: 'story-2 第 38 步' },
  }, async () => {
    await t.click(main.getByRole('button', { name: '發布', exact: true }));
    const dialog = page.getByRole('dialog', { name: '發布前檢查' });
    await t.waitStable({ ready: dialog.getByRole('button', { name: '確認發布' }) });
    await t.hover(dialog.getByText('新的繳交項目一定會通知名單上需要繳交的人（站內通知）。'));
    await t.click(dialog.getByRole('button', { name: '確認發布' }));
    await t.waitStable({ ready: dialog.getByRole('heading', { name: '已發布' }) });
    await t.hover(dialog.getByRole('heading', { name: '已發布' }));
    await t.click(dialog.getByRole('link', { name: '回列表' }));
  });

  await t.step({
    caption: '發布後的編輯器',
    narration: '發布後頂列變成撤回、下架、發布更新；右邊的發布紀錄列每次發布、改內容、改截止、有沒有勾通知。',
    status: { kind: 'ok', evidence: 'story-2 第 24 步' },
  }, async () => {
    await t.click(main.getByRole('link', { name: '編輯：示範：期中報告初稿' }));
    await t.hover(main.getByTestId('item-status'));
    await t.hover(main.getByRole('button', { name: '撤回', exact: true }));
    await t.hover(main.getByRole('button', { name: '下架', exact: true }));
    await t.hover(main.getByRole('button', { name: '發布更新' }));
    await t.hover(main.getByRole('region', { name: '發布紀錄' }));
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
