// 3-5 學生｜站內同意書。本段會投下同意，重錄前要先 reset.sh。
//   INSTANCE=1 tools/tutorial/env/reset.sh && INSTANCE=1 node tools/tutorial/chapters/3-5/setup.mjs && INSTANCE=1 node tools/tutorial/chapters/3-5/record.ts
import { loginAs, recordChapter } from '../3-3/lib.ts';

await recordChapter({ id: '3-5', chapter: '學生｜站內同意書' }, async (t, page) => {
  const main = page.getByRole('main');
  const doc = main.getByRole('article', { name: /G07 最終文件授權 第 1 版/ });
  const reply = doc.getByRole('region', { name: '回覆' });
  const progress = doc.getByRole('region', { name: '進度' });

  await t.offRecord(() => loginAs(page, '鄭凱文', '/dashboard/student'));
  await t.waitStable();

  await t.step(
    { caption: '同意書在哪', narration: '系辦建了同意書，首頁和側欄徽章都會提醒輪到你。', status: { kind: 'ok', evidence: 'story-3 第 28 步' } },
    async () => {
      await t.hover(main.getByRole('link', { name: /^同意書 等你同意/ }));
      await t.click(page.getByRole('navigation', { name: '後台導覽' }).getByRole('link', { name: '站內同意書' }));
    },
  );

  await t.step(
    {
      caption: '同意書全文與檢查碼',
      narration: '全文鎖定在這一版，內容一改檢查碼就不同，用來確認每個人同意的是同一份。',
      status: { kind: 'pending', say: '「文件一致性檢查碼」要不要改名', evidence: '用詞#7（改「文件核對碼（有爭議時查看）」？）' },
    },
    async () => {
      await t.hover(doc.getByRole('heading', { name: 'G07・最終文件授權・同意書第 1 版' }));
      await t.hover(doc.getByText('收集學生同意中', { exact: true }));
      await t.hover(doc.getByRole('region', { name: '全文' }).getByText('文件一致性檢查碼', { exact: false }));
    },
  );

  await t.step(
    { caption: '授權範圍', narration: '最終文件授權會列出同意後可以公開展示的內容：題目、摘要、海報、影片。', status: { kind: 'ok', evidence: 'story-3 第 28 步' } },
    async () => {
      const scope = doc.getByRole('region', { name: '授權範圍' });
      await t.scroll(scope);
      await t.hover(scope.getByText('題目', { exact: true }));
      await t.hover(scope.getByText('影片連結', { exact: true }));
    },
  );

  await t.step(
    {
      caption: '誰同意了、誰還沒',
      narration: '進度列每個人同意的時間；全部學生同意後才輪到指導老師，任何人都不能替別人按。',
      status: { kind: 'ok', evidence: 'story-3 第 29、30 步' },
    },
    async () => {
      await t.scroll(doc.getByRole('heading', { name: '進度' }));
      await t.hover(progress.getByText('學生 3／5 已同意'));
      await t.hover(progress.getByText(/^還沒回覆：/));
      await t.hover(progress.getByRole('listitem').filter({ hasText: '陳建宏（指導老師）' }));
    },
  );

  await t.step(
    {
      caption: '不同意或晚點再說',
      narration: '不同意要填理由，全組會重新同意。只是想晚點回覆就先不按，不用退回。',
      status: { kind: 'ok', evidence: 'Q39（10/12 已補說明；story-3 N-56 已解）' },
    },
    async () => {
      await t.scroll(reply);
      await t.hover(reply.getByRole('button', { name: '不同意並退回修正' }));
      await t.hover(reply.getByText('想先確認再回覆的話', { exact: false }));
    },
  );

  await t.step(
    { caption: '同意', narration: '勾了已閱讀才能按同意，再確認一次。每人一票、投了不能改，紀錄時間和登入方式。', status: { kind: 'ok', evidence: 'story-3 第 28 步' } },
    async () => {
      await t.click(reply.getByRole('checkbox', { name: '我已完整閱讀這一版的全文、附件與授權範圍' }));
      await t.click(reply.getByRole('button', { name: '我已閱讀並同意' }));
      const dialog = page.getByRole('dialog');
      await t.waitStable({ ready: dialog.getByText('確認同意？') });
      await t.click(dialog.getByRole('button', { name: '我已閱讀並同意' }));
      await t.waitStable({ ready: main.getByText(/^你已同意（/) });
      await t.hover(main.getByText(/^你已同意（/));
    },
  );
});
