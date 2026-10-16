// 2-3 段首準備（先跑 INSTANCE=2 tools/tutorial/env/reset.sh）：
// 以系辦身分在帳號管理「新增老師」（直接新增）建立虛構老師「示範新老師」，記下只顯示一次的臨時密碼，
// 寫在 ~/work/tutorial-secrets/rec2-2-3-<實例>.json（權限 600，不進 repo）給 record.ts 讀。走網站 UI（無頭瀏覽器），不直接寫資料庫。
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const BASE = process.env.TUTORIAL_BASE ?? 'http://localhost:3302';
const INSTANCE = process.env.INSTANCE ?? '2';
const TEACHER = { name: '示範新老師', email: 'demo.new.teacher@demo.invalid' };
const secrets = join(homedir(), 'work', 'tutorial-secrets');

const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
if (!health.ok) throw new Error(`網站沒準備好：${JSON.stringify(health)}`);

const accounts = JSON.parse(readFileSync(join(secrets, `accounts-${INSTANCE}.json`), 'utf8')).accounts;
const list = execFileSync(process.execPath, [join(import.meta.dirname, '../../env/accounts.mjs'), 'list'], { env: { ...process.env, INSTANCE }, encoding: 'utf8' });
const adminEmail = list.split('\n').map((l) => l.trim().split(/\s{2,}/)).find((c) => c[1] === '系辦管理員')?.[2];
const adminPassword = accounts.find((a) => a.name === '系辦管理員')?.password;

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ locale: 'zh-TW', viewport: { width: 1280, height: 800 } });
  const res = await ctx.request.post(`${BASE}/api/auth/sign-in/email`, { data: { email: adminEmail, password: adminPassword }, headers: { origin: BASE } });
  if (!res.ok()) throw new Error(`系辦管理員登不進去：HTTP ${res.status()}`);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/dashboard/admin/accounts`);
  await page.waitForLoadState('networkidle');
  if (await page.getByRole('main').getByText(TEACHER.email).count()) throw new Error(`「${TEACHER.name}」已經存在：先跑 reset.sh`);
  await page.getByRole('button', { name: '新增老師' }).click();
  const dialog = page.getByRole('dialog', { name: '新增老師' });
  await dialog.getByRole('radio', { name: /^直接新增/ }).check();
  await dialog.getByRole('textbox', { name: '登入 Email' }).fill(TEACHER.email);
  await dialog.getByRole('textbox', { name: '姓名' }).fill(TEACHER.name);
  await dialog.getByRole('radio', { name: '當面核對身分證件（教職員證、身分證）' }).check();
  await dialog.getByRole('button', { name: '建立並產生臨時密碼' }).click();
  // 臨時密碼只顯示一次：取對話框裡唯一一段像密碼的字（code／唯讀欄位）
  const shown = dialog.locator('code, input[readonly]').first();
  await shown.waitFor({ timeout: 15_000 });
  const temp = ((await shown.inputValue().catch(() => null)) ?? (await shown.textContent()) ?? '').trim();
  if (temp.length < 8) throw new Error('沒有取到臨時密碼');
  const file = join(secrets, `rec2-2-3-${INSTANCE}.json`);
  writeFileSync(file, JSON.stringify({ ...TEACHER, tempPassword: temp }, null, 2), { mode: 0o600 });
  console.log(`2-3 準備完成（網站版本 ${health.commit.slice(0, 7)}；已建立「${TEACHER.name}」，臨時密碼寫在 ${file}）`);
} finally {
  await browser.close();
}
