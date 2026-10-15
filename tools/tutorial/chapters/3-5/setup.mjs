// 3-5 段首準備（不進影片）：乾淨 seed-demo 就有 G07「專題成果授權同意書」第 1 版（3／5 已同意，鄭凱文未回覆），
// 不用補資料；這裡只檢查狀態。本段鄭凱文會投下同意，重錄前一定要先 reset.sh。
//   INSTANCE=1 tools/tutorial/env/reset.sh && INSTANCE=1 node tools/tutorial/chapters/3-5/setup.mjs
import { chromium } from 'playwright';
import { loginAs } from '../3-3/lib.ts';

const browser = await chromium.launch();
try {
  const page = await (await browser.newContext({ locale: 'zh-TW', timezoneId: 'Asia/Taipei' })).newPage();
  const main = page.getByRole('main');
  await loginAs(page, '鄭凱文', '/dashboard/student/signoff');
  if (!(await main.getByText('學生 3／5 已同意').count())) throw new Error('G07 同意書不是 3／5 已同意：請先 reset.sh');
  if (!(await main.getByRole('button', { name: '不同意並退回修正' }).count())) throw new Error('鄭凱文已經回覆過：請先 reset.sh');
  console.log('完成：G07 同意書 3／5 已同意，鄭凱文尚未回覆');
} finally {
  await browser.close();
}
