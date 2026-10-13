// 4-2 段首準備（先跑 INSTANCE=2 tools/tutorial/env/reset.sh）：乾淨 seed-demo（G06 是產學組、連結李孟儒的合作案「昱鋼精機工業」、還沒有指導老師）。
// 這裡確認網站在跑、示範帳號登得進去、G06 還能擔任，不寫任何資料。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.TUTORIAL_BASE ?? 'http://localhost:3302';
const INSTANCE = process.env.INSTANCE ?? '2';
const NAMES = ['李孟儒', '陳建宏'];

const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
if (!health.ok) throw new Error(`網站沒準備好：${JSON.stringify(health)}`);
const accounts = JSON.parse(readFileSync(join(homedir(), 'work', 'tutorial-secrets', `accounts-${INSTANCE}.json`), 'utf8')).accounts;
const list = execFileSync(process.execPath, [join(import.meta.dirname, '../../env/accounts.mjs'), 'list'], { env: { ...process.env, INSTANCE }, encoding: 'utf8' });
for (const name of NAMES) {
  const email = list.split('\n').map((l) => l.trim().split(/\s{2,}/)).find((c) => c[1] === name)?.[2];
  const password = accounts.find((a) => a.name === name)?.password;
  const res = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`「${name}」登不進去：HTTP ${res.status}`);
  if (name !== '李孟儒') continue;
  const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const html = await fetch(`${BASE}/dashboard/teacher/groups`, { headers: { cookie } }).then((r) => r.text());
  if (!html.includes('擔任 G06 的指導老師')) throw new Error('G06 已經有指導老師：先跑 reset.sh');
}
console.log(`4-2 準備完成（網站版本 ${health.commit.slice(0, 7)}；${NAMES.join('、')} 可登入）`);
