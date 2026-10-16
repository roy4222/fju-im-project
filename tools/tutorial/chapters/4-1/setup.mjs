// 4-1 段首準備（先跑 INSTANCE=2 tools/tutorial/env/reset.sh）：
// 乾淨 seed-demo＋reset 的共用前置（示範 114 屆是後台預設查看的屆別）。另以系辦身分在「專題事務 → 新增項目」
// 發一則「全部老師」的重要公告，讓陳建宏的通知匣有內容；走網站 UI（無頭瀏覽器），再確認通知真的送到陳建宏。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const BASE = process.env.TUTORIAL_BASE ?? 'http://localhost:3302';
const INSTANCE = process.env.INSTANCE ?? '2';
const TITLE = '指導老師：期中進度檢核會議（示範）';

const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
if (!health.ok) throw new Error(`網站沒準備好：${JSON.stringify(health)}`);
const accounts = JSON.parse(readFileSync(join(homedir(), 'work', 'tutorial-secrets', `accounts-${INSTANCE}.json`), 'utf8')).accounts;
const list = execFileSync(process.execPath, [join(import.meta.dirname, '../../env/accounts.mjs'), 'list'], { env: { ...process.env, INSTANCE }, encoding: 'utf8' });
const login = (name) => ({
  email: list.split('\n').map((l) => l.trim().split(/\s{2,}/)).find((c) => c[1] === name)?.[2],
  password: accounts.find((a) => a.name === name)?.password,
});

const browser = await chromium.launch();
try {
  const as = async (name) => {
    const ctx = await browser.newContext({ locale: 'zh-TW', viewport: { width: 1280, height: 900 } });
    const res = await ctx.request.post(`${BASE}/api/auth/sign-in/email`, { data: login(name), headers: { origin: BASE } });
    if (!res.ok()) throw new Error(`「${name}」登不進去：HTTP ${res.status()}`);
    return ctx.newPage();
  };

  const admin = await as('系辦管理員');
  await admin.goto(`${BASE}/dashboard/admin/affairs`);
  await admin.waitForLoadState('networkidle');
  if (await admin.getByRole('link', { name: TITLE, exact: true }).count()) throw new Error(`「${TITLE}」已經發過：先跑 reset.sh`);
  await admin.getByRole('button', { name: '新增項目' }).click();
  const d = admin.getByRole('dialog', { name: '新增項目' });
  await d.getByRole('radio', { name: /^公告/ }).check();
  await d.getByRole('textbox', { name: '標題' }).fill(TITLE);
  await d.getByRole('combobox', { name: '誰看得到' }).selectOption('全部老師');
  await d.getByRole('button', { name: '下一步' }).click();
  await d.getByRole('textbox', { name: '說明' }).fill('請各位指導老師於下週三前確認所指導組別的期中進度，並在評分頁填寫檢核意見。');
  await d.getByRole('button', { name: '下一步' }).click();
  const important = d.getByRole('checkbox', { name: /^重要公告/ });
  if (!(await important.isChecked())) await important.check();
  await d.getByRole('button', { name: '發布', exact: true }).click();
  await d.getByRole('heading', { name: '已發布' }).waitFor({ timeout: 15_000 });

  // 通知由背景 worker 送：最多等 60 秒，直到陳建宏的通知匣看得到這則
  const teacher = await as('陳建宏');
  const deadline = Date.now() + 60_000;
  for (;;) {
    await teacher.goto(`${BASE}/dashboard/teacher/inbox`);
    if (await teacher.getByRole('region', { name: '通知列表' }).getByText(TITLE).count()) break;
    if (Date.now() > deadline) throw new Error('60 秒內陳建宏的通知匣沒有收到重要公告（worker 有在跑嗎？）');
    await teacher.waitForTimeout(2000);
  }
  console.log(`4-1 準備完成（網站版本 ${health.commit.slice(0, 7)}；已發「${TITLE}」給全部老師，陳建宏收到通知）`);
} finally {
  await browser.close();
}
