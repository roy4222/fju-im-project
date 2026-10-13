// 錄影 API：照劇本操作瀏覽器、錄乾淨畫面（沒有真游標），同時記下每個動作的時間與座標。
//
//   const t = await startChapter({ page, outDir, chapter: '學生｜繳交作業', number: 3, baseURL });
//   await t.step({ caption: '打開作業頁', narration: '…完整配音…', status: 'warn', note: '…' }, async () => {
//     await t.goto('/dashboard/student');
//     await t.click(page.getByRole('link', { name: '作業' }));
//   });
//   await t.finish();

import { execFile } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { cursorAt, planMove, type Move, type Point } from './cursor.ts';
import type { ChapterEvent, ChapterEvents, StatusKind, StepRecord } from './events.ts';
import { cfrSlots, timeFrames, toChapterMs, type Pause, type RawFrame } from './frames.ts';
import { sayProvider, type TtsProvider } from './tts.ts';

const run = promisify(execFile);
const runBuf = promisify(execFile) as unknown as (
  cmd: string,
  args: string[],
  opts: { encoding: 'buffer' },
) => Promise<{ stdout: Buffer }>;
const CAL_BITS = 20;
const CAL_BLOCK = 24;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

/** 上方假網址列高度（影片像素）；頁面錄在它下面。 */
export const CHROME_HEIGHT = 80;
/** 下方字幕條佔掉的高度：游標目標要落在它上面，否則先捲動。 */
export const CAPTION_SAFE = 170;
/** 配音在步驟開始後多久起播。 */
export const NARRATION_LEAD_MS = 250;
/** 配音念完後至少再停多久才換下一步（任務單：步驟 ≥ 配音＋0.6 秒）。 */
export const NARRATION_TAIL_MS = 600;
/** 動作做完後的最短收尾。 */
export const ACTION_TAIL_MS = 400;
export const FPS = 30;
/** 找不到元素就快點失敗，免得錄進一大段空白。 */
export const LOCATOR_TIMEOUT_MS = 5000;

export type StepOptions = {
  /** 字幕：短句。 */
  caption: string;
  /** 配音：完整句子；省略時不配音，步驟長度由動作決定。 */
  narration?: string;
  /** 右上角狀態標記，只在這一步出現。 */
  status?: StatusKind;
  /** 狀態標記旁的一句說明。 */
  note?: string;
};

export type ChapterOptions = {
  page: Page;
  outDir: string;
  /** 章節名，例如「學生｜繳交作業」。 */
  chapter: string;
  /** 章節編號（標題卡顯示「3｜學生」）。 */
  number?: number;
  /** 標題卡副標；省略時取 chapter 最後一個「｜」之後。 */
  subtitle?: string;
  /** 輸出影片大小，預設 1920×1080；頁面 viewport 會設成寬 ×（高 − 網址列）。 */
  viewport?: { width: number; height: number };
  /** t.goto('/x') 的基準網址。 */
  baseURL?: string;
  /** 假網址列顯示的主機，預設取 baseURL 的 host（例如本機錄影時改成 test.fju.roy422.dev）。 */
  displayOrigin?: string;
  tts?: TtsProvider;
  /** JPEG 品質（1–100）。 */
  quality?: number;
  /** 留下原始影格（除錯用）。 */
  keepFrames?: boolean;
};

/**
 * 錄影用的瀏覽器。預設開有視窗的 Chromium：在 Mac mini 上它用 GPU 合成，每秒約 90 格、
 * 畫面延遲約 25 ms；headless 只有每秒約 18 格、畫面會落後 60～130 ms，對不齊也不順。
 */
export async function launchTutorialBrowser({ headless = false }: { headless?: boolean } = {}): Promise<Browser> {
  return chromium.launch({ headless, args: ['--hide-scrollbars', '--disable-features=Translate'] });
}

/** 開一個適合錄影的分頁（1920×1000 viewport、繁中、台北時區）。 */
export async function newTutorialPage(browser: Browser, viewport = { width: 1920, height: 1080 }): Promise<Page> {
  const ctx = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height - CHROME_HEIGHT },
    locale: 'zh-TW',
    timezoneId: 'Asia/Taipei',
  });
  return ctx.newPage();
}

export async function startChapter(opts: ChapterOptions): Promise<Chapter> {
  const c = new Chapter(opts);
  await c.start();
  return c;
}

