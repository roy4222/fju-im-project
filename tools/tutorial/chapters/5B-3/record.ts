// 5B-3 系辦｜收件名單、補交、免繳（分鏡 storyboard.md §4 5B-3）。
//   INSTANCE=4 tools/tutorial/env/reset.sh && node tools/tutorial/chapters/5B-3/setup.mjs && node tools/tutorial/chapters/5B-3/record.ts
// 輸出：~/work/tutorial-out/chapters/5B-3/（runs/ 底下是每次錄影的 run 目錄，成品複製成 5B-3.mp4＋events.json）。
// TUTORIAL_SILENT=1 改用無聲配音（只試定位器、不出成品）。

import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { launchTutorialBrowser, newTutorialPage, renderChapter, silentProvider, startChapter, type Chapter } from '../../engine/index.ts';

const ID = '5B-3';
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
    page, id: ID, chapter: '系辦｜收件名單、補交、免繳', outRoot: join(out, 'runs'),
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
  const listItem = (title: string) => main.getByRole('listitem').filter({ hasText: title });
  await t.goto('/dashboard/admin');

  await t.step({
    caption: '收件名單與完成率',
    narration: '名單頁上面是完成率環：分母是需要繳交的人或組，免繳和已移出不算。',
    status: { kind: 'pending', say: '「表單第 N 版」用詞待決', evidence: 'story-2 第 43 步；用詞#10' },
  }, async () => {
    await t.click(page.getByRole('navigation').getByRole('link', { name: '專題事務', exact: true }));
    await t.click(main.getByRole('navigation', { name: '種類' }).getByRole('link', { name: '文件繳交', exact: true }));
    await t.waitStable();
    await t.click(listItem('專題分組名單確認表').getByRole('link', { name: /^繳交：/ }));
    await t.hover(main.getByText(/\d+%/).first());
    await t.hover(main.getByText('逾期未繳').first());
    await t.hover(main.getByText(/^表單第 \d+ 版$/).first());
  });

  await t.step({
    caption: '名單怎麼分',
    narration: '名單分目前名單、免繳、已不需要繳交。「已移出」已改成白話。',
    status: { kind: 'ok', evidence: '用詞#24（10/12 已改）' },
  }, async () => {
    const tabs = main.getByRole('navigation', { name: '名單分類' });
    await t.hover(tabs.getByRole('link', { name: /^目前名單/ }));
    await t.hover(tabs.getByRole('link', { name: /^免繳/ }));
    await t.hover(tabs.getByRole('link', { name: /^已不需要繳交/ }));
    await t.hover(main.getByText(/^已繳第 \d+ 次$/).first());
  });

  await t.step({
    caption: '看某一組交了什麼',
    narration: '點檢視看這一組每次正式送出的版本，看回答進內容。',
    status: { kind: 'ok', evidence: 'story-2 第 43 步' },
  }, async () => {
    await t.click(main.getByRole('link', { name: '查看 G07 組的繳交' }));
    const versions = main.getByRole('table', { name: '正式送出的版本' });
    await t.hover(versions.getByText('以此版為準'));
    await t.hover(versions.getByRole('link', { name: /看回答/ }).first());
  });

  await t.step({
    caption: '逾期的人怎麼補交',
    narration: '截止後逾期的人要補交，系辦在他的頁面單獨開放，其他人不受影響。',
    status: { kind: 'ok', evidence: 'UX 學期中系辦 任務 7' },
  }, async () => {
    await t.goto('/dashboard/admin/affairs');
    await t.click(listItem('專題說明會個人心得').getByRole('link', { name: /^繳交：/ }));
    await t.click(main.getByRole('link', { name: '查看 鄭凱文 的回答' }));
    await t.hover(main.getByText(/已經截止。這位學生需要晚交時/));
  });

  await t.step({
    caption: '開放補交',
    narration: '填期限和理由，學生會收到通知。他的狀態仍顯示未繳，下方列出補交期限；其他人仍是已截止。',
    status: { kind: 'ok', evidence: 'UX 學期中系辦 任務 7' },
  }, async () => {
    await t.click(main.getByRole('button', { name: '讓他補交' }));
    await t.hover(main.getByLabel(/^補交期限/));
    await t.type(main.getByLabel(/^理由/), '請假補交，已附證明。');
    await t.click(main.getByRole('button', { name: '開放補交' }));
    await t.waitStable({ ready: main.getByTestId('reopen-result') });
    await t.hover(main.getByTestId('reopen-result'));
  });

  await t.step({
    caption: '免繳還沒有操作',
    narration: '規格有「免繳」：系辦以理由讓某人不用交，不算分母。畫面有免繳分頁，但沒有設免繳的按鈕。',
    status: { kind: 'bad', say: '還不能設免繳', evidence: '規格 05 SUB-02' },
  }, async () => {
    await t.click(main.getByRole('link', { name: /^(← )?繳交名單$/ }).first());
    await t.click(main.getByRole('navigation', { name: '名單分類' }).getByRole('link', { name: /^免繳/ }));
    await t.waitStable();
    await t.hover(main.getByText(/^沒有免繳的/));
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
