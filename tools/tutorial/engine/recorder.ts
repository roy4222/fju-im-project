// 錄影 API：照劇本操作瀏覽器、錄乾淨畫面（沒有真游標），同時記下每個動作的時間與座標。
//
//   const browser = await launchTutorialBrowser();
//   const page = await newTutorialPage(browser);
//   const t = await startChapter({ page, id: '3-3', chapter: '學生｜繳交作業', baseURL });
//   try {
//     await t.step({ caption: '打開作業頁', narration: '…完整配音…', status: 'warn', note: '…' }, async () => {
//       await t.goto('/dashboard/student');
//       await t.click(page.getByRole('link', { name: '作業' }));
//     });
//     await t.finish();
//   } finally {
//     await t.dispose();
//     await browser.close();
//   }

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { chromium, type Browser, type CDPSession, type Frame, type Locator, type Page } from 'playwright';
import { cursorAt, planMove, type Move, type Point } from './cursor.ts';
import type { ChapterEvent, ChapterEvents, StatusKind, StepRecord } from './events.ts';
import { captureQuality, cfrSlots, GAP_SEVERE_MS, timeFrames, toChapterMs, type Pause, type RawFrame } from './frames.ts';
import { acquireRecordSlot, claimOutDir, DEFAULT_OUT_ROOT, FAILED_MARK, newRunDir, RECORDING_MARK, type RecordSlot, type SlotOptions } from './runs.ts';
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
/**
 * 網頁放大倍率：CSS 1280×667 的視窗以 1.5 倍實際像素渲染，錄成 1920 寬的影片；
 * 網頁正文 15px 在 1080p 裡約 22px（手機、筆電上看得清楚），版面仍是桌機版。
 *
 * 用瀏覽器層級的 --force-device-scale-factor，而不是 Playwright 的 deviceScaleFactor 模擬：
 * 模擬時 screencast 與 CDP 截圖都只給 CSS 大小（1280 寬）的影格；若另開 session 設裝置參數，
 * 截圖雖是 1920 寬，滑鼠座標卻會被再除一次 1.5。
 */
export const DEFAULT_ZOOM = 1.5;
/** 下方字幕條佔掉的高度（影片像素）：游標目標要落在它上面，否則先捲動。 */
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
/** 截圖連續失敗這麼久就放棄（分頁大概不在了）。 */
const CAPTURE_GIVE_UP_MS = 5000;
/**
 * 單張截圖等這麼久沒回應就換一個 CDP session 重來：跨程序換頁（例如 about:blank → 網站）後，
 * 舊 session 的 captureScreenshot 會永遠不回應。
 */
const CAPTURE_TIMEOUT_MS = 400;

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

export type WaitStableOptions = {
  /** 等這個元素出現（Locator，或畫面上的一段字）。 */
  ready?: Locator | string;
  /** 等畫面內看得到的圖片下載並解碼完成，預設 true。 */
  images?: boolean;
  /** 等網頁字型載入，預設 true。 */
  fonts?: boolean;
  /** 連續幾張截圖完全一樣才算版面穩定，預設 2。 */
  frames?: number;
  /** 最多等多久，預設 10 秒；超過會警告並記在 events.json（strict 時改成報錯）。 */
  timeout?: number;
  strict?: boolean;
  /** 等待期間暫停計時（不進影片）。goto／換頁後自動呼叫時為 true。 */
  offRecord?: boolean;
};

export type ChapterOptions = {
  page: Page;
  /** 分鏡的段編號，例如「3-3」「5A-2」；feature-table 的「章節與步驟」用它對應。 */
  id?: string;
  /** 章節名，例如「學生｜繳交作業」。 */
  chapter: string;
  /** 舊寫法：數字章節編號（等同 id）。 */
  number?: number;
  /** 標題卡副標；省略時取 chapter 最後一個「｜」之後。 */
  subtitle?: string;
  /**
   * 這次錄影的輸出目錄。省略時自動在 outRoot 下建一個新的 run 目錄（建議）。
   * 指定時必須是還不存在的目錄：開始前原子建立，已存在就拒絕。
   */
  outDir?: string;
  /** 自動建立 run 目錄的上層，預設 ~/work/tutorial-out/runs。 */
  outRoot?: string;
  /** 全機錄影名額設定（測試用；平常用預設的 2 路）。 */
  slots?: SlotOptions;
  /** 輸出影片大小，預設 1920×1080；頁面區是寬 ×（高 − 網址列），CSS viewport 再除以 zoom。 */
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
  /** 錄影中兩張截圖間隔超過這個值就中止，預設 100 ms。 */
  maxGapMs?: number;
};

