// 2-1 段首準備（先跑 INSTANCE=2 tools/tutorial/env/reset.sh）：
// 乾淨 seed-demo＋reset 已把示範 114 屆設成「新註冊加入的屆別」。這裡確認註冊開放、虛構新生「林示範」還不存在，
// 再產生他的登入密碼（≥ 12 字），寫在 ~/work/tutorial-secrets/rec2-2-1-<實例>.json（權限 600，不進 repo）給 record.ts 讀。
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.TUTORIAL_BASE ?? 'http://localhost:3302';
const INSTANCE = process.env.INSTANCE ?? '2';
const EMAIL = '411410888@demo.invalid';

const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
if (!health.ok) throw new Error(`網站沒準備好：${JSON.stringify(health)}`);
const html = await fetch(`${BASE}/register`).then((r) => r.text());
if (!html.includes('送出註冊')) throw new Error('註冊頁沒有「送出註冊」：註冊沒開放？');

// 林示範還不存在：reset 後的新資料庫沒有他（seed-demo 不建）；沒 reset 就錄，2-1-2 送出註冊會失敗。
const password = `Demo-${randomBytes(9).toString('base64url')}`;
const file = join(homedir(), 'work', 'tutorial-secrets', `rec2-2-1-${INSTANCE}.json`);
writeFileSync(file, JSON.stringify({ name: '林示範', studentId: '411410888', className: '資管二甲', phone: '0912-000-888', email: EMAIL, password }, null, 2), { mode: 0o600 });
console.log(`2-1 準備完成（網站版本 ${health.commit.slice(0, 7)}；新生資料：${file}）`);
