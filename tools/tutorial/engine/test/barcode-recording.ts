// 條碼錄影的共用部分：recorder.test.ts 直接用；兩路並行測試把它當獨立程序跑
//   node engine/test/barcode-recording.ts <root> <slotsDir> <label>   → 印出 JSON（Raw）

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { launchTutorialBrowser, newTutorialPage, startChapter } from '../recorder.ts';
import { silentProvider } from '../tts.ts';
import type { ChapterEvents } from '../events.ts';

const BITS = 20;
const BLOCK = 40;
/** 頁面放大 1.5 倍錄影：CSS px × ZOOM ＝ 影片像素。 */
export const ZOOM = 1.5;
const B = BLOCK * ZOOM;
export const W = 1920;
export const H = 1000;

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

/** 每一格的條碼值，以及按鈕區（CSS 中心 1050,460 → 影片 1575,690）是否變黑。 */
function decode(clip: string): { codes: number[]; pressed: boolean[] } {
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', clip, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 30 });
  const n = buf.length / (W * H);
  const codes: number[] = [];
  const pressed: boolean[] = [];
  for (let k = 0; k < n; k++) {
    const base = k * W * H;
    let v = 0;
    for (let i = 0; i < BITS; i++) if (buf[base + (B / 2) * W + i * B + B / 2] < 128) v |= 1 << i;
    codes.push(v);
    pressed.push(buf[base + 690 * W + 1575] < 128);
  }
  return { codes, pressed };
}

export type Raw = { ev: ChapterEvents; clip: string; synced: number[]; outDir: string };
export type Recorded = Raw & { errors: number[]; clickErr: number };

/**
 * 錄一段條碼章節：兩步（第二步前因合成配音暫停計時），第一步點一下按鈕。
 * 只錄不分析：解碼用同步的 ffmpeg，同一個程序裡另一路還在錄的話會卡住它的截圖迴圈。
 */
export async function recordBarcode(browser: Browser, root: string, slotsDir: string, label: string): Promise<Raw> {
  const page = await newTutorialPage(browser);
  await page.setContent(PAGE);
  const outDir = join(root, label);
  const t = await startChapter({ page, outDir, chapter: `測試｜${label}`, tts: silentProvider(150), slots: { dir: slotsDir, max: 2 } });
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
    return { ev: JSON.parse(readFileSync(events, 'utf8')) as ChapterEvents, clip, synced, outDir };
  } finally {
    await t.dispose();
    await page.close();
  }
}

/** 逐格解碼、算誤差。 */
export function analyze({ ev, clip, synced, outDir }: Raw): Recorded {
  {
    const { codes, pressed } = decode(clip);
    const frameMs = 1000 / ev.clip.fps;
    // 逐格（含重複格）：第 k 格顯示的條碼值就是那張畫面內容的章節時間
    const errors: number[] = [];
    for (const [i, s] of ev.steps.entries()) {
      // 最後一格不算：下一步合成配音的暫停中，畫面會停在暫停期間最後一張（內容正確，但條碼還在走）
      for (let k = Math.ceil((synced[i] + 100) / frameMs); (k + 1) * frameMs < s.endMs; k++) {
        if (codes[k] !== 0) errors.push(k * frameMs - codes[k]);
      }
    }
    const click = ev.events.find((e) => e.type === 'click');
    assert.ok(click && click.type === 'click');
    const clickErr = pressed.findIndex(Boolean) * frameMs - click.atMs;
    assert.deepEqual([click.x, click.y], [1575, 690], '點擊座標落在按鈕中心（影片像素＝CSS×1.5）');
    return { ev, clip, synced, errors, clickErr, outDir };
  }
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