/**
 * 錄影用的瀏覽器。預設開有視窗的 Chromium（在 Mac mini 上用 GPU 合成，畫面延遲小）；
 * headless 截圖慢、畫面會落後，對不齊也不順。
 */
export async function launchTutorialBrowser({ headless = false, zoom = DEFAULT_ZOOM }: { headless?: boolean; zoom?: number } = {}): Promise<Browser> {
  return chromium.launch({
    headless,
    args: ['--hide-scrollbars', '--disable-features=Translate', `--force-device-scale-factor=${zoom}`, '--window-position=0,0'],
  });
}

/** 影片頁面區（像素）對應的 CSS viewport。高度無條件進位，多出的一兩列像素在輸出時裁掉。 */
export function cssViewport(viewport: { width: number; height: number }, zoom: number): { width: number; height: number } {
  return { width: Math.round(viewport.width / zoom), height: Math.ceil((viewport.height - CHROME_HEIGHT) / zoom) };
}

/** 開一個適合錄影的分頁（真實視窗、不做 viewport 模擬，視窗內容區調成 CSS 1280×667）、繁中、台北時區。 */
export async function newTutorialPage(browser: Browser, { viewport = { width: 1920, height: 1080 } } = {}): Promise<Page> {
  const ctx = await browser.newContext({ viewport: null, locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
  const page = await ctx.newPage();
  const zoom = await page.evaluate(() => devicePixelRatio);
  await fitWindow(page, cssViewport(viewport, zoom));
  return page;
}

/** 調整瀏覽器視窗，讓內容區剛好是 css 大小（視窗框與工具列的高度各平台不同，量了再補）。 */
export async function fitWindow(page: Page, css: { width: number; height: number }): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { windowId } = (await cdp.send('Browser.getWindowForTarget')) as { windowId: number };
    for (let i = 0; i < 4; i++) {
      const [w, h] = await page.evaluate(() => [innerWidth, innerHeight]);
      if (w === css.width && h === css.height) return;
      const { bounds } = (await cdp.send('Browser.getWindowBounds', { windowId })) as { bounds: { width: number; height: number } };
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { width: bounds.width + css.width - w, height: bounds.height + css.height - h } });
      await sleep(250);
    }
    const [w, h] = await page.evaluate(() => [innerWidth, innerHeight]);
    if (w !== css.width || h !== css.height) throw new Error(`視窗內容區調不到 ${css.width}×${css.height}（目前 ${w}×${h}）`);
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/** 開始一段錄影。開始失敗會自動清理（歸還名額、停止截圖、標記失敗）再丟出錯誤。 */
export async function startChapter(opts: ChapterOptions): Promise<Chapter> {
  const c = new Chapter(opts);
  try {
    await c.start();
  } catch (e) {
    await c.dispose(e);
    throw e;
  }
  return c;
}

const PERMANENT_CDP_ERROR = /Target closed|Session closed|has been closed|No target with given id|Target page, context or browser|crashed/i;

