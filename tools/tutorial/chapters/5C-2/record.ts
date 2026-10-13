// 5C-2 系辦｜站內同意書（分鏡 storyboard.md §4 5C-2）。
//   INSTANCE=4 tools/tutorial/env/reset.sh && node tools/tutorial/chapters/5C-2/setup.mjs && node tools/tutorial/chapters/5C-2/record.ts
// 輸出：~/work/tutorial-out/chapters/5C-2/（runs/ 底下是每次錄影的 run 目錄，成品複製成 5C-2.mp4＋events.json）。
// TUTORIAL_SILENT=1 改用無聲配音（只試定位器、不出成品）。

import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { launchTutorialBrowser, newTutorialPage, renderChapter, silentProvider, startChapter, type Chapter } from '../../engine/index.ts';

const ID = '5C-2';
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
    page, id: ID, chapter: '系辦｜站內同意書', outRoot: join(out, 'runs'),
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
  const groups = main.getByRole('region', { name: '各組同意書' });
  const row = (code: string) => groups.getByTestId('package-cell').filter({ hasText: new RegExp(`^${code}`) });
  await t.goto('/dashboard/admin');

  await t.step({
    caption: '同意書總覽',
    narration: '站內同意書讓全組逐一同意某份內容，例如成果公開授權。總覽環顯示幾組完成、幾組等老師、幾組學生沒齊。',
    status: { kind: 'ok', evidence: 'story-3 第 24 步' },
  }, async () => {
    await t.click(page.getByRole('navigation').getByRole('link', { name: '站內同意書', exact: true }));
    const overall = main.getByRole('region', { name: '整體進度' });
    await t.hover(overall.getByText(/^\d+%$/));
    await t.hover(overall.getByRole('list', { name: '各狀態組數' }));
  });

  await t.step({
    caption: '各組進度與缺誰',
    narration: '每格一位學生，右邊短格是老師；缺幾位把老師也算進去，點開看是誰。',
    status: { kind: 'ok', evidence: 'story-3 第 31 步' },
  }, async () => {
    await t.click(groups.getByRole('navigation', { name: '選擇用途' }).getByRole('link', { name: /^最終文件授權/ }));
    await t.click(row('G05').getByText('缺 4 位'));
    await t.hover(row('G05').getByText(/還沒回覆/).first());
  });

  await t.step({
    caption: '建立一份同意書',
    narration: '建同意書選組別、用途、寫全文，參與者自動帶實際成員和指導老師。最終文件授權要先有成果展示草稿。',
    status: { kind: 'ok', evidence: 'story-3 第 26 步；UX 學期中系辦 任務 5' },
  }, async () => {
    await t.click(main.getByRole('button', { name: '新增站內同意書' }));
    const d = page.getByRole('dialog', { name: '新增站內同意書' });
    await t.waitStable({ ready: d.getByLabel('組別'), offRecord: true });
    await t.select(d.getByLabel('組別'), 'G09');
    await t.click(d.getByText('期中結果確認', { exact: true }));
    await t.hover(d.getByTestId('impact-preview'));
    await t.type(d.getByLabel(/^全文/), '本組確認期中系統驗收結果無誤。');
    await t.click(d.getByRole('button', { name: '建立站內同意書' }));
    await t.waitStable({ ready: d.getByRole('link', { name: '看剛建立的同意書' }), offRecord: true });
    await t.hover(d.getByRole('link', { name: '看剛建立的同意書' }));
  });

  await t.step({
    caption: '版本頁',
    narration: '版本頁有全文、附件、授權範圍、每個人同意的時間和檢查碼。',
    status: { kind: 'pending', say: '「檢查碼」「核對碼」用詞待決', evidence: '用詞#7、#8' },
  }, async () => {
    await t.goto('/dashboard/admin/signoff');
    await t.click(groups.getByRole('navigation', { name: '選擇用途' }).getByRole('link', { name: /^最終文件授權/ }));
    await t.click(row('G05').getByRole('link', { name: '第 1 版' }));
    await t.hover(main.getByRole('heading', { name: /G05・最終文件授權・同意書第 1 版/ }));
    await t.hover(main.getByText(/文件一致性檢查碼/).first());
  });

  await t.step({
    caption: '提醒',
    narration: '提醒會通知還沒回覆的人，24 小時只能提醒一次；學生沒齊時老師也會收到，文案說明還沒輪到。',
    status: { kind: 'ok', evidence: 'story-3 第 31 步；Q38' },
  }, async () => {
    const manage = main.getByRole('region', { name: '系辦管理' });
    await t.scroll(manage);
    await t.click(manage.getByRole('button', { name: '提醒未同意者' }));
    await t.waitStable({ ready: manage.getByText(/24 小時內不能再提醒同一版/), offRecord: true });
    await t.hover(manage.getByText(/24 小時內不能再提醒同一版/).first());
  });

  await t.step({
    caption: '重置、重開新版、作廢',
    narration: '重置是用原內容重開、全組重新同意；重開新版是建新版；作廢是永久停止這版。三個詞第一次用的人看不懂，等你圈選。',
    status: { kind: 'pending', say: '重置、重開、作廢用詞待決', evidence: '用詞#2、#3、#4' },
  }, async () => {
    await t.scroll(main.getByRole('heading', { name: '危險操作' }));
    await t.hover(main.getByRole('button', { name: /^重置/ }));
    await t.hover(main.getByRole('button', { name: /^作廢/ }));
    await t.click(main.getByRole('button', { name: /^重置/ }));
    const d = page.getByRole('dialog', { name: /^重置.*？$/ });
    await t.waitStable({ ready: d, offRecord: true });
    await t.hover(d.getByText(/將作廢的回覆/));
    await t.hover(d.getByLabel(/^理由/));
    await t.click(d.getByRole('button', { name: '先不要' }));
  });

  await t.step({
    caption: '匯出同意紀錄',
    narration: '完成的同意書可以匯出 CSV 明細和可列印頁給校方；每次匯出留紀錄。',
    status: { kind: 'warn', say: 'CSV 有幾欄沒有說明', evidence: 'story-6 第 19～21 步；story-6 N-51' },
  }, async () => {
    await t.goto('/dashboard/admin/signoff');
    await t.click(groups.getByRole('navigation', { name: '選擇用途' }).getByRole('link', { name: /^最終文件授權/ }));
    await t.click(row('G01').getByRole('link', { name: '第 1 版' }));
    const manage = main.getByRole('region', { name: '系辦管理' });
    await t.scroll(manage.getByText('匯出同意紀錄'));
    await t.hover(manage.getByRole('button', { name: '匯出可列印頁' }));
    // 匯出是 target=_blank 的表單：新分頁不在錄影裡，關掉後重新整理，看這次匯出留下的紀錄
    await t.click(manage.getByRole('button', { name: '匯出CSV 明細' }), false);
    await t.offRecord(async () => {
      await page.waitForTimeout(1500);
      for (const p of page.context().pages()) if (p !== page) await p.close();
    });
    await t.goto(page.url());
    await t.scroll(main.getByTestId('signoff-exports'));
    await t.hover(main.getByTestId('signoff-exports'));
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