export class Chapter {
  readonly page: Page;
  readonly outDir: string;
  private readonly opts: ChapterOptions;
  private readonly tts: TtsProvider;
  private readonly size: { width: number; height: number };
  private readonly framesDir: string;
  private readonly raw: RawFrame[] = [];
  private readonly pauses: Pause[] = [];
  private pausedAt: number | null = null;
  private t0Wall = 0;
  private seq = 0;
  private cursor: Point;
  private readonly moves: Move[] = [];
  private readonly events: ChapterEvent[] = [];
  private readonly steps: StepRecord[] = [];
  private current: StepRecord | null = null;
  private lastUrl = '';
  private rng = 1;
  private calWindow: { from: number; to: number } | null = null;

  constructor(opts: ChapterOptions) {
    this.opts = opts;
    this.page = opts.page;
    this.outDir = opts.outDir;
    this.tts = opts.tts ?? sayProvider();
    const vp = opts.viewport ?? { width: 1920, height: 1080 };
    this.size = { width: vp.width, height: vp.height - CHROME_HEIGHT };
    this.framesDir = join(opts.outDir, 'frames');
    this.cursor = { x: Math.round(this.size.width * 0.5), y: Math.round(this.size.height * 0.45) };
  }

  /** 目前的章節時間（ms）。 */
  now(): number {
    return toChapterMs(this.pausedAt ?? Date.now(), this.t0Wall, this.pauses);
  }

  async start(): Promise<void> {
    rmSync(this.framesDir, { recursive: true, force: true });
    mkdirSync(this.framesDir, { recursive: true });
    mkdirSync(join(this.outDir, 'audio'), { recursive: true });
    await this.page.setViewportSize(this.size);
    this.page.on('framenavigated', (f) => {
      if (f === this.page.mainFrame()) this.noteUrl();
    });
    this.t0Wall = Date.now();
    await this.page.screencast.start({
      size: this.size,
      quality: this.opts.quality ?? 85,
      onFrame: ({ data, timestamp }) => {
        const file = join(this.framesDir, `f${String(++this.seq).padStart(6, '0')}.jpg`);
        writeFileSync(file, data);
        this.raw.push({ file, wallMs: timestamp });
      },
    });
    await this.offRecord(() => this.calibrate());
    this.noteUrl();
  }

  /**
   * 量「畫面內容產生 → 截圖時間戳」的延遲：在頁面角落閃一下時間條碼（暫停中，不進影片），
   * finish() 時從影格解碼，取中位數當這一章的 captureLatencyMs，影格時間扣掉它。
   */
  private async calibrate(): Promise<void> {
    const from = Date.now();
    await this.page.evaluate(
      ({ bits, block }) =>
        new Promise<void>((resolve) => {
          const c = document.createElement('canvas');
          c.width = bits * block;
          c.height = block;
          c.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none';
          document.documentElement.appendChild(c);
          const g = c.getContext('2d')!;
          const t0 = performance.now();
          const draw = () => {
            const v = Date.now() % (1 << bits);
            g.fillStyle = '#fff';
            g.fillRect(0, 0, c.width, c.height);
            g.fillStyle = '#000';
            for (let i = 0; i < bits; i++) if ((v >> i) & 1) g.fillRect(i * block, 0, block, block);
            if (performance.now() - t0 < 700) requestAnimationFrame(draw);
            else {
              c.remove();
              resolve();
            }
          };
          requestAnimationFrame(draw);
        }),
      { bits: CAL_BITS, block: CAL_BLOCK },
    );
    this.calWindow = { from, to: Date.now() };
  }

