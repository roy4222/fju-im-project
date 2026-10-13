// 5B-4 系辦｜撤回、下架、刪除、規則與榮譽（分鏡 storyboard.md §4 5B-4）。
//   INSTANCE=4 tools/tutorial/env/reset.sh && node tools/tutorial/chapters/5B-4/setup.mjs && node tools/tutorial/chapters/5B-4/record.ts
// 輸出：~/work/tutorial-out/chapters/5B-4/（runs/ 底下是每次錄影的 run 目錄，成品複製成 5B-4.mp4＋events.json）。
// TUTORIAL_SILENT=1 改用無聲配音（只試定位器、不出成品）。

import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { launchTutorialBrowser, newTutorialPage, renderChapter, silentProvider, startChapter, type Chapter } from '../../engine/index.ts';

const ID = '5B-4';
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
    page, id: ID, chapter: '系辦｜撤回、下架、刪除、規則與榮譽', outRoot: join(out, 'runs'),
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
  const filter = (name: string) => main.getByRole('navigation', { name: '種類' }).getByRole('link', { name, exact: true });
  const edit = (title: string | RegExp) => main.getByRole('listitem').filter({ hasText: title }).getByRole('link', { name: /^編輯：/ });
  const topBtn = (name: string) => main.getByRole('button', { name, exact: true });
  const lifecycle = (title: string) => page.getByRole('dialog', { name: title });
  await t.goto('/dashboard/admin/affairs');

  await t.step({
    caption: '撤回',
    narration: '撤回是把還沒人回覆的內容收回成草稿，看得到的人都看不到，改好再發布，網址不變。',
    status: { kind: 'ok', evidence: 'story-2 第 27～28 步' },
  }, async () => {
    await t.click(filter('公告'));
    await t.waitStable();
    await t.click(edit(/^公告114 學年度專題分組作業/));
    await t.click(topBtn('撤回'));
    await t.waitStable({ ready: lifecycle('撤回成草稿？') });
    await t.hover(lifecycle('撤回成草稿？').getByText(/只有還沒有任何人作答時可以撤回/));
    await t.click(lifecycle('撤回成草稿？').getByRole('button', { name: '取消' }));
  });

  await t.step({
    caption: '下架',
    narration: '下架讓前台看不到，但後台保留內容、回覆和紀錄，可以重新發布。',
    status: { kind: 'ok', evidence: 'story-2 第 29～31 步' },
  }, async () => {
    await t.click(topBtn('下架'));
    const d = lifecycle('下架這個項目？');
    await t.waitStable({ ready: d });
    await t.hover(d.getByText(/既有回答、需要繳交的名單與紀錄都保留/));
    await t.click(d.getByRole('button', { name: '確認下架' }));
    await t.waitStable({ ready: main.getByText(/^已下架：前台網址顯示/) });
    await t.hover(main.getByText(/^已下架：前台網址顯示/));
  });

  await t.step({
    caption: '重新發布',
    narration: '重新發布回到發布中，原網址和開放時間不變。',
    status: { kind: 'ok', evidence: 'story-2 第 31 步' },
  }, async () => {
    await t.click(topBtn('重新發布'));
    const d = lifecycle('重新發布？');
    await t.waitStable({ ready: d });
    await t.click(d.getByRole('button', { name: '確認重新發布' }));
    await t.waitStable({ ready: main.getByTestId('item-status').getByText('發布中') });
    await t.hover(main.getByTestId('item-status'));
  });

  await t.step({
    caption: '刪除草稿',
    narration: '刪除只能刪草稿或已下架的，不能恢復，已寄的通知不收回。發布中的要先撤回或下架。',
    status: { kind: 'ok', evidence: 'Q28／W0 定案' },
  }, async () => {
    await t.click(main.getByRole('link', { name: '專題事務', exact: true }).first());
    await t.click(edit('（草稿）期末成果展場地與時段調查'));
    await t.scroll(main.getByRole('heading', { name: '危險操作' }));
    await t.click(main.getByRole('button', { name: '刪除這則公告' }));
    const d = page.getByRole('dialog', { name: '刪除這則公告？' });
    await t.waitStable({ ready: d });
    await t.hover(d.getByText('後果'));
    await t.click(d.getByRole('button', { name: '刪除這則公告' }));
    await t.waitStable({ ready: main.getByRole('heading', { name: '專題事務', exact: true }) });
  });

  await t.step({
    caption: '有人交件的不能刪',
    narration: '已經有學生交件的繳交項目只能下架不能刪，保護學生的紀錄。',
    status: { kind: 'ok', evidence: 'Q28 定案' },
  }, async () => {
    await t.click(filter('文件繳交'));
    await t.waitStable();
    await t.click(edit('暑期企業參訪報名表（已下架）'));
    await t.scroll(main.getByRole('heading', { name: '危險操作' }));
    await t.hover(main.getByTestId('delete-blocked'));
  });

  await t.step({
    caption: '專題規則怎麼管',
    narration: '前台規則頁的每一節是一筆「專題規則」項目；改內容就改那一節。章節順序沒有地方調。',
    status: { kind: 'bad', say: '不能調規則章節順序', evidence: 'P-34' },
  }, async () => {
    await t.goto('/dashboard/admin/affairs');
    await t.click(filter('專題規則'));
    await t.waitStable();
    await t.click(edit('四、專題分組、選取指導老師'));
    await t.scroll(main.getByRole('heading', { name: '發布設定' }));
    await t.hover(main.getByLabel('顯示在哪一區', { exact: true }));
    await t.hover(main.getByLabel('誰看得到'));
  });

  await t.step({
    caption: '發布榮譽',
    narration: '榮譽是跨屆的公開紀錄，發布後出現在前台榮譽榜和首頁榮譽區，不發通知。',
    status: { kind: 'pending', say: '榮譽和競賽資訊入口要不要分清楚', evidence: 'story-4 第 8 步；UX N-19' },
  }, async () => {
    await t.goto('/dashboard/admin/affairs');
    await t.click(filter('榮譽'));
    await t.waitStable();
    await t.click(edit('大專校院資訊應用服務創新競賽 校內初選'));
    await t.scroll(main.getByRole('heading', { name: '發布設定' }));
    await t.hover(main.getByLabel(/^得獎日期/));
    await t.click(topBtn('發布'));
    const d = page.getByRole('dialog', { name: '發布前檢查' });
    await t.waitStable({ ready: d.getByRole('button', { name: '確認發布' }) });
    await t.hover(d.getByText(/榮譽榜不發站內通知/).first());
    await t.click(d.getByRole('button', { name: '確認發布' }));
    await t.waitStable({ ready: d.getByRole('heading', { name: '已發布' }) });
    await t.hover(d.getByRole('heading', { name: '已發布' }));
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
