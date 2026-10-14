// 6-1 開發者後台｜四頁（分鏡 storyboard.md 第 6 章 6-1，錄法 C：不碰 VM、讀 status/fixtures/base/ 的假資料）。
//   先在 status/ 起 next dev（見 setup.mjs 開頭的說明），再：
//   node tools/tutorial/chapters/6-1/setup.mjs && node tools/tutorial/chapters/6-1/record.ts
// 輸出：~/work/tutorial-out/chapters/6-1/（runs/ 底下是每次錄影的 run 目錄，成品複製成 6-1.mp4＋events.json）。
// TUTORIAL_SILENT=1 改用無聲配音（只試定位器、不出成品）。

import { copyFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { launchTutorialBrowser, newTutorialPage, renderChapter, silentProvider, startChapter, type Chapter } from '../../engine/index.ts';

const ID = '6-1';
const baseURL = process.env.STATUS_URL ?? 'http://127.0.0.1:3350';
const out = join(homedir(), 'work', 'tutorial-out', 'chapters', ID);

const browser = await launchTutorialBrowser();
let chapter: Chapter | undefined;
try {
  const page = await newTutorialPage(browser);
  const t = (chapter = await startChapter({
    page, id: ID, chapter: '開發者後台｜四頁', outRoot: join(out, 'runs'),
    baseURL, displayOrigin: 'https://fju-status.roy422.dev', ...(process.env.TUTORIAL_SILENT ? { tts: silentProvider() } : {}),
  }));
  console.log(`錄影目錄：${t.outDir}`);

  const main = page.getByRole('main');
  const side = (name: string) => page.locator('[data-sidebar="sidebar"]').getByRole('link', { name, exact: true });
  const card = (name: RegExp) => main.getByRole('link', { name });
  // 工具卡片連到正式網址、開新分頁：只 hover 不點
  await t.goto('/');

  await t.step({
    caption: '開發者後台總覽',
    narration: '這是只有 Roy 看得到的開發者後台。正式網址前面有 Cloudflare Access 擋著。影片用本機的假資料在本機錄，畫面跟線上一樣。',
    status: { kind: 'ok', evidence: '設計方案 §3.2（兩道鎖）；本機略過見錄法 A；錄法 C 讀 status/fixtures/base/' },
  }, async () => {
    await t.waitStable({ ready: main.getByRole('heading', { name: '總覽' }) });
    await t.hover(side('總覽'));
    await t.hover(side('測試地圖'));
    await t.hover(side('能不能上線'));
  });

  await t.step({
    caption: '三個版本對不對',
    narration: '版本卡片把每一站三個版本號並排：main 的 CI、最後一次部署、站台自己回報的。三個不一樣那一列會變黃，寫「版本不一致」。',
    status: { kind: 'ok', evidence: '設計方案 §3.8 補充（版本卡片）' },
  }, async () => {
    const versions = main.getByRole('table').first();
    await t.hover(versions.getByRole('row').filter({ hasText: '測試站' }));
    await t.hover(versions.getByText('版本不一致'));
  });

  await t.step({
    caption: '三頁與三個工具',
    narration: '下面三張卡是三頁，等一下逐頁看。Dozzle 看容器 log、PgHero 看測試站資料庫，這部影片不進去。卡片點了會開新分頁，影片只移過去不點。',
    status: { kind: 'ok', evidence: '既有保證（status/src/lib/data/hosts.ts PAGES／toolEntries）' },
  }, async () => {
    await t.scroll(card(/^測試地圖/));
    await t.hover(card(/^測試地圖/));
    await t.hover(card(/^開發進度/));
    await t.hover(card(/^能不能上線/));
    await t.hover(card(/^Dozzle/));
    await t.hover(card(/^PgHero/));
  });

  await t.step({
    caption: 'Beszel 還沒開通',
    narration: 'Beszel 看 VM 的 CPU、記憶體和磁碟，有自己的登入，Roy 還沒建第一個帳號，影片不示範。這裡等 Roy 決定：什麼時候建帳號、要不要留它。',
    status: { kind: 'pending', say: 'Beszel 帳號何時建', evidence: '設計方案 §4「Roy 要做的事」：第一次開 Beszel 建帳號（可延後）' },
  }, async () => {
    await t.hover(card(/^Beszel/));
  });

  await t.step({
    caption: '票做到哪',
    narration: '開發進度讀 repo 裡主腦維護的票清單。先看總數、六種狀態各幾張，還有票清單是哪個 commit 的。',
    status: { kind: 'ok', evidence: '設計方案 §3.10；資料是 docs/status/tickets.json' },
  }, async () => {
    await t.click(side('開發進度'));
    await t.waitStable({ ready: main.getByText(/^共 \d+ 張票/) });
    await t.hover(main.getByText(/^共 \d+ 張票/));
    await t.hover(main.getByText(/^票清單最後更新/));
    await t.hover(main.getByText(/^做中/).first());
  });

  await t.step({
    caption: '每張票的 PR 與狀態',
    narration: '每個批次一張表，一列一張票：狀態、對到的 PR、相依哪幾張。票清單跟 GitHub 對不上的列會變黃並寫原因，提醒主腦去改檔；這頁不會自己改。',
    status: { kind: 'ok', evidence: '設計方案 §3.10（對不上標黃、不自動改檔）' },
  }, async () => {
    const table = main.getByRole('table').first();
    await t.scroll(table);
    await t.hover(table.getByRole('columnheader', { name: 'PR' }));
    await t.hover(table.getByRole('row').nth(1));
  });

  await t.step({
    caption: 'main 的 CI 與最近合併',
    narration: '右邊是 main 最新一次 CI 的結果，和最近五個合併的 PR；點了會到 GitHub，影片不點。',
    status: { kind: 'ok', evidence: '既有保證' },
  }, async () => {
    await t.scroll(main.getByText('main 最新 CI'));
    await t.hover(main.getByText(/：success$/));
    await t.hover(main.getByText('最近 5 個合併的 PR'));
  });

  await t.step({
    caption: '一句話：能不能上線',
    narration: '這頁只回答一件事：現在能不能上線。五條條件全綠才會寫「可以上線」，不然就寫還有幾條沒過。',
    status: { kind: 'ok', evidence: '設計方案 §3.8' },
  }, async () => {
    await t.click(side('能不能上線'));
    await t.waitStable({ ready: main.getByText(/^五條/) });
    await t.hover(main.getByText(/^(可以上線|還不能上線)$/));
    await t.hover(main.getByText(/^五條/));
  });

  await t.step({
    caption: '五條上線條件',
    narration: '五條是：CI 全綠、驗收沒有擋上線的問題、測試站半小時都健康、正式站 24 小時內有備份、設定齊全。灰是資料不夠，也算不過。',
    status: { kind: 'ok', evidence: '設計方案 §3.8；G2 的必要項在 docs/status/go-live-policy.json' },
  }, async () => {
    for (const g of ['CI 全綠', /^驗收：擋上線/, '測試站健康', '24 小時內有正式站備份', '正式站設定齊全'] as const) {
      await t.hover(main.getByText(g, typeof g === 'string' ? { exact: true } : undefined).first());
    }
  });

  await t.step({
    caption: '不算條件的補充',
    narration: '下面是補充：最近一次完整驗收測的是哪個版本、之後 main 有沒有新 commit。正式站網域的 DNS 記錄還沒有自動檢查，上線前要自己看一眼。',
    status: { kind: 'warn', say: 'DNS 記錄要上線前自己確認', evidence: '設計方案 §3.8 G5：A 記錄檢查未輸出，頁面自己註明' },
  }, async () => {
    await t.scroll(main.getByText('補充資訊（不是上線條件）'));
    await t.hover(main.getByText(/^最近一次完整驗收：/));
    await t.hover(main.getByText(/^G5 的「fju\.roy422\.dev 有 A 記錄」/));
  });

  await t.step({
    caption: '哪個角色點過哪個功能',
    narration: '測試地圖把最近一夜整夜驗收的結果攤成角色乘功能的格子。綠勾是每一步都過，三角是有狀況，白格是沒測到，橫線是不適用。',
    status: { kind: 'ok', evidence: '設計方案 §3.9；Q27' },
  }, async () => {
    await t.click(side('測試地圖'));
    await t.waitStable({ ready: main.getByText(/^最新一次完整驗收：/) });
    await t.hover(main.getByText(/^最新一次完整驗收：/));
    await t.hover(main.getByText(/^✅ 有點過（每一步都通過/));
    await t.hover(main.getByRole('columnheader', { name: '訪客' }));
  });

  await t.step({
    caption: '點格子看每一步',
    narration: '點一格會開右邊的抽屜，列出那一夜這個角色在這個功能的每一步和看到什麼。最下面是對應的自動測試檔。線上還會有每一步的截圖縮圖，這份假資料沒有。',
    status: { kind: 'ok', evidence: '設計方案 §3.9；C 模式：base fixture 的截圖陣列為空，不出現縮圖' },
  }, async () => {
    await t.click(main.getByRole('link', { name: /有點過/ }).first());
    await t.waitStable({ ready: page.getByText('看到什麼：首頁有三則公告') });
    // 抽屜要開到配音講完：每一處停一下再關
    await t.hover(page.getByText('story-1 第 1 步'));
    await t.wait(2500);
    await t.hover(page.getByText('看到什麼：首頁有三則公告'));
    await t.wait(2500);
    await t.hover(page.getByText('web/e2e/public-pages.spec.ts'));
    await t.wait(2500);
    await t.click(page.getByRole('link', { name: '關閉' }).or(page.getByRole('button', { name: '關閉' })).first());
  });

  await t.step({
    caption: '前台每一區有沒有後台',
    narration: '第二張表是前台每一區由哪個後台頁維護、能做什麼、有沒有測過。沒有後台的區在線上是紅底；這份假資料只有一區，而且有後台。',
    status: { kind: 'ok', evidence: '設計方案 §3.9；Q27；C 模式：base fixture 只有「首頁・最新公告」一區且有後台' },
  }, async () => {
    await t.scroll(main.getByText('前台每一區', { exact: true }));
    await t.hover(main.getByRole('columnheader', { name: '管理後台頁' }));
    await t.hover(main.getByText('/dashboard/admin/affairs'));
    await t.hover(main.getByText(/^新增：有/));
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
