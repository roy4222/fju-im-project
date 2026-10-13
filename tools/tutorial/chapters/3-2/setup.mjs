// 3-2 段首準備（不進影片）：乾淨 seed-demo 已有應宥丞發起、2／4 已確認的提案（鞠柏宇、冷佳霓待確認，鞠柏宇未公開找組員），
// 不用補資料；這裡只檢查狀態對不對。本段會讓 G10 成立並改成產學組，重錄前一定要先 reset.sh。
//   INSTANCE=1 tools/tutorial/env/reset.sh && INSTANCE=1 node tools/tutorial/chapters/3-2/setup.mjs
import { chromium } from 'playwright';
import { loginAs } from '../3-3/lib.ts';

const browser = await chromium.launch();
try {
  const page = await (await browser.newContext({ locale: 'zh-TW', timezoneId: 'Asia/Taipei' })).newPage();
  const main = page.getByRole('main');
  await loginAs(page, '應宥丞', '/dashboard/student/groups');
  if (!(await main.getByText('2／4 已確認', { exact: false }).count())) throw new Error('應宥丞的提案不是 2／4 已確認：請先 reset.sh');
  await loginAs(page, '鞠柏宇', '/dashboard/student/groups');
  if (!(await main.getByRole('button', { name: '公開找組員' }).count())) throw new Error('鞠柏宇已經公開找組員：請先 reset.sh');
  if (!(await main.getByRole('button', { name: '確認加入' }).count())) throw new Error('鞠柏宇沒有「確認加入」：請先 reset.sh');
  await loginAs(page, '冷佳霓', '/dashboard/student/groups');
  if (!(await main.getByRole('button', { name: '確認加入' }).count())) throw new Error('冷佳霓沒有「確認加入」：請先 reset.sh');
  console.log('完成：提案 2／4 已確認，鞠柏宇、冷佳霓待確認，鞠柏宇未公開找組員');
} finally {
  await browser.close();
}
