// 3-3 段首準備（不進影片）：以系辦身分在自己的實例用編輯器發一個有「檔案上傳」欄位的文件繳交，並產生示範 PDF。
//   INSTANCE=1 tools/tutorial/env/reset.sh && INSTANCE=1 node tools/tutorial/chapters/3-3/setup.mjs
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { BASE_URL, OUT_ROOT, loginAs } from './lib.ts';

export const DEMO_TITLE = '期中報告初稿（示範）';
export const DEMO_PDF = path.join(OUT_ROOT, '3-3', '示範報告.pdf');

/** 臺灣時間 n 天後 23:59，datetime-local 的格式。 */
function taipeiDaysLater(n) {
  const d = new Date(Date.now() + n * 86_400_000 + 8 * 3_600_000);
  return `${d.toISOString().slice(0, 10)}T23:59`;
}

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
  const page = await ctx.newPage();

  // 示範 PDF：內容只寫「示範檔案」。
  fs.mkdirSync(path.dirname(DEMO_PDF), { recursive: true });
  await page.setContent('<p style="font:48px sans-serif;margin:80px">示範檔案</p>');
  await page.pdf({ path: DEMO_PDF, format: 'A4' });

  await loginAs(page, '系辦管理員', '/dashboard/admin/affairs');
  if (await page.getByText(DEMO_TITLE).count()) {
    console.log(`「${DEMO_TITLE}」已經存在，略過（要重來請先 reset.sh）`);
  } else {
    await page.goto(`${BASE_URL}/dashboard/admin/editor/new`, { waitUntil: 'networkidle' });
    await page.locator('#ed-title').fill(DEMO_TITLE);
    await page.locator('#ed-body').fill('請上傳期中報告初稿 PDF（20 MB 以內），並填寫題目。整組一份，任一組員送出即代表全組。');
    await page.locator('#ed-summary').fill('上傳期中報告初稿 PDF，整組一份。');
    await page.locator('#ed-placement').selectOption({ label: '文件繳交' });
    await page.locator('#ed-audience').selectOption({ label: '本屆學生' });
    await page.getByLabel('整組一份').check();
    const stage = page.locator('#ed-stage');
    const stage1 = await stage.locator('option', { hasText: '第 1 階段' }).first().textContent();
    await stage.selectOption({ label: stage1.trim() });
    await page.locator('#ed-due').fill(taipeiDaysLater(14));

    // 欄位：新增後設定區會展開在剛加的那一欄。
    const addField = async (type, label) => {
      await page.locator('#add-field-type').selectOption({ label: type });
      await page.getByRole('button', { name: '新增欄位' }).click();
      const last = page.locator('li[data-field-type]').last();
      const toggle = last.locator('button[aria-expanded]').first();
      if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
      await last.locator('input[id^="field-label-"]').fill(label);
      const required = last.getByLabel('必填', { exact: true });
      if (!(await required.isChecked())) await required.check();
      await last.getByRole('button', { name: '完成' }).click();
    };
    await addField('短文字', '題目');
    await addField('檔案上傳', '報告 PDF');

    await page.getByRole('button', { name: '發布', exact: true }).first().click();
    await page.getByRole('button', { name: '確認發布' }).click();
    await page.getByText('回列表', { exact: true }).waitFor();
    await page.waitForLoadState('networkidle');
  }

  // 確認林彥廷看得到。
  await loginAs(page, '林彥廷', '/dashboard/student/affairs');
  if (!(await page.getByText(DEMO_TITLE).count())) throw new Error(`林彥廷的「我的繳交」看不到「${DEMO_TITLE}」`);
  console.log(`完成：${DEMO_TITLE} 已發布；示範 PDF 在 ${DEMO_PDF}`);
} finally {
  await browser.close();
}
