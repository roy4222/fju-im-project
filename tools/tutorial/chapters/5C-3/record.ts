// 5C-3 系辦｜成果展示、產學合作案（分鏡 storyboard.md §4 5C-3）。
//   INSTANCE=4 tools/tutorial/env/reset.sh && node tools/tutorial/chapters/5C-3/setup.mjs && node tools/tutorial/chapters/5C-3/record.ts
// 輸出：~/work/tutorial-out/chapters/5C-3/（runs/ 底下是每次錄影的 run 目錄，成品複製成 5C-3.mp4＋events.json）。
// TUTORIAL_SILENT=1 改用無聲配音（只試定位器、不出成品）。

import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { launchTutorialBrowser, newTutorialPage, renderChapter, silentProvider, startChapter, type Chapter } from '../../engine/index.ts';

const ID = '5C-3';
const n = Number(process.env.INSTANCE ?? 4);
const baseURL = `http://localhost:${3300 + n}`;
const out = join(homedir(), 'work', 'tutorial-out', 'chapters', ID);
const accounts = JSON.parse(readFileSync(join(homedir(), 'work', 'tutorial-secrets', n ? `accounts-${n}.json` : 'accounts.json'), 'utf8')).accounts;
const admin = accounts.find((a: { create?: string }) => a.create === 'admin');
const poster = join(import.meta.dirname, '示範海報.jpg');

const browser = await launchTutorialBrowser();
let chapter: Chapter | undefined;
try {
  const page = await newTutorialPage(browser);
  const t = (chapter = await startChapter({
    page, id: ID, chapter: '系辦｜成果展示、產學合作案', outRoot: join(out, 'runs'),
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
  const nav = (name: string) => page.getByRole('navigation').getByRole('link', { name, exact: true });
  const g01 = main.getByTestId('showcase-draft').filter({ has: page.getByRole('form', { name: 'G01 的成果展示草稿' }) });
  const ref = '示範 114 屆（DEMO-114） G01';
  await t.goto('/dashboard/admin');

  await t.step({
    caption: '成果展示是什麼',
    narration: '成果展示管對外展示的作品：發布後登入的人在歷屆專題一覽看到，有獎項的才進訪客的優秀專題。入口名稱要不要改「專題成果管理」等你決定。',
    status: { kind: 'pending', say: '成果展示要不要改名', evidence: '用詞#32' },
  }, async () => {
    await t.click(nav('成果展示'));
    await t.hover(main.getByText(/勾選同意並按「發布」後/));
    await t.hover(main.getByRole('region', { name: '作品一覽' }));
  });

  await t.step({
    caption: '編輯草稿',
    narration: '題目、摘要、海報、影片連結存成草稿版本，不會改到前台。影片連結格式錯會提示要 https 開頭。',
    status: { kind: 'ok', evidence: 'story-4 第 5 步；story-4 N-18' },
  }, async () => {
    await t.click(main.getByRole('region', { name: '作品一覽' }).getByRole('row').filter({ hasText: 'G01' }).getByRole('link', { name: '管理' }));
    const form = g01.getByRole('form', { name: 'G01 的成果展示草稿' });
    const summary = form.getByLabel(/^摘要/);
    await summary.fill('');
    await t.type(summary, '示範：依護理人力與排班規則自動產生班表草案。');
    await t.type(form.getByLabel(/^影片連結/), 'https://example.com/demo-video');
    await t.upload(form.getByLabel('選擇海報圖檔'), poster, { via: form.getByText(/^(上傳海報|換一張)$/) });
    await t.waitStable({ ready: form.getByText('（儲存後才會換上）') });
    await t.click(form.getByRole('button', { name: '儲存草稿' }));
    await t.waitStable({ ready: g01.getByText(/草稿已儲存/) });
    await t.hover(g01.getByText(/草稿已儲存/));
  });

  await t.step({
    caption: '發布作品',
    narration: '要勾已取得同意才能發布；G01 的同意書已完成，發布後登入師生就看得到。',
    status: { kind: 'ok', evidence: 'story-4 第 6 步' },
  }, async () => {
    const form = g01.getByRole('form', { name: `發布 ${ref}` });
    await t.scroll(g01.getByRole('group', { name: '公開' }));
    await t.click(form.getByRole('checkbox', { name: /已取得這組同學同意公開/ }));
    await t.click(form.getByRole('button', { name: '發布' }));
    await t.waitStable({ ready: g01.getByRole('form', { name: `公開中 ${ref}` }) });
    await t.hover(g01.getByText('公開中').first());
  });

  await t.step({
    caption: '獎項與首頁順序',
    narration: '選了獎項才會上訪客的優秀專題和首頁輪播；首頁順序決定排第幾。',
    status: { kind: 'ok', evidence: 'story-4 第 2 步' },
  }, async () => {
    const award = g01.getByRole('form', { name: `${ref} 的獎項` });
    await t.scroll(g01.getByRole('group', { name: '獎項' }));
    await t.select(award.getByLabel('獎項等級'), '優秀專題');
    await t.type(award.getByLabel(/^獎項名稱/), '示範：第 43 屆專題競賽第一名');
    await t.click(award.getByRole('button', { name: '儲存獎項' }));
    await t.waitStable({ ready: award.getByRole('status') });
    const order = g01.getByRole('form', { name: `${ref} 的首頁順序` });
    await t.type(order.getByLabel(/^首頁順序/), '1');
    await t.click(order.getByRole('button', { name: '儲存順序' }));
    await t.waitStable({ ready: order.getByRole('status') });
    await t.hover(order.getByRole('status'));
  });

  await t.step({
    caption: '補登歷屆',
    narration: '以前沒在平台上的作品可以補登到已封存的歷屆。',
    status: { kind: 'ok', evidence: '既有保證（SHW-07）' },
  }, async () => {
    const backfill = main.getByRole('form', { name: '補登歷屆作品' });
    await t.scroll(backfill);
    await t.hover(backfill.getByLabel(/^屆別/));
    await t.hover(backfill.getByLabel(/^作品題目/));
    await t.hover(backfill.getByRole('button', { name: '補登作品' }));
  });

  await t.step({
    caption: '系辦看合作案',
    narration: '系辦看全部合作案、負責老師和連結的組；可以代老師編輯、下架，或解除組別連結（必填理由）。',
    status: { kind: 'ok', evidence: 'story-4 第 1 步' },
  }, async () => {
    await t.click(nav('產學合作'));
    await t.hover(main.getByRole('region', { name: '合作案摘要' }));
    const row = main.getByTestId('managed-opportunity').filter({ hasText: '宏昇物流股份有限公司' });
    await t.hover(row.getByText('陳建宏 老師'));
    await t.hover(row.getByText(/・G02$/));
    await t.hover(row.getByRole('button', { name: '解除連結：G02' }));
    await t.hover(row.getByRole('button', { name: /^編輯：宏昇物流/ }));
    await t.hover(row.getByRole('button', { name: /^下架：宏昇物流/ }));
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