  private async measureLatency(): Promise<number> {
    const w = this.calWindow;
    if (!w) return 0;
    const frames = this.raw.filter((f) => f.wallMs > w.from + 100 && f.wallMs < w.to - 20).slice(0, 40);
    const lags: number[] = [];
    for (const f of frames) {
      const { stdout } = await runBuf('ffmpeg', ['-v', 'error', '-i', f.file, '-vf', `crop=${CAL_BITS * CAL_BLOCK}:${CAL_BLOCK}:0:0`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { encoding: 'buffer' });
      let v = 0;
      for (let i = 0; i < CAL_BITS; i++) if (stdout[(CAL_BLOCK / 2) * CAL_BITS * CAL_BLOCK + i * CAL_BLOCK + CAL_BLOCK / 2] < 128) v |= 1 << i;
      const lag = (((f.wallMs % (1 << CAL_BITS)) - v + (1 << CAL_BITS)) % (1 << CAL_BITS));
      if (lag < 500) lags.push(lag);
    }
    if (lags.length < 5) return 0;
    lags.sort((a, b) => a - b);
    return Math.round(lags[lags.length >> 1]);
  }

  /** 暫停計時：fn 期間的畫面不進影片（例如登入、準備資料）。結束後直接切到當下畫面。 */
  async offRecord<T>(fn: () => Promise<T>): Promise<T> {
    if (this.pausedAt != null) return fn();
    this.pausedAt = Date.now();
    try {
      return await fn();
    } finally {
      // 讓暫停期間的最後畫面有機會送出
      await sleep(120);
      this.pauses.push({ startWall: this.pausedAt, endWall: Date.now() });
      this.pausedAt = null;
    }
  }

  async step(opts: StepOptions, fn: () => Promise<void>): Promise<void> {
    if (this.current) throw new Error(`step 不能巢狀：「${opts.caption}」在「${this.current.caption}」裡面`);
    const speech = opts.narration
      ? await this.offRecord(() => this.tts.synth(opts.narration!, join(this.outDir, '.tts-cache')))
      : undefined;
    const startMs = this.now();
    const rec: StepRecord = {
      index: this.steps.length + 1,
      caption: opts.caption,
      narration: opts.narration ?? '',
      status: opts.status ? { kind: opts.status, note: opts.note } : undefined,
      startMs,
      endMs: startMs,
    };
    if (speech) {
      const file = join(this.outDir, 'audio', `step-${String(rec.index).padStart(2, '0')}.wav`);
      copyFileSync(speech.file, file);
      rec.audio = { file: relative(this.outDir, file), startMs: startMs + NARRATION_LEAD_MS, durationMs: speech.durationMs };
    }
    this.steps.push(rec);
    this.current = rec;
    try {
      await fn();
      const minEnd = rec.audio ? rec.audio.startMs + rec.audio.durationMs + NARRATION_TAIL_MS : startMs;
      await sleep(Math.max(minEnd - this.now(), ACTION_TAIL_MS));
    } finally {
      rec.endMs = this.now();
      this.current = null;
    }
  }

  // ── 動作 ─────────────────────────────────────────────

  async goto(path: string): Promise<void> {
    const url = this.opts.baseURL ? new URL(path, this.opts.baseURL).toString() : path;
    await this.page.goto(url, { waitUntil: 'load' });
    await this.page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
    this.noteUrl();
  }

  async hover(locator: Locator): Promise<void> {
    await this.moveTo(await this.targetOf(locator));
    await this.settleOn(locator);
  }

  async click(locator: Locator): Promise<void> {
    await this.hover(locator);
    await sleep(150);
    await this.page.mouse.down();
    // 記在頁面處理完按下、畫出下一格之後：波紋與頁面反應同一格出現
    await this.nextPaint();
    this.events.push({ type: 'click', atMs: this.now(), x: this.cursor.x, y: this.cursor.y });
    await sleep(70);
    await this.page.mouse.up();
    await sleep(350);
    await this.page.waitForLoadState('load').catch(() => {});
    this.noteUrl();
  }

  /** 點進欄位後逐字輸入（像人打字，每字 60～130 ms）。 */
  async type(locator: Locator, text: string, opts: { secret?: boolean } = {}): Promise<void> {
    await this.click(locator);
    const startMs = this.now();
    for (const ch of text) {
      await this.page.keyboard.type(ch);
      await sleep(60 + this.random() * 70);
    }
    // secret：密碼之類不寫進 events.json
    this.events.push({ type: 'type', startMs, endMs: this.now(), text: opts.secret ? '•'.repeat([...text].length) : text });
  }

  /** 原生下拉選單：游標移過去、點擊波紋，再直接選值（原生選單的彈出層錄不到）。 */
  async select(locator: Locator, value: string): Promise<void> {
    await this.hover(locator);
    await sleep(150);
    this.events.push({ type: 'click', atMs: this.now(), x: this.cursor.x, y: this.cursor.y });
    await locator.selectOption(value);
    this.events.push({ type: 'select', atMs: this.now(), value });
    await sleep(350);
  }

  /** 上傳：file input 多半是隱藏的，用 via 指定游標要點的按鈕。 */
  async upload(locator: Locator, file: string, opts: { via?: Locator } = {}): Promise<void> {
    const target = opts.via ?? ((await locator.isVisible()) ? locator : null);
    if (target) {
      await this.moveTo(await this.targetOf(target));
      await sleep(150);
      this.events.push({ type: 'click', atMs: this.now(), x: this.cursor.x, y: this.cursor.y });
    }
    await locator.setInputFiles(file);
    this.events.push({ type: 'upload', atMs: this.now(), file: basename(file) });
    await sleep(400);
  }

  /** 平滑捲動：數字是往下捲幾 px（負數往上）；給 locator 就把它捲到畫面上方三分之一。 */
  async scroll(target: number | Locator): Promise<void> {
    let dy: number;
    if (typeof target === 'number') dy = target;
    else {
      await target.waitFor({ state: 'visible', timeout: LOCATOR_TIMEOUT_MS }).catch((e) => this.fail(target, e));
      const box = await target.boundingBox();
      dy = box ? box.y - this.size.height * 0.3 : 0;
    }
    await this.smoothScroll(dy);
  }

  async wait(ms: number): Promise<void> {
    await sleep(ms);
  }

  // ── 收尾 ─────────────────────────────────────────────

  async finish(): Promise<{ clip: string; events: string }> {
    if (this.current) throw new Error('finish() 前要先結束 step');
    await sleep(300);
    const durationMs = this.now();
    await this.page.screencast.stop();
    const captureLatencyMs = await this.measureLatency();
    const shifted = this.raw.map((f) => ({ file: f.file, wallMs: f.wallMs - captureLatencyMs }));
    const frames = timeFrames(shifted, this.t0Wall, this.pauses);
    const slots = cfrSlots(frames, durationMs, FPS);
    if (slots.length === 0) throw new Error('沒有錄到任何畫面');
    const d = (1 / FPS).toFixed(6);
    const lines = ['ffconcat version 1.0'];
    for (const f of slots) lines.push(`file '${basename(f)}'`, `duration ${d}`);
    lines.push(`file '${basename(slots[slots.length - 1])}'`);
    writeFileSync(join(this.framesDir, 'list.ffconcat'), lines.join('\n'));
    const clip = join(this.outDir, 'clip.mp4');
    const { width, height } = this.size;
    await run('ffmpeg', [
      '-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', join(this.framesDir, 'list.ffconcat'),
      '-vf', `scale=${width}:${height}:flags=lanczos,setsar=1`,
      '-fps_mode', 'cfr', '-r', String(FPS), '-frames:v', String(slots.length),
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '14', '-pix_fmt', 'yuv420p', clip,
    ], { maxBuffer: 1 << 24 });
    if (!this.opts.keepFrames) rmSync(this.framesDir, { recursive: true, force: true });

    const out: ChapterEvents = {
      version: 1,
      chapter: this.opts.chapter,
      number: this.opts.number,
      subtitle: this.opts.subtitle,
      output: { width: this.size.width, height: this.size.height + CHROME_HEIGHT, chromeHeight: CHROME_HEIGHT },
      page: { width: this.size.width, height: this.size.height, zoom: 1 },
      clip: { file: 'clip.mp4', durationMs: Math.round((slots.length * 1000) / FPS), fps: FPS, captureLatencyMs },
      displayOrigin: this.opts.displayOrigin ?? (this.opts.baseURL ? new URL(this.opts.baseURL).host : ''),
      cursorStart: { x: Math.round(this.size.width * 0.5), y: Math.round(this.size.height * 0.45) },
      steps: this.steps.map((s) => ({ ...s, startMs: Math.round(s.startMs), endMs: Math.round(s.endMs) })),
      events: [...this.moves.map((m) => ({ type: 'move' as const, ...m })), ...this.events].sort(eventTime),
    };
    const eventsFile = join(this.outDir, 'events.json');
    writeFileSync(eventsFile, JSON.stringify(out, null, 2));
    return { clip, events: eventsFile };
  }

  // ── 內部 ─────────────────────────────────────────────

  private random(): number {
    // 固定種子：同一份劇本每次打字節奏一樣
    this.rng = (this.rng * 16807) % 2147483647;
    return this.rng / 2147483647;
  }

  private fail(locator: Locator, e: unknown): never {
    throw new Error(`［${this.current?.caption ?? '步驟外'}］${LOCATOR_TIMEOUT_MS / 1000} 秒內找不到 ${locator}`, { cause: e });
  }

  private async nextPaint(): Promise<void> {
    await this.page
      .evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0))))
      .catch(() => {});
  }

  private noteUrl(): void {
    const url = this.page.url();
    if (url === this.lastUrl || url === 'about:blank') return;
    this.lastUrl = url;
    this.events.push({ type: 'url', atMs: Math.max(0, this.now()), url });
  }

  /** 目標中心（影片像素）；不在安全區（網址列下、字幕條上）就先平滑捲動。 */
  private async targetOf(locator: Locator): Promise<Point> {
    await locator.waitFor({ state: 'visible', timeout: LOCATOR_TIMEOUT_MS }).catch((e) => this.fail(locator, e));
    let box = await locator.boundingBox();
    if (!box) throw new Error(`找不到元素位置：${locator}`);
    const top = 40;
    const bottom = this.size.height - CAPTION_SAFE;
    const cy = box.y + box.height / 2;
    if (cy < top || cy > bottom) {
      await this.smoothScroll(cy - this.size.height * 0.42);
      box = await locator.boundingBox();
      if (!box || box.y + box.height / 2 < 0 || box.y + box.height / 2 > this.size.height) {
        await locator.scrollIntoViewIfNeeded();
        await sleep(200);
        box = await locator.boundingBox();
      }
      if (!box) throw new Error(`捲動後找不到元素：${locator}`);
      const ny = box.y + box.height / 2;
      if (ny > bottom) console.warn(`［${this.current?.caption ?? '步驟外'}］${locator} 捲不上來，會被字幕條蓋住（頁面底部空間不夠）`);
    }
    return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  }

  /** 記下一段緩動移動並真的等它走完，最後把真滑鼠放到終點（讓 hover 樣式在游標抵達時出現）。 */
  private async moveTo(to: Point): Promise<void> {
    const m = planMove(this.cursor, to, this.now());
    if (m.endMs > m.startMs) {
      this.moves.push(m);
      await sleep(m.endMs - m.startMs);
    }
    this.cursor = { ...to };
    await this.page.mouse.move(to.x, to.y, { steps: 4 });
  }

  /** 移動途中版面若有位移（黏頂列、圖片載入），補一小段修正。 */
  private async settleOn(locator: Locator): Promise<void> {
    const box = await locator.boundingBox();
    if (!box) return;
    const p = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
    const inside = Math.abs(p.x - this.cursor.x) < box.width / 2 - 2 && Math.abs(p.y - this.cursor.y) < box.height / 2 - 2;
    if (!inside) await this.moveTo(p);
  }

  private async smoothScroll(dy: number): Promise<void> {
    if (Math.abs(dy) < 4) return;
    const ms = Math.round(Math.min(1400, Math.max(500, Math.abs(dy) * 0.9)));
    const startMs = this.now();
    const moved = await this.page.evaluate(
      ({ dy, ms }) =>
        new Promise<number>((resolve) => {
          const el = document.scrollingElement ?? document.documentElement;
          const y0 = el.scrollTop;
          const target = Math.max(0, Math.min(y0 + dy, el.scrollHeight - el.clientHeight));
          const t0 = performance.now();
          const ease = (u: number) => (1 - Math.cos(Math.PI * u)) / 2;
          const f = (now: number) => {
            const u = Math.min(1, (now - t0) / ms);
            el.scrollTo({ top: y0 + (target - y0) * ease(u), behavior: 'instant' });
            if (u < 1) requestAnimationFrame(f);
            else resolve(el.scrollTop - y0);
          };
          requestAnimationFrame(f);
        }),
      { dy, ms },
    );
    await sleep(150);
    this.events.push({ type: 'scroll', startMs, endMs: this.now(), dy: Math.round(moved) });
  }

  /** 給測試與後製參考：時間 t 的游標位置。 */
  cursorAt(t: number): Point {
    return cursorAt(this.moves, { x: Math.round(this.size.width * 0.5), y: Math.round(this.size.height * 0.45) }, t);
  }
}

function eventTime(e: ChapterEvent): number {
  return 'atMs' in e ? e.atMs : e.startMs;
}
