// 0 開場：不操作網站。以訪客打開首頁當背景，蓋上三張卡（標題、圖例、示範資料）。
//   INSTANCE=1 tools/tutorial/env/reset.sh && INSTANCE=1 node tools/tutorial/chapters/0/record.ts
import type { Page } from 'playwright';
import { recordChapter } from '../3-3/lib.ts';

/** 卡上的一行字。網站的 CSP 擋 style 屬性與 <style>，所以只用 CSSOM（element.style）排版。 */
type Line = { text: string; size: number; weight?: number; color?: string; spacing?: string };

/** 蓋在網頁上的一張全版卡；換卡時整張換掉。 */
async function showCard(page: Page, lines: Line[]): Promise<void> {
  await page.evaluate((rows) => {
    document.getElementById('tut-card')?.remove();
    const card = document.createElement('div');
    card.id = 'tut-card';
    Object.assign(card.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '2147483647',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '22px',
      background: 'rgba(255,255,255,0.97)',
      fontFamily: '"PingFang TC","Noto Sans TC",sans-serif',
      color: '#1f2937',
      textAlign: 'center',
    });
    for (const r of rows) {
      const line = document.createElement('div');
      line.textContent = r.text;
      Object.assign(line.style, {
        fontSize: `${r.size}px`,
        fontWeight: String(r.weight ?? 500),
        color: r.color ?? '#1f2937',
        letterSpacing: r.spacing ?? 'normal',
      });
      card.appendChild(line);
    }
    document.body.appendChild(card);
  }, lines);
}

const GRAY = '#4b5563';
const ORANGE = '#E56E00';

const TITLE: Line[] = [
  { text: 'FJU 專題平台', size: 20, weight: 700, color: ORANGE, spacing: '0.2em' },
  { text: '輔大資管系專題平台 完整教學', size: 52, weight: 800 },
  { text: '訪客 → 註冊登入 → 學生 → 老師 → 系辦', size: 22, color: GRAY },
];

const LEGEND: Line[] = [
  { text: '四種狀態標記', size: 40, weight: 800 },
  { text: '✅ 正常', size: 30 },
  { text: '⚠️ 能用但卡', size: 30 },
  { text: '❌ 壞或缺', size: 30 },
  { text: '🟡 等 Roy 決定', size: 30 },
  { text: '出現在每一步畫面的右上角', size: 20, color: GRAY },
];

const DEMO: Line[] = [
  { text: '用的是示範資料', size: 40, weight: 800 },
  { text: '示範 114 屆・九個組別・四位老師', size: 30 },
  { text: '姓名、公司、學號都是虛構的；日期對齊錄影當天', size: 20, color: GRAY },
];

await recordChapter({ id: '0', chapter: '開場｜完整教學', subtitle: '這部影片怎麼看' }, async (t, page) => {
  await page.context().clearCookies();
  await t.goto('/'); // goto 本身不進影片
  await t.offRecord(() => showCard(page, TITLE));
  await t.waitStable();

  await t.step(
    {
      caption: '這部影片要講什麼',
      // 原稿列了「訪客、註冊登入、學生、老師、系辦」，這一步超過 15 秒；標題卡上已經寫了，配音拿掉那一串。
      narration: '這部影片依角色帶你走一遍專題平台的每個功能。每個功能都會標一個狀態，看完就能決定哪些要保留、要改、要砍。',
    },
    async () => {
      await t.wait(500);
    },
  );

  await t.offRecord(() => showCard(page, LEGEND));
  await t.step(
    {
      caption: '四種狀態標記',
      narration: '綠色勾是正常、黃色三角是能用但卡、紅叉是壞或缺、黃圈是等 Roy 決定。右上角出現黃圈時，配音會說清楚等你決定什麼。',
    },
    async () => {
      await t.wait(500);
    },
  );

  await t.offRecord(() => showCard(page, DEMO));
  await t.step(
    { caption: '用的是示範資料', narration: '影片用本機的示範資料錄，姓名、公司、學號都是虛構的，日期會對齊錄影當天。' },
    async () => {
      await t.wait(500);
    },
  );
});
