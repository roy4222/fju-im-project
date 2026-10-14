// 3-2 學生｜我的組別：找組員、提案、確認成立。本段會改資料，重錄前要先 reset.sh。
//   INSTANCE=1 tools/tutorial/env/reset.sh && INSTANCE=1 node tools/tutorial/chapters/3-2/setup.mjs && INSTANCE=1 node tools/tutorial/chapters/3-2/record.ts
import { loginAs, recordChapter } from '../3-3/lib.ts';

const GROUPS = '/dashboard/student/groups';
/** 3-2-11 要連結的合作案（下拉選項全文）。 */
const CASE = '維禾生醫科技・數位轉型專案辦公室（張士豪 老師）';

await recordChapter({ id: '3-2', chapter: '學生｜我的組別：找組員、提案、確認成立' }, async (t, page) => {
  const main = page.getByRole('main');
  const nav = page.getByRole('navigation', { name: '後台導覽' });
  const status = main.getByRole('region', { name: '我的組別狀態' });
  const typeAndCase = main.getByRole('region', { name: '組別類型與合作案' });
  const switchTo = async (name: string, home: string) => {
    await t.offRecord(() => loginAs(page, name, home));
    await t.waitStable();
  };

  await switchTo('應宥丞', '/dashboard/student');

  await t.step(
    {
      caption: '提案人看提案進度',
      narration: '應宥丞是提案人。首頁就看到組員確認到幾個人，點進我的組別看細節。',
      status: { kind: 'ok', evidence: 'story-2 第 6 步' },
    },
    async () => {
      await t.hover(main.getByRole('link', { name: /^組員確認 2\/4/ }));
      await t.click(nav.getByRole('link', { name: '我的組別' }));
    },
  );

  await t.step(
    {
      caption: '組隊中的狀態',
      narration: '每個人用自己的帳號按確認，全員確認那一刻組別才成立。到期沒確認完就不成立，大家都能重新組隊。提案人可以撤回。',
      status: { kind: 'ok', evidence: 'story-2 第 6～8 步' },
    },
    async () => {
      await t.hover(status.getByRole('heading', { name: '組隊中（等全員確認）' }));
      const members = status.getByRole('list', { name: '提案成員' });
      await t.hover(members.getByRole('listitem').filter({ hasText: '鞠柏宇' }));
      await t.hover(members.getByRole('listitem').filter({ hasText: '解雨萱' }));
      await t.hover(status.getByRole('button', { name: '撤回提案' }));
    },
  );

  await t.step(
    {
      caption: '找組員名單',
      narration: '找組員只列同屆、沒分組、本人開啟公開的同學，顯示姓名學號和 Email，電話不公開。',
      status: { kind: 'ok', evidence: 'story-2 第 6 步' },
    },
    async () => {
      await t.scroll(main.getByRole('heading', { name: '找組員' }));
      await t.hover(main.getByRole('region', { name: '找組員名單' }).getByRole('listitem').first());
    },
  );

  await t.step(
    { caption: '提案紀錄', narration: '成立或沒成立的提案都留在提案紀錄。', status: { kind: 'ok', evidence: '既有保證' } },
    async () => {
      await t.scroll(main.getByRole('heading', { name: '提案紀錄' }));
      await t.hover(main.getByRole('region', { name: '提案紀錄' }).getByText('還沒有結束的提案。'));
    },
  );

  await switchTo('鞠柏宇', GROUPS);

  await t.step(
    {
      caption: '開啟公開找組員',
      narration: '換鞠柏宇。他本來沒公開，按一下就出現在名單上；再按「關閉公開」就消失。',
      status: { kind: 'ok', evidence: 'story-2 第 6 步' },
    },
    async () => {
      await t.scroll(main.getByRole('heading', { name: '找組員' }));
      await t.hover(main.getByText('未公開', { exact: true }));
      await t.click(main.getByRole('button', { name: '公開找組員' }));
      await t.waitStable({ ready: main.getByText('已公開找組員：', { exact: false }) });
      await t.hover(main.getByRole('button', { name: '關閉公開' }));
    },
  );

  await t.step(
    {
      caption: '被邀請的人可以拒絕',
      narration: '被邀請的人有確認加入和拒絕。拒絕會讓這次組隊不成立，所以先看看說明、不真的拒絕。',
      status: { kind: 'ok', evidence: 'story-2 第 7 步' },
    },
    async () => {
      await t.click(status.getByRole('button', { name: '拒絕' }));
      const dialog = page.getByRole('dialog');
      await t.waitStable({ ready: dialog.getByText('拒絕這份提案？') });
      await t.hover(dialog.getByText('拒絕後這次組隊就不會成立', { exact: false }));
      // 對話框多停一下，配音講完「不真的拒絕」再按「先不要」。
      await t.wait(3500);
      await t.click(dialog.getByRole('button', { name: '先不要' }));
    },
  );

  await t.step(
    { caption: '確認加入', narration: '按確認加入，變成三比四，再等最後一位。', status: { kind: 'ok', evidence: 'story-2 第 8 步' } },
    async () => {
      await t.click(status.getByRole('button', { name: '確認加入' }));
      await t.waitStable({ ready: main.getByText('已確認（3／4 已確認），等其他人確認。') });
      await t.hover(main.getByText('已確認（3／4 已確認），等其他人確認。'));
    },
  );

  await switchTo('冷佳霓', GROUPS);

  await t.step(
    {
      caption: '最後一位確認，組別成立',
      narration: '換冷佳霓按確認。全員到齊，組別當場成立，四個人和提案人都會收到通知。',
      status: { kind: 'ok', evidence: 'story-2 第 8 步' },
    },
    async () => {
      await t.click(status.getByRole('button', { name: '確認加入' }));
      await t.waitStable({ ready: main.getByText(/全員確認，組別 G\d+ 成立了。/) });
      await t.hover(main.getByText(/全員確認，組別 G\d+ 成立了。/));
    },
  );

  await t.step(
    {
      caption: '成立後的組別頁',
      narration: '成立後看得到組長、組員和指導老師。一般組等系辦抽籤指派；成員異動、換組長也由系辦處理。',
      status: { kind: 'ok', evidence: 'story-2 第 8 步' },
    },
    async () => {
      await t.hover(status.getByRole('heading', { name: /^組別 G\d+$/ }));
      await t.hover(status.getByRole('list', { name: '組員' }).getByRole('listitem').filter({ hasText: '應宥丞' }));
      await t.hover(status.getByText('指導老師 尚未指派（一般組由系辦依抽籤結果指派）'));
    },
  );

  await switchTo('應宥丞', GROUPS);

  await t.step(
    {
      caption: '組長改組別類型',
      narration: '換組長。分組期內、還沒指導老師、沒連合作案時，組長可以自己把類型改成產學合作。',
      status: { kind: 'ok', evidence: '規格 03 組長定案（10/12 驗收未單獨走）' },
    },
    async () => {
      await t.scroll(typeAndCase);
      await t.click(typeAndCase.getByRole('button', { name: '改成產學合作' }));
      await t.waitStable({ ready: typeAndCase.getByText(/已從「一般專題」改成「產學合作」/) });
      await t.hover(typeAndCase.getByText(/已從「一般專題」改成「產學合作」/));
    },
  );

  await t.step(
    {
      caption: '組長連結合作案',
      narration: '產學組的組長在這裡把組別連到老師發布的合作案。連結只代表選用題目，不代表企業或老師已承諾，也不會自動變成指導老師。',
      status: { kind: 'ok', evidence: 'story-2 第 10 步' },
    },
    async () => {
      await t.select(typeAndCase.getByRole('combobox', { name: '選一個已發布的合作案' }), CASE);
      await t.click(typeAndCase.getByRole('button', { name: /^把 G\d+ 連結到這個合作案$/ }));
      await t.waitStable({ ready: typeAndCase.getByText(/已連結「維禾生醫科技/) });
      await t.hover(typeAndCase.getByText(/已連結「維禾生醫科技/));
    },
  );
});
