// 3-3 學生｜繳交作業（樣片）。先 reset.sh，再跑 setup.mjs，再跑這支：
//   INSTANCE=1 tools/tutorial/env/reset.sh && INSTANCE=1 node tools/tutorial/chapters/3-3/setup.mjs && INSTANCE=1 node tools/tutorial/chapters/3-3/record.ts
import path from 'node:path';
import { OUT_ROOT, loginAs, recordChapter } from './lib.ts';

const DEMO_PDF = path.join(OUT_ROOT, '3-3', '示範報告.pdf');

await recordChapter({ id: '3-3', chapter: '學生｜繳交作業' }, async (t, page) => {
  const main = page.getByRole('main');
  const row = (name: string) => main.getByRole('row', { name: new RegExp(name) });
  const backToList = () => main.getByRole('link', { name: '我的繳交', exact: true });
  const submit = () => main.getByRole('button', { name: '代表全組正式送出' });

  await t.offRecord(() => loginAs(page, '林彥廷', '/dashboard/student'));
  await t.waitStable();

  await t.step(
    {
      caption: '從首頁找到要交的作業',
      narration: '林彥廷是 G07 組長。首頁下一步框已經指出最急的一件；側欄「我的繳交」列全部。',
      status: { kind: 'ok', evidence: 'story-2 第 37 步' },
    },
    async () => {
      const region = page.getByRole('region', { name: '現在階段' });
      await t.hover(region.getByText('指導老師意願調查表'));
      await t.wait(600);
      await t.click(page.getByRole('link', { name: /^我的繳交/ }).first());
    },
  );

  await t.step(
    {
      caption: '四種繳交狀態',
      narration: '每一列寫是個人一份還是整組一份、現在的狀態、還剩幾天。學生端叫我的繳交，系辦端叫繳交項目；要不要統一，等你決定。',
      status: { kind: 'pending', say: '我的繳交／繳交項目要不要統一', evidence: '用詞#30＋UX N-06（系辦首頁「各繳交項目完成率」；專題事務篩選叫「文件繳交」）' },
    },
    async () => {
      await t.hover(row('指導老師意願調查表').getByText('草稿已存'));
      await t.hover(row('專題分組名單確認表').getByText('已繳第 1 次'));
      await t.hover(row('期中報告初稿').getByText('進行中'));
      await t.hover(row('專題說明會出席與分組意向登記').getByText('已繳第 2 次'));
    },
  );

  await t.step(
    { caption: '只看待繳', narration: '待繳分頁把沒送出的都列出來，已逾期的也算進去，提醒去找系辦補交。', status: { kind: 'ok', evidence: 'story-2 N-07（10/13 已修）' } },
    async () => {
      await t.click(main.getByRole('navigation', { name: '篩選' }).getByRole('link', { name: /^待繳/ }));
      await t.waitStable({ ready: main.getByRole('heading', { name: '待繳' }) });
    },
  );

  await t.step(
    {
      caption: '打開一份整組作業',
      narration: '整組一份的作業，同組共用一份草稿，任何一位送出就代表全組。上面有截止、附件和組員。',
      status: { kind: 'ok', evidence: 'story-2 第 39 步' },
    },
    async () => {
      await t.click(row('指導老師意願調查表').getByRole('link', { name: '繼續填寫' }));
      await t.hover(main.getByText('整組一份・同組共用一份草稿', { exact: false }).first());
      await t.scroll(main.getByText('作業說明', { exact: true }));
      await t.hover(main.getByText('指導老師 陳建宏'));
    },
  );

  await t.step(
    { caption: '填寫欄位', narration: '必填欄位有紅星；下拉、長文字、單選都是系辦在編輯器設定的。', status: { kind: 'ok', evidence: 'story-2 第 39 步' } },
    async () => {
      await t.select(main.getByLabel('第一志願'), '陳建宏');
      await t.select(main.getByLabel('第二志願'), '王雅玲');
      await t.select(main.getByLabel('第三志願'), '李孟儒');
      await t.type(main.getByLabel('題目方向'), '校園閒置空間共享媒合');
      await t.click(main.getByLabel('一般專題'));
    },
  );

  await t.step(
    { caption: '先存草稿', narration: '草稿存在伺服器，換裝置或組員打開都是同一份。老師看不到草稿。', status: { kind: 'ok', evidence: 'story-2 第 39 步' } },
    async () => {
      await t.click(main.getByRole('button', { name: '儲存草稿' }));
      await t.waitStable({ ready: '共用草稿已存到伺服器' });
      await t.hover(main.getByText('共用草稿已存到伺服器', { exact: false }));
    },
  );

  await t.step(
    {
      caption: '正式送出與回執',
      narration: '正式送出會跳回執：第幾次、誰送的、時間，還有有爭議才需要的證明編號。截止前可以重送，以最後一次為準。',
      status: { kind: 'pending', say: '「表單第 1 版」要不要改說法', evidence: '用詞#10：改「繳交欄位格式第 1 版」？' },
    },
    async () => {
      await t.click(submit());
      const dialog = page.getByRole('dialog');
      await t.waitStable({ ready: dialog.getByText('已正式送出') });
      await t.hover(dialog.getByText('林彥廷（代表 G07 全組）'));
      await t.hover(dialog.getByText('第 1 版'));
      await t.hover(dialog.getByText('繳交證明編號'));
    },
  );

  await t.step(
    { caption: '繳交歷史', narration: '每次送出都留在繳交歷史，最新那次標以此版為準；點查看看當時的內容。', status: { kind: 'ok', evidence: 'story-2 第 40 步' } },
    async () => {
      await t.click(page.getByRole('dialog').getByRole('button', { name: '關閉' }));
      await t.click(main.getByText(/^繳交歷史（1）$/));
      await t.waitStable({ ready: main.getByText('以此版為準') });
      await t.hover(main.getByText('以此版為準'));
      await t.click(main.getByRole('link', { name: '查看內容' }));
      await t.waitStable({ ready: main.getByText('唯讀・這是第 1 次送出當時的內容') });
    },
  );

  await t.step(
    { caption: '上傳檔案', narration: '需要交檔案的作業有上傳框，寫著允許的格式和大小；上傳完會附到草稿。', status: { kind: 'ok', evidence: 'story-2 第 39 步' } },
    async () => {
      await t.click(backToList());
      await t.click(row('期中報告初稿（示範）').getByRole('link', { name: '去繳交' }));
      await t.upload(main.locator('input[type=file]'), DEMO_PDF, { via: main.getByText('點擊選擇檔案上傳') });
      await t.waitStable({ ready: '已上傳並附到草稿' });
    },
  );

  await t.step(
    {
      caption: '必填沒填會被擋',
      narration: '必填沒填會被擋下來，寫清楚缺哪一欄。補上再送，回執多了附件和檔案核對碼。',
      status: { kind: 'pending', say: '「檔案核對碼」要不要加說明', evidence: '用詞#8：加「（有爭議時查看）」？' },
    },
    async () => {
      await t.click(submit());
      await t.waitStable({ ready: '還不能正式送出' });
      await t.hover(main.getByText('還不能正式送出', { exact: false }));
      await t.type(main.getByRole('textbox', { name: /^題目/ }), '校園閒置空間共享媒合平台');
      await t.click(submit());
      const dialog = page.getByRole('dialog');
      await t.waitStable({ ready: dialog.getByText('已正式送出') });
      await t.hover(dialog.getByText('示範報告.pdf'));
      await t.hover(dialog.getByText('檔案核對碼'));
    },
  );

  await t.step(
    { caption: '截止後唯讀', narration: '截止後整份變唯讀，欄位停用、沒有送出鈕；要補交請系辦單獨開放。', status: { kind: 'ok', evidence: 'story-2 第 42 步' } },
    async () => {
      await t.click(page.getByRole('dialog').getByText('回我的繳交', { exact: true }));
      await t.click(row('專題說明會出席與分組意向登記').getByRole('link', { name: '查看' }));
      await t.hover(main.getByText('截止後唯讀', { exact: false }).first());
      await t.hover(main.getByText(/^繳交歷史（2）$/));
      await t.scroll(main.getByText('已截止・唯讀', { exact: false }));
      await t.hover(main.getByText('已截止・唯讀', { exact: false }));
    },
  );

  await t.step(
    { caption: '截止前重送', narration: '已經交過、還沒截止的可以重送；歷史會變成已繳第 2 次，第 1 次保留。', status: { kind: 'ok', evidence: 'UX 組長 任務 3' } },
    async () => {
      await t.click(backToList());
      await t.click(row('專題分組名單確認表').getByRole('link', { name: '查看或重送' }));
      await t.click(main.getByRole('button', { name: '重新送出' }));
      const dialog = page.getByRole('dialog');
      await t.waitStable({ ready: dialog.getByText('第 2 次') });
      await t.hover(dialog.getByText('第 2 次'));
    },
  );
});
