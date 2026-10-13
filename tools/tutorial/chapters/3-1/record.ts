// 3-1 學生｜學生首頁、時間軸、通知。
//   INSTANCE=1 tools/tutorial/env/reset.sh && INSTANCE=1 node tools/tutorial/chapters/3-1/setup.mjs && INSTANCE=1 node tools/tutorial/chapters/3-1/record.ts
import { loginAs, recordChapter } from '../3-3/lib.ts';

await recordChapter({ id: '3-1', chapter: '學生｜學生首頁、時間軸、通知' }, async (t, page) => {
  const main = page.getByRole('main');
  const nav = page.getByRole('navigation', { name: '後台導覽' });

  await t.offRecord(() => loginAs(page, '鄭凱文', '/dashboard/student'));
  await t.waitStable({ offRecord: true });

  await t.step(
    {
      caption: '學生首頁一眼看什麼',
      narration: '首頁第一行寫現在是哪個階段、到哪天；下面直接說還有幾件沒交、幾件已逾期。',
      status: { kind: 'ok', evidence: 'story-2 N-07／UX N-08（10/13 已修：逾期算進待繳）' },
    },
    async () => {
      await t.hover(main.getByRole('heading', { name: '歡迎回來，鄭凱文' }));
      await t.hover(main.getByText('現在是「階段 1：分組與指導老師」', { exact: false }));
    },
  );

  await t.step(
    {
      caption: '本屆階段與下一步',
      narration: '四個階段排成一列，現在的那格亮橘色；「下一步」框直接帶去最急的那件。',
      status: { kind: 'ok', evidence: 'UX N-07（10/13 已修：1280 寬不再碎行）' },
    },
    async () => {
      const stages = main.getByRole('list', { name: '本屆階段' });
      await t.hover(stages.getByText('1. 分組與指導老師'));
      await t.hover(stages.getByText('4. 專題發表與成品'));
      await t.hover(main.getByRole('region', { name: '現在階段' }).getByRole('link', { name: '繼續填寫' }));
    },
  );

  await t.step(
    { caption: '行事曆', narration: '行事曆標截止和活動，點日期看那天有什麼。全站用臺灣時間。', status: { kind: 'ok', evidence: 'story-1 第 32 步' } },
    async () => {
      // 說明會日期跟著 seed 平移，從「接下來」那一列讀出 MM-DD 再點行事曆上那一天。
      const line = (await main.getByText(/專題說明會\s*活動・\d\d-\d\d/).first().textContent()) ?? '';
      const [, mm, dd] = line.match(/活動・(\d\d)-(\d\d)/) ?? [];
      const year = (await main.getByText(/\d{4} 年 \d+ 月/).first().textContent())?.match(/\d{4}/)?.[0];
      await t.scroll(main.getByRole('heading', { name: '專題行事曆' }));
      await t.click(main.getByRole('button', { name: new RegExp(`^${year}-${mm}-${dd}`) }));
      await t.waitStable({ ready: main.getByText('專題說明會', { exact: false }).first() });
    },
  );

  await t.step(
    { caption: '接下來', narration: '「接下來」把截止和活動依本週、之後排好，點了進對應頁。', status: { kind: 'ok', evidence: 'story-1 第 32 步' } },
    async () => {
      await t.scroll(main.getByRole('heading', { name: '接下來' }));
      await t.hover(main.getByText('本週', { exact: true }));
      await t.hover(main.getByText('之後', { exact: true }));
      await t.hover(main.getByRole('link', { name: /指導老師意願調查表 截止/ }));
    },
  );

  await t.step(
    {
      caption: '專題時間軸',
      narration: '時間軸列四個階段和日期，進行中的卡有「現在」書籤；展開看這階段要交的作業。',
      status: { kind: 'ok', evidence: 'story-1 第 33 步；「分組期」旁已加白話（Q40）' },
    },
    async () => {
      await t.click(nav.getByRole('link', { name: '專題時間軸' }));
      const stages = main.getByRole('list', { name: '本屆階段' });
      // 進行中的階段卡預設就是展開的（點了反而收起），所以只指給觀眾看。
      await t.hover(stages.getByRole('button', { name: /進行中/ }));
      await t.hover(stages.getByRole('link', { name: '指導老師意願調查表' }));
    },
  );

  await t.step(
    {
      caption: '通知匣',
      narration: '公告、截止、分組、同意書有變化都會進通知匣；可以逐則或全部標已讀，上面可依屆別篩。',
      status: { kind: 'pending', say: '說明文字「事件」要不要改「相關消息」', evidence: '用詞#11' },
    },
    async () => {
      await t.click(nav.getByRole('link', { name: '通知' }));
      await t.click(main.getByRole('button', { name: /^把「分組名單確認表截止提醒」標為已讀/ }));
      await t.click(main.getByRole('button', { name: '全部標為已讀' }));
      await t.hover(main.getByRole('navigation', { name: '依屆別篩選' }));
    },
  );

  await t.step(
    {
      caption: '學生看不到成績',
      narration: '側欄沒有成績入口；就算打網址進來，也只會看到一句話：分數只在老師和系辦後台，有問題問系辦。',
      status: { kind: 'ok', evidence: 'story-3 第 13～14 步' },
    },
    async () => {
      await t.goto('/dashboard/student/grading');
      await t.hover(main.getByRole('heading', { name: '學生看不到成績' }));
      await t.hover(main.getByRole('heading', { name: '評分由老師與系辦處理，學生不會看到分數' }));
    },
  );
});
