import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finalCues, placeChapters } from '../assemble.ts';
import type { ChapterMeta } from '../meta.ts';
import { buildCues, LINE_MAX, narrationCues, splitNarration, textWidth, toSrt, toVtt } from '../subtitles.ts';

const N2 = '每一列寫是個人一份還是整組一份、現在的狀態、還剩幾天。學生端叫我的繳交，系辦端叫繳交項目；要不要統一，等你決定。';

test('切行：每則最多 2 行、每行 ≤ 18 個全形字，文字一個字都不少；優先斷在標點後', () => {
  const chunks = splitNarration(N2);
  assert.ok(chunks.length >= 2, '57 字要切成多則');
  for (const c of chunks) {
    assert.ok(c.length >= 1 && c.length <= 2, `一則 ${c.length} 行`);
    for (const l of c) assert.ok(textWidth(l) <= LINE_MAX, `「${l}」超過 ${LINE_MAX}`);
  }
  assert.equal(chunks.flat().join(''), N2);
  // 除了最後一行，每行都斷在標點（這句的子句都 ≤ 18 字）
  const lines = chunks.flat();
  for (const l of lines.slice(0, -1)) assert.match(l, /[，。、；：！？]$/, `「${l}」沒斷在標點`);
});

test('沒標點的長子句：切在詞與詞之間、平均分、左括號不留在行尾、標點不在行首', () => {
  assert.deepEqual(splitNarration('公告分類填「競賽資訊」才會出現在前台競賽頁並多出日期欄。').flat().length, 2);
  const lines = splitNarration('訪客看不到的會直接寫「訪客看不到這一筆」。').flat();
  assert.equal(lines.join(''), '訪客看不到的會直接寫「訪客看不到這一筆」。');
  for (const l of lines) {
    assert.ok(textWidth(l) >= 5, `「${l}」太短（孤字）`);
    assert.doesNotMatch(l, /[「『（]$/);
    assert.doesNotMatch(l, /^[，。、；：！？」』）]/);
  }
  assert.deepEqual(splitNarration('還沒設屆別時這裡會有「前往屆別設定」按鈕。').flat(), ['還沒設屆別時這裡會有', '「前往屆別設定」按鈕。']);
});

test('分則：盡量在句尾換下一則，不把一句拆在兩則之間', () => {
  assert.deepEqual(splitNarration('整組一份的作業，同組共用一份草稿，任何一位送出就代表全組。上面有截止、附件和組員。'), [
    ['整組一份的作業，同組共用一份草稿，', '任何一位送出就代表全組。'],
    ['上面有截止、附件和組員。'],
  ]);
  assert.deepEqual(splitNarration('林彥廷是 G07 組長。首頁下一步框已經指出最急的一件；側欄「我的繳交」列全部。'), [
    ['林彥廷是 G07 組長。', '首頁下一步框已經指出最急的一件；'],
    ['側欄「我的繳交」列全部。'],
  ]);
});

test('切行：短句一則一行；沒有標點的長字串硬切；半形字算半個', () => {
  assert.deepEqual(splitNarration('只看待繳'), [['只看待繳']]);
  const long = '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十';
  const chunks = splitNarration(long);
  const lens = chunks.flat().map((l) => [...l].length);
  assert.equal(chunks.flat().join(''), long);
  assert.equal(lens.length, 3);
  assert.ok(Math.max(...lens) <= 18 && Math.max(...lens) - Math.min(...lens) <= 3, `平均切：${lens}`);
  assert.equal(textWidth('G07 組長'), 1.5 + 0.5 + 2);
  assert.deepEqual(splitNarration('   '), []);
});

test('時間依字數分配：第一則從起播開始、最後一則剛好結束，遞增不重疊', () => {
  const cues = narrationCues(N2, 10_000, 22_000);
  assert.equal(cues[0].startMs, 10_000);
  assert.equal(cues.at(-1)!.endMs, 22_000);
  for (let i = 0; i < cues.length; i++) {
    assert.ok(cues[i].endMs > cues[i].startMs);
    if (i) assert.equal(cues[i].startMs, cues[i - 1].endMs);
  }
  // 字多的則分到比較長的時間
  const per = cues.map((c) => (c.endMs - c.startMs) / textWidth(c.lines.join('')));
  for (const p of per) assert.ok(Math.abs(p - per[0]) < 2, '每字時間大致相同');
});

test('SRT／VTT 格式：序號、時間碼、多句依時間排、前一則不蓋到下一則', () => {
  const cues = buildCues([
    { narration: '第二句。', startMs: 65_000, endMs: 3_725_123 },
    { narration: '第一句，比較短。', startMs: 1_234, endMs: 66_000 }, // 結束晚於下一句開始 → 截到下一句開始
    { narration: '', startMs: 0, endMs: 1000 },
  ]);
  const srt = toSrt(cues);
  assert.equal(srt, '1\n00:00:01,234 --> 00:01:05,000\n第一句，比較短。\n\n2\n00:01:05,000 --> 01:02:05,123\n第二句。\n');
  const vtt = toVtt(cues);
  assert.ok(vtt.startsWith('WEBVTT\n\n00:00:01.234 --> 00:01:05.000\n第一句，比較短。\n'));
  const times = [...srt.matchAll(/(\d\d):(\d\d):(\d\d),(\d{3}) --> (\d\d):(\d\d):(\d\d),(\d{3})/g)].map((m) => {
    const ms = (h: string, mi: string, s: string, f: string) => ((+h * 60 + +mi) * 60 + +s) * 1000 + +f;
    return [ms(m[1], m[2], m[3], m[4]), ms(m[5], m[6], m[7], m[8])];
  });
  for (let i = 0; i < times.length; i++) {
    assert.ok(times[i][1] > times[i][0]);
    if (i) assert.ok(times[i][0] >= times[i - 1][1]);
  }
});

test('整片字幕：章節位移＋這句實際起播，標題卡不出字幕，沒有配音全文的步驟略過', () => {
  const ch = (id: string, steps: ChapterMeta['steps']): ChapterMeta => ({ label: id, id, chapter: id, file: `${id}.mp4`, durationMs: 0, titleMs: 2500, steps });
  const placed = placeChapters(
    [
      ch('1-1', [{ index: 1, caption: 'a', startMs: 2500, narration: '打開首頁。', audio: { startMs: 2750, durationMs: 3000 } }]),
      ch('1-2', [
        { index: 1, caption: 'b', startMs: 2500 }, // 舊資料：沒有配音全文
        { index: 2, caption: 'c', startMs: 8000, narration: '看公告。', audio: { startMs: 8250, durationMs: 2000 } },
      ]),
    ],
    [10_000, 20_000],
  );
  const cues = finalCues(placed);
  assert.deepEqual(cues, [
    { startMs: 2750, endMs: 5750, lines: ['打開首頁。'] },
    { startMs: 18_250, endMs: 20_250, lines: ['看公告。'] },
  ]);
  // 標題卡（每章開頭 2.5 秒）沒有字幕
  for (const c of placed) for (const q of cues) assert.ok(!(q.startMs < c.offsetMs + c.titleMs && q.endMs > c.offsetMs));
});
