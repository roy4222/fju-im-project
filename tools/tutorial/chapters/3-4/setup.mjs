// 3-4 段首準備（不進影片）：乾淨 seed-demo 就夠，不用補資料；這裡只檢查本段要點的東西都在。
//   INSTANCE=1 tools/tutorial/env/reset.sh && INSTANCE=1 node tools/tutorial/chapters/3-4/setup.mjs
import { chromium } from 'playwright';
import { BASE_URL, loginAs } from '../3-3/lib.ts';

const browser = await chromium.launch();
try {
  const page = await (await browser.newContext({ locale: 'zh-TW', timezoneId: 'Asia/Taipei' })).newPage();
  const main = page.getByRole('main');
  await loginAs(page, '林彥廷', '/');
  const need = async (url, text) => {
    await page.goto(`${BASE_URL}${url}`, { waitUntil: 'networkidle' });
    if (!(await main.getByText(text, { exact: false }).count())) throw new Error(`${url} 找不到「${text}」：請先 reset.sh`);
  };
  await need('/', '我的工作');
  await need('/projects?award=1', '備援：中小企業備份稽核工具');
  await need('/industry', '昱鋼精機工業');
  await need('/files', '專案計畫書範本 2026');
  console.log('完成：我的工作、得獎作品、合作案、檔案範本都在');
} finally {
  await browser.close();
}
