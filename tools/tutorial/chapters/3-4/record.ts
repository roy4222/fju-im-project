// 3-4 學生｜登入後前台：歷屆專題、產學合作、檔案下載。
//   INSTANCE=1 tools/tutorial/env/reset.sh && INSTANCE=1 node tools/tutorial/chapters/3-4/setup.mjs && INSTANCE=1 node tools/tutorial/chapters/3-4/record.ts
import { loginAs, recordChapter } from '../3-3/lib.ts';

await recordChapter({ id: '3-4', chapter: '學生｜登入後前台：歷屆專題、產學合作、檔案下載' }, async (t, page) => {
  const main = page.getByRole('main');
  const top = page.getByRole('navigation', { name: '主導覽' });

  await t.offRecord(() => loginAs(page, '林彥廷', '/dashboard/student'));
  await t.waitStable();

  await t.step(
    {
      caption: '登入後的首頁',
      narration: '登入後首頁多一列我的工作：待繳幾件、近期截止。右上角變成「我的後台」。',
      status: { kind: 'pending', say: '我的後台／首頁要不要統一叫法', evidence: '用詞#29（我的後台／首頁／我的專題 統一「我的首頁」？）；UX N-08 已修' },
    },
    async () => {
      await t.click(page.getByRole('link', { name: '回到前台' }));
      await t.scroll(main.getByRole('region', { name: '我的工作' }));
      await t.hover(main.getByRole('link', { name: /^待繳交 \d+ 件/ }));
      await t.hover(main.getByRole('heading', { name: '近期截止' }));
      await t.hover(page.getByRole('banner').getByRole('link', { name: '我的後台' }));
    },
  );

  await t.step(
    {
      caption: '歷屆專題一覽',
      narration: '登入後才有歷屆專題一覽：全部公開作品，可以依屆別篩、只看得獎、搜題目老師。',
      status: { kind: 'ok', evidence: 'story-4 第 7 步（空狀態）；seed-demo 有 8 件' },
    },
    async () => {
      await t.hover(top.getByRole('link', { name: '歷屆專題', exact: true }));
      await t.click(page.getByRole('banner').getByRole('link', { name: '歷屆專題一覽', exact: true }));
      await t.click(main.getByRole('navigation', { name: '屆別篩選' }).getByRole('link', { name: '只看得獎' }));
      await t.waitStable();
      await t.hover(main.getByRole('searchbox', { name: '搜尋題目、組別、指導老師' }));
    },
  );

  await t.step(
    {
      caption: '作品詳情（登入）',
      narration: '登入後詳情多組別、老師、組員；影片是系上 YouTube 不公開連結，另開新視窗。',
      status: { kind: 'ok', evidence: '既有保證（SHW-04）' },
    },
    async () => {
      await t.click(main.getByRole('link', { name: /備援：中小企業備份稽核工具/ }).first());
      const side = main.getByRole('complementary');
      await t.hover(side.getByText('組別', { exact: true }));
      await t.hover(side.getByText('指導老師', { exact: true }));
      await t.hover(side.getByText('組員', { exact: true }));
      await t.hover(main.getByRole('link', { name: '播放三分鐘影片（另開新視窗）' }));
    },
  );

  await t.step(
    {
      caption: '產學合作列表',
      narration: '產學合作列老師發布的合作案，卡片寫公司、部門、負責老師、已有幾組。但沒說還收不收新組。',
      status: { kind: 'pending', say: '合作案要不要標「還收不收新組」', evidence: 'UX N-09' },
    },
    async () => {
      await t.click(top.getByRole('link', { name: '產學合作' }));
      await t.click(main.getByRole('navigation', { name: '連結狀態' }).getByRole('link', { name: '已有組別' }));
      await t.waitStable();
      await t.hover(main.getByRole('link', { name: /^昱鋼精機工業/ }).getByText('已有 1 組'));
    },
  );

  await t.step(
    {
      caption: '合作案詳情',
      narration: '學生看得到合作內容和條件；地址、聯絡人、電話只有負責老師和系辦看得到，學生畫面根本沒有那一區。',
      status: { kind: 'ok', evidence: 'story-2 第 5 步' },
    },
    async () => {
      await t.click(main.getByRole('link', { name: /^昱鋼精機工業/ }));
      await t.hover(main.getByRole('heading', { name: '專題／合作內容' }));
      await t.hover(main.getByRole('heading', { name: '對學生的條件／需求' }));
      await t.hover(main.getByRole('region', { name: '連結的組別' }));
    },
  );

  await t.step(
    {
      caption: '檔案下載',
      narration: '檔案下載依分類列範本和說明，每次下載都重新確認你拿得到這個檔。',
      status: { kind: 'ok', evidence: 'story-4 第 27 步' },
    },
    async () => {
      await t.click(top.getByRole('link', { name: '檔案下載' }));
      await t.click(main.getByRole('navigation', { name: '檔案分類' }).getByRole('link', { name: '範本與格式' }));
      await t.waitStable();
      const item = main.getByRole('listitem').filter({ has: page.getByRole('heading', { name: '專案計畫書範本 2026' }) });
      // 下載不換頁：不等穩定（不然會一直等換頁）。
      await t.click(item.getByRole('link', { name: /^下載/ }), false);
      await t.wait(800);
    },
  );

  await t.step(
    {
      caption: '後台裡的產學合作',
      narration: '學生後台也有產學合作，列同一批合作案，點了回前台詳情；產學組組長在我的組別連結。',
      status: { kind: 'ok', evidence: 'story-1 第 34 步' },
    },
    async () => {
      await t.click(page.getByRole('banner').getByRole('link', { name: '我的後台' }));
      await t.click(page.getByRole('navigation', { name: '後台導覽' }).getByRole('link', { name: '產學合作' }));
      await t.hover(main.getByRole('list', { name: '合作案' }).getByRole('listitem').first());
      await t.hover(main.getByRole('link', { name: '前台列表' }));
    },
  );
});