export class Chapter {
  readonly page: Page;
  /** 這次錄影的 run 目錄（clip.mp4、events.json、audio/ 都在這裡）。 */
  readonly outDir: string;
  readonly id: string | undefined;
  private readonly opts: ChapterOptions;
  private readonly tts: TtsProvider;
  /** clip 影片像素大小（頁面區）。事件座標、游標都用這個單位。 */
  private readonly size: { width: number; height: number };
  /** 頁面的 CSS viewport；Playwright 滑鼠與 boundingBox 用這個單位。 */
  private css: { width: number; height: number };
  private zoom: number;
  private cdp: CDPSession | null = null;
  private capturing: Promise<void> | null = null;
  private stopCapture = false;
  private slot: RecordSlot | null = null;
  private claimed = false;
  private finished = false;
  private disposed = false;
  private failure: Error | null = null;
  private readonly abortCtl = new AbortController();
  private readonly framesDir: string;
  private readonly raw: RawFrame[] = [];
  private readonly pauses: Pause[] = [];
  private pausedAt: number | null = null;
  private t0Wall = 0;
  private seq = 0;
  /** 最近一張截圖的內容雜湊與「連續相同」張數（waitStable 用）。 */
  private lastHash = '';
  private sameRun = 0;
  private frameCount = 0;
  private cursor: Point;
  private readonly moves: Move[] = [];
  private readonly events: ChapterEvent[] = [];
  private readonly steps: StepRecord[] = [];
  private readonly warnings: string[] = [];
  private current: StepRecord | null = null;
  private lastUrl = '';
  private rng = 1;
  private calWindow: { from: number; to: number } | null = null;
  private readonly onClose = () => this.abort(new Error('錄影中分頁被關閉'));
  private readonly onCrash = () => this.abort(new Error('錄影中分頁當掉'));
  private readonly onNav = (f: Frame) => {
    if (f === this.page.mainFrame()) this.noteUrl();
  };

  constructor(opts: ChapterOptions) {
    this.opts = opts;
    this.page = opts.page;
    this.id = opts.id ?? (opts.number != null ? String(opts.number) : undefined);
    this.outDir = opts.outDir ?? newRunDir(opts.outRoot ?? DEFAULT_OUT_ROOT, `${this.id ?? ''} ${opts.chapter}`);
    this.tts = opts.tts ?? sayProvider();
    const vp = opts.viewport ?? { width: 1920, height: 1080 };
    this.size = { width: vp.width, height: vp.height - CHROME_HEIGHT };
    // zoom 在 start() 從分頁的 devicePixelRatio 讀；先放預設值
    this.zoom = DEFAULT_ZOOM;
    this.css = cssViewport(vp, this.zoom);
    this.framesDir = join(this.outDir, 'frames');
    this.cursor = { x: Math.round(this.size.width * 0.5), y: Math.round(this.size.height * 0.45) };
  }

  /** 目前的章節時間（ms）。 */
  now(): number {
    return toChapterMs(this.pausedAt ?? Date.now(), this.t0Wall, this.pauses);
  }

  async start(): Promise<void> {
    claimOutDir(this.outDir); // 撞名就在這裡丟錯，什麼都還沒開始
    this.claimed = true;
    mkdirSync(this.framesDir, { recursive: true });
    mkdirSync(join(this.outDir, 'audio'), { recursive: true });
    if (this.page.viewportSize()) {
      throw new Error('分頁有 viewport 模擬，截圖只會是 CSS 大小：請用 launchTutorialBrowser() ＋ newTutorialPage(browser) 開分頁');
    }
    this.zoom = await this.page.evaluate(() => devicePixelRatio);
    this.css = cssViewport(this.opts.viewport ?? { width: 1920, height: 1080 }, this.zoom);
    await fitWindow(this.page, this.css);
    this.page.on('close', this.onClose);
    this.page.on('crash', this.onCrash);
    this.page.on('framenavigated', this.onNav);
    // 只有「錄影」這段佔全機名額（render 不佔）；滿了就在這裡排隊
    this.slot = await acquireRecordSlot({ label: this.outDir, signal: this.abortCtl.signal, ...this.opts.slots });
    this.check();
    // 連續用 CDP 截圖（實際像素 1920 寬）；Playwright 的 screencast 只給 CSS 大小的影格
    this.cdp = await this.page.context().newCDPSession(this.page);
    this.t0Wall = Date.now();
    this.capturing = this.captureLoop();
    await this.offRecord(() => this.calibrate());
    this.noteUrl();
  }

