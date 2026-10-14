// 條碼錄影的共用部分：recorder.test.ts 直接用；兩路並行測試把它當獨立程序跑
//   node engine/test/barcode-recording.ts <root> <slotsDir> <label>   → 印出 JSON（Raw）

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { CAPTION_HEIGHT, CHROME_HEIGHT, launchTutorialBrowser, newTutorialPage, startChapter } from '../recorder.ts';
import { silentProvider } from '../tts.ts';
import type { ChapterEvents } from '../events.ts';
import { timeFrames, type Pause, type RawFrame } from '../frames.ts';
import { CAPTURE_OPTS } from './env.ts';
import { checkClick, checkFrames, type ClickCheck, type FrameCheck } from './checks.ts';

const BITS = 20;
const BLOCK = 40;
/** 頁面放大 1.5 倍錄影：CSS px × ZOOM ＝ 影片像素。 */
export const ZOOM = 1.5;
const B = BLOCK * ZOOM;
export const W = 1920;
/** 頁面區高度：1080 − 網址列 − 字幕帶 ＝ 880。 */
export const H = 1080 - CHROME_HEIGHT - CAPTION_HEIGHT;

const PAGE = `<!doctype html><body style="margin:0;background:#fff">
<canvas id=c width=${BITS * BLOCK} height=${BLOCK} style="position:fixed;left:0;top:0"></canvas>
<button id=b style="position:fixed;left:900px;top:400px;width:300px;height:120px;background:#fff;border:0"
  onclick="this.style.background='#000'">按我</button>
<script>
  window.__off = null;
  const g = c.getContext('2d');
  function draw() {
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    if (window.__off != null) {
      const v = Math.round(Date.now() - window.__off);
      g.fillStyle = '#000';
      for (let i = 0; i < ${BITS}; i++) if ((v >> i) & 1) g.fillRect(i * ${BLOCK}, 0, ${BLOCK}, ${BLOCK});
    }
    requestAnimationFrame(draw);
  }
  draw();
</script></body>`;

/**
 * 每一格的條碼值，以及按鈕區（CSS 中心 1050,460 → 影片 1575,690）是否變黑。
 * 只裁需要的區域（條碼那一條、按鈕一個點），不把整張 1920×880 讀進記憶體（整段會到 250 MB，機器忙時更糟）。
 */
function decode(clip: string): { codes: number[]; pressed: boolean[] } {
  const strip = execFileSync('ffmpeg', ['-v', 'error', '-i', clip, '-vf', `crop=${W}:${B}:0:0`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 26 });
  const dot = execFileSync('ffmpeg', ['-v', 'error', '-i', clip, '-vf', 'crop=2:2:1575:690', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 24 });
  const n = strip.length / (W * B);
  const codes: number[] = [];
  const pressed: boolean[] = [];
  for (let k = 0; k < n; k++) {
    const base = k * W * B;
    let v = 0;
    for (let i = 0; i < BITS; i++) if (strip[base + (B / 2) * W + i * B + B / 2] < 128) v |= 1 << i;
    codes.push(v);
    pressed.push(dot[k * 4] < 128);
  }
  return { codes, pressed };
}

/** captures：每一張進影片的截圖的章節時間（keepFrames 留下的 frames/raw.json，換算方式與引擎相同：扣延遲、扣暫停）。 */
export type Raw = { ev: ChapterEvents; clip: string; synced: number[]; outDir: string; captures: number[] };
export type Recorded = Raw & { frames: FrameCheck[]; click: ClickCheck; errors: number[]; clickErr: number };

/**
 * 錄一段條碼章節：兩步（第二步前因合成配音暫停計時），第一步點一下按鈕。
 * 只錄不分析：解碼用同步的 ffmpeg，同一個程序裡另一路還在錄的話會卡住它的截圖迴圈。
 */
export async function recordBarcode(browser: Browser, root: string, slotsDir: string, label: string): Promise<Raw> {
  const page = await newTutorialPage(browser);
  await page.setContent(PAGE);
  const outDir = join(root, label);
  // 看對齊與一致性，不看截圖速率：機器忙時不要因截圖間隔中止（見 env.ts）；留下原始影格的時間表（frames/raw.json）算每一格的局部上限
  const t = await startChapter({ page, outDir, chapter: `測試｜${label}`, tts: silentProvider(150), slots: { dir: slotsDir, max: 2 }, keepFrames: true, ...CAPTURE_OPTS });
  // 每步開頭把頁面條碼對到章節時間（暫停後章節時鐘會位移，要重設）；記下設好的時間，
  // 分析只從這之後開始，免得把還沒重設的舊條碼算成誤差
  const synced: number[] = [];
  const sync = async () => {
    await page.evaluate((off) => ((window as unknown as { __off: number }).__off = off), Date.now() - t.now());
    synced.push(t.now());
  };
  try {
    await t.step({ caption: '第一步', narration: '這一步有十二個字的配音', status: { kind: 'warn', say: '白話說明', evidence: 'story-9 第 1 步' } }, async () => {
      await sync();
      await t.wait(800);
      await t.click(page.locator('#b'));
    });
    await t.step({ caption: '第二步', narration: '短配音', status: 'ok', note: '舊寫法的依據' }, async () => {
      await sync();
      await t.wait(1500);
    });
    const { clip, events } = await t.finish();
    const raw = JSON.parse(readFileSync(join(outDir, 'frames', 'raw.json'), 'utf8')) as { t0Wall: number; pauses: Pause[]; captureLatencyMs: number; raw: RawFrame[] };
    const captures = timeFrames(
      raw.raw.map((f) => ({ file: f.file, wallMs: f.wallMs - raw.captureLatencyMs })),
      raw.t0Wall,
      raw.pauses,
    ).map((f) => f.ms);
    return { ev: JSON.parse(readFileSync(events, 'utf8')) as ChapterEvents, clip, synced, outDir, captures };
  } finally {
    await t.dispose();
    await page.close();
  }
}

/**
 * 逐格解碼、對每一格與點擊做局部檢查（checks.ts）。
 * errors／clickErr 是總誤差（格位時間 − 內容時間），印摘要與算中位數用；過不過看 frames／click。
 */
export function analyze({ ev, clip, synced, outDir, captures }: Raw): Recorded {
  const { codes, pressed } = decode(clip);
  const frameMs = 1000 / ev.clip.fps;
  // 每一步從條碼對好時間之後 100 ms 起看；最後一格不算：下一步合成配音的暫停中，畫面會停在暫停期間最後一張（內容正確，但條碼還在走）
  const ranges = ev.steps.map((s, i) => ({ fromMs: synced[i] + 100, toMs: s.endMs }));
  const frames = checkFrames(captures, codes, ranges, frameMs);
  const clickEv = ev.events.find((e) => e.type === 'click');
  assert.ok(clickEv && clickEv.type === 'click');
  assert.deepEqual([clickEv.x, clickEv.y], [1575, 690], '點擊座標落在按鈕中心（影片像素＝CSS×1.5）');
  const click = checkClick(captures, clickEv.atMs, pressed.findIndex(Boolean), frameMs);
  return { ev, clip, synced, outDir, captures, frames, click, errors: frames.map((f) => f.errMs), clickErr: click.errMs };
}


// 當獨立程序跑：錄完把結果印成 JSON
if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const [root, slots, label] = process.argv.slice(2);
  const browser = await launchTutorialBrowser();
  try {
    const raw = await recordBarcode(browser, root, slots, label);
    process.stdout.write(`${JSON.stringify(raw)}\n`);
  } finally {
    await browser.close();
  }
}
