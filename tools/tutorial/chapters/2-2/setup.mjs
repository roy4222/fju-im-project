// 2-2 段首準備（先跑 INSTANCE=2 tools/tutorial/env/reset.sh）：乾淨 seed-demo 就夠（林彥廷的手機是空的）。
// 這裡確認網站在跑、示範帳號登得進去，不寫任何資料。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.TUTORIAL_BASE ?? 'http://localhost:3302';
const INSTANCE = process.env.INSTANCE ?? '2';
const NAMES = ['林彥廷'];

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
}
console.log(`2-2 準備完成（網站版本 ${health.commit.slice(0, 7)}；${NAMES.join('、')} 可登入）`);