  /**
   * 收尾清理（可重複呼叫）：停止截圖、歸還錄影名額、移除錄影中標記。
   * 沒有正常 finish() 就會在 run 目錄留下 FAILED.txt。腳本請放在 finally 裡呼叫。
   */
  async dispose(reason?: unknown): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (!this.finished && !this.failure) this.failure = reason instanceof Error ? reason : new Error(reason ? String(reason) : '沒有呼叫 finish() 就結束');
    this.stopCapture = true;
    this.abortCtl.abort();
    await Promise.race([this.capturing, sleep(3000)]).catch(() => {});
    await this.cdp?.detach().catch(() => {});
    this.slot?.release();
    this.page.off('close', this.onClose);
    this.page.off('crash', this.onCrash);
    this.page.off('framenavigated', this.onNav);
    if (this.claimed) {
      if (!this.finished) writeFileSync(join(this.outDir, FAILED_MARK), `${this.failure?.stack ?? this.failure}\n`);
      const mark = join(this.outDir, RECORDING_MARK);
      if (existsSync(mark)) unlinkSync(mark);
    }
  }

  /** 錄影已中止就丟出原因（每個動作開頭都會檢查）。 */
  private check(): void {
    if (this.failure) throw this.failure;
    if (this.disposed) throw new Error('這段錄影已經結束');
  }

  private abort(err: Error): void {
    if (this.failure || this.finished) return;
    this.failure = err;
    this.stopCapture = true;
    this.abortCtl.abort(err);
  }

  /** 可被中止打斷的等待。 */
  private wait_(ms: number): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(t);
        reject(this.failure ?? new Error('錄影已中止'));
      };
      const t = setTimeout(() => {
        this.abortCtl.signal.removeEventListener('abort', onAbort);
        resolve();
      }, Math.max(0, ms));
      this.abortCtl.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** 連續截圖（Mac mini 上 1920 寬約每秒 30～38 張）；影格時間取請求前後的中點。 */
  private async captureLoop(): Promise<void> {
    const quality = this.opts.quality ?? 85;
    const maxGap = this.opts.maxGapMs ?? GAP_SEVERE_MS;
    // 跟事件同一個時鐘（Date.now）；performance.timeOrigin＋now() 跟系統時鐘會差上幾十 ms
    const clock = () => Date.now();
    let prev: { mid: number; pauses: number } | null = null;
    let failingSince = 0;
    while (!this.stopCapture) {
      const t0 = clock();
      let data: string;
      try {
        const cdp = this.cdp!;
        const shot = cdp.send('Page.captureScreenshot', { format: 'jpeg', quality, optimizeForSpeed: true }) as Promise<{ data: string }>;
        shot.catch(() => {}); // 逾時後才失敗的那一張不要變成未處理的 rejection
        const r = await Promise.race([shot, sleep(CAPTURE_TIMEOUT_MS).then(() => null)]);
        if (!r) {
          // 這個 session 卡住了：換一個新的，舊的丟掉
          this.cdp = await this.page.context().newCDPSession(this.page);
          void cdp.detach().catch(() => {});
          throw new Error(`截圖 ${CAPTURE_TIMEOUT_MS} ms 沒回應，已換新的 CDP session`);
        }
        data = r.data;
      } catch (e) {
        const msg = String((e as Error).message ?? e);
        if (PERMANENT_CDP_ERROR.test(msg)) return this.abort(new Error(`截圖失敗（分頁或瀏覽器已不在）：${msg}`));
        failingSince ||= t0;
        if (t0 - failingSince > CAPTURE_GIVE_UP_MS) return this.abort(new Error(`連續 ${CAPTURE_GIVE_UP_MS / 1000} 秒截不到畫面：${msg}`));
        await sleep(15); // 換頁中可能截不到，稍後再試
        continue;
      }
      failingSince = 0;
      const t1 = clock();
      const mid = (t0 + t1) / 2;
      // 錄進影片的時間（不在暫停中、中間也沒暫停過）若兩張間隔過大就中止：影片會明顯卡頓、對不齊
      if (prev && this.pausedAt == null && prev.pauses === this.pauses.length && mid - prev.mid > maxGap) {
        return this.abort(
          new Error(`截圖間隔 ${Math.round(mid - prev.mid)} ms（上限 ${maxGap} ms）：機器太忙或同時錄影的路數太多，請重錄這一段`),
        );
      }
      prev = this.pausedAt == null ? { mid, pauses: this.pauses.length } : null;
      const buf = Buffer.from(data, 'base64');
      const hash = createHash('sha1').update(buf).digest('hex');
      this.sameRun = hash === this.lastHash ? this.sameRun + 1 : 0;
      this.lastHash = hash;
      this.frameCount++;
      const file = join(this.framesDir, `f${String(++this.seq).padStart(6, '0')}.jpg`);
      writeFileSync(file, buf);
      this.raw.push({ file, wallMs: mid });
    }
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
      const z = this.zoom;
      const crop = `crop=${Math.round(CAL_BITS * CAL_BLOCK * z)}:${Math.round(CAL_BLOCK * z)}:0:0,scale=${CAL_BITS * CAL_BLOCK}:${CAL_BLOCK}`;
      const { stdout } = await runBuf('ffmpeg', ['-v', 'error', '-i', f.file, '-vf', crop, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { encoding: 'buffer' });
      let v = 0;
      for (let i = 0; i < CAL_BITS; i++) if (stdout[(CAL_BLOCK / 2) * CAL_BITS * CAL_BLOCK + i * CAL_BLOCK + CAL_BLOCK / 2] < 128) v |= 1 << i;
      const lag = ((f.wallMs % (1 << CAL_BITS)) - v + (1 << CAL_BITS)) % (1 << CAL_BITS);
      if (lag < 500) lags.push(lag);
    }
    if (lags.length < 5) return 0;
    lags.sort((a, b) => a - b);
    return Math.round(lags[lags.length >> 1]);
  }

  /** 暫停計時：fn 期間的畫面不進影片（例如登入、準備資料）。結束後直接切到當下畫面。 */
  async offRecord<T>(fn: () => Promise<T>): Promise<T> {
    this.check();
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
    this.check();
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
      await this.wait_(Math.max(minEnd - this.now(), ACTION_TAIL_MS));
    } finally {
      rec.endMs = this.now();
      this.current = null;
    }
  }

  // ── 動作 ─────────────────────────────────────────────

  /** 開網址；載入後自動 waitStable（暫停計時，影片直接切到載好的畫面）。傳 false 不等。 */
  async goto(path: string, stable: WaitStableOptions | false = {}): Promise<void> {
    this.check();
    const url = this.opts.baseURL ? new URL(path, this.opts.baseURL).toString() : path;
    const load = async () => {
      await this.page.goto(url, { waitUntil: 'load' });
      this.noteUrl();
    };
    if (stable === false) return load();
    // 換頁與等穩定都不進影片：直接切到載好的畫面（跨程序換頁時截圖也會短暫中斷）
    await this.offRecord(async () => {
      await load();
      await this.waitStable({ ...stable, offRecord: false });
    });
  }

  /**
   * 等畫面穩定：指定元素出現、字型載入、畫面內圖片解碼完成、連續幾張截圖完全一樣。
   * goto 與點擊後換頁會自動呼叫一次（暫停計時）；也可以在步驟裡自己呼叫。
   */
  async waitStable(opts: WaitStableOptions = {}): Promise<void> {
    this.check();
    const { images = true, fonts = true, frames = 2, timeout = 10_000, strict = false } = opts;
    const body = async () => {
      const deadline = Date.now() + timeout;
      const left = () => Math.max(1, deadline - Date.now());
      const problems: string[] = [];
      if (opts.ready) {
        const loc = typeof opts.ready === 'string' ? this.page.getByText(opts.ready).first() : opts.ready;
        await loc.waitFor({ state: 'visible', timeout: left() }).catch(() => problems.push(`等不到 ${loc}`));
      }
      await this.page.waitForLoadState('networkidle', { timeout: Math.min(3000, left()) }).catch(() => {});
      if (fonts || images) {
        await this.page
          .waitForFunction(
            async ({ fonts, images }) => {
              if (fonts && document.fonts.status !== 'loaded') return false;
              if (!images) return true;
              const vw = innerWidth;
              const vh = innerHeight;
              const visible = Array.from(document.images).filter((img) => {
                const r = img.getBoundingClientRect();
                return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw && getComputedStyle(img).visibility !== 'hidden';
              });
              // 畫面內的延遲載入圖改成立即載入
              for (const img of visible) if (img.loading === 'lazy') img.loading = 'eager';
              if (!visible.every((img) => img.complete && img.naturalWidth > 0)) return false;
              await Promise.all(visible.map((img) => img.decode().catch(() => {})));
              return true;
            },
            { fonts, images },
            { timeout: left(), polling: 100 },
          )
          .catch(() => problems.push(fonts && images ? '字型或畫面內圖片沒載完' : images ? '畫面內圖片沒載完' : '字型沒載完'));
      }
      // 版面穩定：從現在起連續 frames 張截圖內容完全一樣
      const startCount = this.frameCount;
      while (!(this.frameCount - startCount >= frames && this.sameRun >= frames - 1)) {
        if (Date.now() > deadline) {
          problems.push(`畫面一直在變（連續 ${frames} 張截圖沒有一樣過）`);
          break;
        }
        await this.wait_(30);
      }
      if (problems.length) {
        const msg = `［${this.current?.caption ?? '步驟外'}］${this.page.url()} ${timeout / 1000} 秒內畫面沒穩定：${problems.join('；')}`;
        if (strict) throw new Error(msg);
        console.warn(`注意：${msg}`);
        this.warnings.push(msg);
      }
    };
    await (opts.offRecord ? this.offRecord(body) : body());
  }

  async hover(locator: Locator): Promise<void> {
    this.check();
    await this.moveTo(await this.targetOf(locator));
    await this.settleOn(locator);
  }

  /** 點擊；若因此換頁，等新頁穩定（暫停計時）。傳 false 不等。 */
  async click(locator: Locator, stable: WaitStableOptions | false = {}): Promise<void> {
    await this.hover(locator);
    await this.wait_(150);
    const before = this.page.url();
    await this.page.mouse.down();
    await this.wait_(70);
    await this.page.mouse.up();
    // 記在放開滑鼠（click 事件在這時觸發）且頁面畫出下一格之後：波紋與頁面反應同一格出現
    await this.nextPaint();
    this.events.push({ type: 'click', atMs: this.now(), x: this.cursor.x, y: this.cursor.y });
    await this.wait_(350);
    await this.page.waitForLoadState('load').catch(() => {});
    this.noteUrl();
    if (stable !== false && this.page.url() !== before) await this.waitStable({ offRecord: true, ...stable });
  }

  /** 點進欄位後逐字輸入（像人打字，每字 60～130 ms）。 */
  async type(locator: Locator, text: string, opts: { secret?: boolean } = {}): Promise<void> {
    await this.click(locator, false);
    const startMs = this.now();
    for (const ch of text) {
      await this.page.keyboard.type(ch);
      await this.wait_(60 + this.random() * 70);
    }
    // secret：密碼之類不寫進 events.json
    this.events.push({ type: 'type', startMs, endMs: this.now(), text: opts.secret ? '•'.repeat([...text].length) : text });
  }

  /** 原生下拉選單：游標移過去、點擊波紋，再直接選值（原生選單的彈出層錄不到）。 */
  async select(locator: Locator, value: string): Promise<void> {
    await this.hover(locator);
    await this.wait_(150);
    this.events.push({ type: 'click', atMs: this.now(), x: this.cursor.x, y: this.cursor.y });
    await locator.selectOption(value);
    this.events.push({ type: 'select', atMs: this.now(), value });
    await this.wait_(350);
  }

  /** 上傳：file input 多半是隱藏的，用 via 指定游標要點的按鈕。 */
  async upload(locator: Locator, file: string, opts: { via?: Locator } = {}): Promise<void> {
    this.check();
    const target = opts.via ?? ((await locator.isVisible()) ? locator : null);
    if (target) {
      await this.moveTo(await this.targetOf(target));
      await this.wait_(150);
      this.events.push({ type: 'click', atMs: this.now(), x: this.cursor.x, y: this.cursor.y });
    }
    await locator.setInputFiles(file);
    this.events.push({ type: 'upload', atMs: this.now(), file: basename(file) });
    await this.wait_(400);
  }

  /** 平滑捲動：數字是往下捲幾 px（網頁 CSS px，負數往上）；給 locator 就把它捲到畫面上方三分之一。 */
  async scroll(target: number | Locator): Promise<void> {
    this.check();
    let dy: number;
    if (typeof target === 'number') dy = target;
    else {
      await target.waitFor({ state: 'visible', timeout: LOCATOR_TIMEOUT_MS }).catch((e) => this.fail(target, e));
      const box = await target.boundingBox();
      dy = box ? box.y - this.css.height * 0.3 : 0;
    }
    await this.smoothScroll(dy);
  }

  async wait(ms: number): Promise<void> {
    this.check();
    await this.wait_(ms);
  }

  // ── 收尾 ─────────────────────────────────────────────

  async finish(): Promise<{ clip: string; events: string }> {
    this.check();
    if (this.current) throw new Error('finish() 前要先結束 step');
    try {
      return await this.finishInner();
    } catch (e) {
      await this.dispose(e);
      throw e;
    }
  }

  private async finishInner(): Promise<{ clip: string; events: string }> {
    await this.wait_(300);
    const durationMs = this.now();
    this.stopCapture = true;
    await this.capturing;
    this.check(); // 收尾前一刻若中止（例如間隔過大）就報錯
    await this.cdp?.detach().catch(() => {});
    // 錄影結束就歸還名額：後面的編碼與 render 不佔名額
    this.slot?.release();
    this.page.off('close', this.onClose);
    this.page.off('crash', this.onCrash);
    this.page.off('framenavigated', this.onNav);

    const captureLatencyMs = await this.measureLatency();
    const shifted = this.raw.map((f) => ({ file: f.file, wallMs: f.wallMs - captureLatencyMs }));
    const frames = timeFrames(shifted, this.t0Wall, this.pauses);
    const slots = cfrSlots(frames, durationMs, FPS);
    if (slots.length === 0) throw new Error('沒有錄到任何畫面');
    const steps = this.steps.map((s) => ({ ...s, startMs: Math.round(s.startMs), endMs: Math.round(s.endMs) }));
    const quality = captureQuality(
      frames.map((f) => f.ms),
      steps,
      durationMs,
    );
    for (const w of quality.warnings) console.warn(`注意（截圖品質）：${w}`);

    // 每個格位一個編號連結，用 image2 以固定 30fps 讀：不經過 fps 換算
    // （concat 的 duration 0.033333 會讓 ffmpeg 重複與丟格，整段晚一格）
    const slotDir = join(this.framesDir, 'slots');
    mkdirSync(slotDir, { recursive: true });
    slots.forEach((f, k) => symlinkSync(join('..', basename(f)), join(slotDir, `s${String(k).padStart(6, '0')}.jpg`)));
    const clip = join(this.outDir, 'clip.mp4');
    const { width, height } = this.size;
    await run('ffmpeg', [
      '-y', '-v', 'error', '-framerate', String(FPS), '-start_number', '0', '-i', join(slotDir, 's%06d.jpg'),
      // 影格本來就是 1920 寬：scale 不會重取樣；高度多出的一列（667×1.5=1001）直接裁掉
      '-vf', `scale=${width}:-1:flags=lanczos,crop=${width}:'min(ih,${height})':0:0,pad=${width}:${height}:0:0:white,setsar=1`,
      '-fps_mode', 'cfr', '-r', String(FPS), '-frames:v', String(slots.length),
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '14', '-pix_fmt', 'yuv420p', clip,
    ], { maxBuffer: 1 << 24 });
    if (!this.opts.keepFrames) rmSync(this.framesDir, { recursive: true, force: true });
    else writeFileSync(join(this.framesDir, 'raw.json'), JSON.stringify({ t0Wall: this.t0Wall, pauses: this.pauses, captureLatencyMs, raw: this.raw }));

    const out: ChapterEvents = {
      version: 1,
      id: this.id,
      chapter: this.opts.chapter,
      number: this.opts.number,
      subtitle: this.opts.subtitle,
      output: { width: this.size.width, height: this.size.height + CHROME_HEIGHT, chromeHeight: CHROME_HEIGHT },
      page: { width: this.css.width, height: this.css.height, zoom: this.zoom },
      clip: { file: 'clip.mp4', durationMs: Math.round((slots.length * 1000) / FPS), fps: FPS, captureLatencyMs },
      quality: { ...quality, warnings: [...quality.warnings, ...this.warnings], ok: quality.ok && this.warnings.length === 0 },
      displayOrigin: this.opts.displayOrigin ?? (this.opts.baseURL ? new URL(this.opts.baseURL).host : ''),
      cursorStart: { x: Math.round(this.size.width * 0.5), y: Math.round(this.size.height * 0.45) },
      steps,
      events: [...this.moves.map((m) => ({ type: 'move' as const, ...m })), ...this.events].sort(eventTime),
    };
    const eventsFile = join(this.outDir, 'events.json');
    writeFileSync(eventsFile, JSON.stringify(out, null, 2));
    this.finished = true;
    await this.dispose();
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

  /** 目標中心（影片像素）；不在安全區（網址列下、字幕條上）就先平滑捲動。boundingBox 是 CSS px。 */
  private async targetOf(locator: Locator): Promise<Point> {
    await locator.waitFor({ state: 'visible', timeout: LOCATOR_TIMEOUT_MS }).catch((e) => this.fail(locator, e));
    let box = await locator.boundingBox();
    if (!box) throw new Error(`找不到元素位置：${locator}`);
    const top = 40 / this.zoom;
    const bottom = this.css.height - CAPTION_SAFE / this.zoom;
    const cy = box.y + box.height / 2;
    if (cy < top || cy > bottom) {
      await this.smoothScroll(cy - this.css.height * 0.42);
      box = await locator.boundingBox();
      if (!box || box.y + box.height / 2 < 0 || box.y + box.height / 2 > this.css.height) {
        await locator.scrollIntoViewIfNeeded();
        await this.wait_(200);
        box = await locator.boundingBox();
      }
      if (!box) throw new Error(`捲動後找不到元素：${locator}`);
      const ny = box.y + box.height / 2;
      if (ny > bottom) console.warn(`［${this.current?.caption ?? '步驟外'}］${locator} 捲不上來，會被字幕條蓋住（頁面底部空間不夠）`);
    }
    return this.toVideo({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
  }

  private toVideo(p: Point): Point {
    return { x: Math.round(p.x * this.zoom), y: Math.round(p.y * this.zoom) };
  }

  /** 記下一段緩動移動並真的等它走完，最後把真滑鼠放到終點（讓 hover 樣式在游標抵達時出現）。 */
  private async moveTo(to: Point): Promise<void> {
    const m = planMove(this.cursor, to, this.now());
    if (m.endMs > m.startMs) {
      this.moves.push(m);
      await this.wait_(m.endMs - m.startMs);
    }
    this.cursor = { ...to };
    await this.page.mouse.move(to.x / this.zoom, to.y / this.zoom, { steps: 4 });
  }

  /** 移動途中版面若有位移（黏頂列、圖片載入），補一小段修正。 */
  private async settleOn(locator: Locator): Promise<void> {
    const box = await locator.boundingBox();
    if (!box) return;
    const p = this.toVideo({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
    const z = this.zoom;
    const inside = Math.abs(p.x - this.cursor.x) < (box.width / 2) * z - 2 && Math.abs(p.y - this.cursor.y) < (box.height / 2) * z - 2;
    if (!inside) await this.moveTo(p);
  }

  /** dy 是 CSS px；捲動時長照畫面上移動的距離（影片像素）算。 */
  private async smoothScroll(dy: number): Promise<void> {
    if (Math.abs(dy) < 4) return;
    const ms = Math.round(Math.min(1400, Math.max(500, Math.abs(dy) * this.zoom * 0.9)));
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
    await this.wait_(150);
    this.events.push({ type: 'scroll', startMs, endMs: this.now(), dy: Math.round(moved * this.zoom) });
  }

  /** 給測試與後製參考：時間 t 的游標位置。 */
  cursorAt(t: number): Point {
    return cursorAt(this.moves, { x: Math.round(this.size.width * 0.5), y: Math.round(this.size.height * 0.45) }, t);
  }
}

function eventTime(e: ChapterEvent): number {
  return 'atMs' in e ? e.atMs : e.startMs;
}
