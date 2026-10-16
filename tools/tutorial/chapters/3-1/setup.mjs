// 3-1 段首準備（不進影片）：seed-demo 不產生通知，所以以系辦身分發兩則「本屆學生、重要公告」，
// 等背景 worker 把通知送進鄭凱文的通知匣。
//   INSTANCE=1 tools/tutorial/env/reset.sh && INSTANCE=1 node tools/tutorial/chapters/3-1/setup.mjs
import { chromium } from 'playwright';
import { BASE_URL, loginAs } from '../3-3/lib.ts';

export const NOTICE_TITLE = '分組名單確認表截止提醒';
// 第二則：通知匣要有兩則未讀，「標為已讀」一則之後「全部標為已讀」才有東西可按。
const NOTICES = [
  { title: '專題說明會出席提醒', body: '專題說明會請每組至少一位組員出席，地點與時間見活動頁。', summary: '專題說明會請每組至少一位組員出席。' },
  { title: NOTICE_TITLE, body: '「專題分組名單確認表」即將截止，還沒送出的組別請組長或任一組員盡快確認名單並送出。', summary: '分組名單確認表即將截止，請盡快送出。' },
];

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
  const page = await ctx.newPage();

  await loginAs(page, '系辦管理員', '/dashboard/admin/affairs');
  for (const n of NOTICES) {
    if (await page.getByText(n.title).count()) {
      console.log(`「${n.title}」已經存在，略過發布（要重來請先 reset.sh）`);
      continue;
    }
    await page.goto(`${BASE_URL}/dashboard/admin/editor/new`, { waitUntil: 'networkidle' });
    await page.locator('#ed-title').fill(n.title);
    await page.locator('#ed-body').fill(n.body);
    await page.locator('#ed-summary').fill(n.summary);
    await page.locator('#ed-placement').selectOption({ label: '公告' });
    await page.locator('#ed-audience').selectOption({ label: '本屆學生' });
    await page.getByLabel('重要公告：逐人發站內通知給對象').check();
    await page.getByRole('button', { name: '發布', exact: true }).first().click();
    await page.getByRole('button', { name: '確認發布' }).click();
    await page.getByText('回列表', { exact: true }).waitFor();
    await page.goto(`${BASE_URL}/dashboard/admin/affairs`, { waitUntil: 'networkidle' });
  }

  // 等 worker 送達：鄭凱文的通知匣出現這則（最多 3 分鐘）。
  await loginAs(page, '鄭凱文');
  const deadline = Date.now() + 180_000;
  for (;;) {
    await page.goto(`${BASE_URL}/dashboard/student/inbox`, { waitUntil: 'networkidle' });
    if ((await page.getByRole('main').getByText(NOTICE_TITLE).count()) && (await page.getByRole('main').getByText(NOTICES[0].title).count())) break;
    if (Date.now() > deadline) throw new Error(`3 分鐘內鄭凱文的通知匣沒有兩則重要公告的通知（worker 有在跑嗎？）`);
    await page.waitForTimeout(5000);
  }
  console.log('完成：兩則重要公告已發布並送進鄭凱文的通知匣');
} finally {
  await browser.close();
}
