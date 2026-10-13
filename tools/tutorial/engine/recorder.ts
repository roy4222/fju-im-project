// 錄影 API：照劇本操作瀏覽器、錄乾淨畫面（沒有真游標），同時記下每個動作的時間與座標。
//
//   const browser = await launchTutorialBrowser();
//   const page = await newTutorialPage(browser);
//   const t = await startChapter({ page, id: '3-3', chapter: '學生｜繳交作業', baseURL });
//   try {
//     await t.step({ caption: '打開作業頁', narration: '…完整配音…', status: { kind: 'warn', say: '截止提醒還沒做', evidence: 'story-2 第 39 步' } }, async () => {
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
import { chromium, type Browser, type CDPSession, type Frame, type Locator, type Page, type Request } from 'playwright';
import { cursorAt, planMove, type Move, type Point } from './cursor.ts';
import { normalizeStatus, type ChapterEvent, type ChapterEvents, type StatusKind, type StepRecord, type StepStatus } from './events.ts';
import { captureQuality, cfrSlots, GAP_SEVERE_MS, GAP_WARN_MS, timeFrames, toChapterMs, type CaptureQuality, type Pause, type RawFrame } from './frames.ts';
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
/** 點擊後最多等多久讓換頁完成（等的期間影片停在舊頁＋波紋）。 */
const NAV_WAIT_MS = 8000;
/** 錄影中每隔這麼久抽查一次畫面內有沒有還沒載好的圖片（記進 quality、不中止）。 */
const IMAGE_CHECK_MS = 100;

/** 點擊後監看換頁（送滑鼠事件前就裝上，否則同步的 SPA 換頁會漏掉）。 */
type NavWatch = {
  /** 裝上監看的那一刻（滑鼠還沒按下去）：偵測到換頁就從這一刻起暫停，新頁的任何畫面都不可能比它早。 */
  startWall: number;
  navigated: boolean;
  /** 是這次換頁讓計時暫停的（不是在別人的 offRecord 裡）。 */
  autoPaused: boolean;
  /** 已記下的點擊事件：偵測到換頁後把它對到暫停那一刻。 */
  clickEvent: { atMs: number } | null;
};

export type StepOptions = {
  /** 字幕：短句。 */
  caption: string;
  /** 配音：完整句子；省略時不配音，步驟長度由動作決定。 */
  narration?: string;
  /**
   * 右上角狀態標記，只在這一步出現。新寫法 `{ kind, say?, evidence? }`：畫面只顯示圖示＋白話 say
   * （ok 沒寫 say →「✅ 正常」、pending →「🟡 等你決定：」＋say；超過 22 字截斷），evidence 只進 events.json 與 assemble 產出。
   * 舊寫法 `status: 'ok', note: '…'` 仍可用，note 視為 evidence、不上畫面。
   */
  status?: StatusKind | StepStatus;
  /** 舊寫法：狀態的依據（等同新寫法的 evidence）。 */
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
  /** 最多等多久，預設 30 秒（通常在暫停中等，不佔影片時間）；超過會警告並記在 events.json（strict 時改成報錯）。 */
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

/** 頁面內記錄 long task（主執行緒卡住 ≥ 50 ms）的觀察器：用來分辨「網頁自己卡」與「截圖跟不上」。 */
const JANK_OBSERVER = `(() => {
  if (window.__tutJank) return;
  window.__tutJank = [];
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__tutJank.push([performance.timeOrigin + e.startTime, e.duration]);
      if (window.__tutJank.length > 300) window.__tutJank.splice(0, 150);
    }).observe({ type: 'longtask', buffered: true });
  } catch {}
})()`;

const PERMANENT_CDP_ERROR = /Target closed|Session closed|has been closed|No target with given id|Target page, context or browser|crashed/i;

/** 頁面內：畫面上看得到、但還沒載好的圖片（網址）。 */
const UNLOADED_IMAGES = `(() => {
  const vw = innerWidth, vh = innerHeight, out = [];
  for (const img of document.images) {
    if (img.complete) continue;
    const r = img.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw && getComputedStyle(img).visibility !== 'hidden') out.push(img.currentSrc || img.src);
  }
  return out;
})()`;

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
  private watching: Promise<void> | null = null;
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
  /** 最近的動作（錯誤訊息用）。 */
  private lastAction = '—';
  /** 點擊後網頁可能忙著更新（換頁、載資料）的時間點（牆上時間）。 */
  private actionBusyUntil = 0;
  private readonly onClose = () => this.abort(new Error('錄影中分頁被關閉'));
  private readonly onCrash = () => this.abort(new Error('錄影中分頁當掉'));
  private readonly onNav = (f: Frame) => {
    if (f !== this.page.mainFrame()) return;
    this.navAt.push(Date.now());
    // 點擊引發的換頁（整頁載入、pushState 都會發 framenavigated）：從點擊那一刻起暫停計時，等新頁穩定再繼續
    if (this.navWatch) this.navDetected(this.navWatch);
    this.noteUrl();
  };
  private navWatch: NavWatch | null = null;
  /** 進行中的網路請求（waitStable 判斷網路安靜；長連線不算）。 */
  private readonly inflight = new Set<Request>();
  private readonly onReqStart = (r: Request) => {
    if (r.resourceType() !== 'websocket' && r.resourceType() !== 'eventsource') this.inflight.add(r);
  };
  private readonly onReqEnd = (r: Request) => {
    this.inflight.delete(r);
  };
  /** 主框架換頁的時間（牆上時間），判斷截圖空檔是不是換頁造成的。 */
  private readonly navAt: number[] = [];
  /** 網頁自己卡住造成的截圖空檔（牆上時間；不中止，收尾時換成章節時間記在 events.json）。 */
  private readonly pageJank: { fromWall: number; toWall: number; reason: string; url: string }[] = [];
  /** 錄影中抽查到畫面內有還沒載好的圖片的時刻（牆上時間）。 */
  private readonly unloadedSeen: { wallMs: number; count: number; sample: string; url: string }[] = [];

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
    this.page.on('request', this.onReqStart);
    this.page.on('requestfinished', this.onReqEnd);
    this.page.on('requestfailed', this.onReqEnd);
    await this.page.addInitScript(JANK_OBSERVER);
    await this.page.evaluate(JANK_OBSERVER).catch(() => {});
    // 只有「錄影」這段佔全機名額（render 不佔）；滿了就在這裡排隊
    this.slot = await acquireRecordSlot({ label: this.outDir, signal: this.abortCtl.signal, ...this.opts.slots });
    this.check();
    // 連續用 CDP 截圖（實際像素 1920 寬）；Playwright 的 screencast 只給 CSS 大小的影格
    this.cdp = await this.page.context().newCDPSession(this.page);
    this.t0Wall = Date.now();
    this.capturing = this.captureLoop();
    this.watching = this.imageWatch();
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
    await Promise.race([Promise.allSettled([this.capturing, this.watching]), sleep(3000)]);
    await this.cdp?.detach().catch(() => {});
    this.slot?.release();
    this.page.off('close', this.onClose);
    this.page.off('crash', this.onCrash);
    this.page.off('framenavigated', this.onNav);
    this.page.off('request', this.onReqStart);
    this.page.off('requestfinished', this.onReqEnd);
    this.page.off('requestfailed', this.onReqEnd);
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
    let prev: { mid: number; t1: number; pauses: number } | null = null;
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
        // 暫停中（換頁、等穩定、登入）截不到沒關係：新頁還沒畫出第一格前本來就沒有畫面；只在錄影中計時
        if (this.pausedAt != null) {
          failingSince = 0;
          await sleep(100);
          continue;
        }
        failingSince ||= t0;
        if (t0 - failingSince > CAPTURE_GIVE_UP_MS) {
          return this.abort(new Error(`［${this.current?.caption ?? '步驟外'}］${this.page.url()} 錄影中連續 ${CAPTURE_GIVE_UP_MS / 1000} 秒截不到畫面：${msg}`));
        }
        await sleep(15); // 換頁中可能截不到，稍後再試
        continue;
      }
      failingSince = 0;
      const t1 = clock();
      const mid = (t0 + t1) / 2;
      // 錄進影片的時間（不在暫停中、中間也沒暫停過）若兩張間隔過大就中止：影片會明顯卡頓、對不齊
      if (prev && this.pausedAt == null && prev.pauses === this.pauses.length && mid - prev.mid > maxGap) {
        // 時間花在哪：截圖迴圈自己閒置（程序／機器忙到排不到）→ 中止；
        // 截圖請求本身等很久（Chrome 沒有新畫面可給）且是網頁造成的（long task、換頁、剛點擊後的更新）→ 停格是真實的，記下來繼續錄
        const idle = t0 - prev.t1;
        const reason = idle > maxGap / 2 ? null : await this.pageCausedGap(prev.mid, mid);
        if (reason) {
          this.pageJank.push({ fromWall: prev.mid, toWall: mid, reason, url: this.page.url() });
        } else return this.abort(
          new Error(
            `［${this.current?.caption ?? '步驟外'}］${this.page.url()} 截圖間隔 ${Math.round(mid - prev.mid)} ms（上限 ${maxGap} ms，最近動作：${this.lastAction}）：網頁沒有卡住、是截圖跟不上，機器太忙或同時錄影的路數太多，請重錄這一段`,
          ),
        );
      }
      prev = this.pausedAt == null ? { mid, t1, pauses: this.pauses.length } : null;
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
   * 錄影中每 IMAGE_CHECK_MS 抽查畫面內有沒有還沒載好的圖片（例如換頁後沒等穩定就繼續錄，灰色佔位圖會進影片）；
   * 收尾時合併成時間段寫進 quality.unloadedImages 並標 ok=false。暫停中不抽查。
   */
  private async imageWatch(): Promise<void> {
    while (!this.stopCapture) {
      await sleep(IMAGE_CHECK_MS);
      if (this.stopCapture || this.pausedAt != null) continue;
      const wallMs = Date.now();
      const urls = (await this.page.evaluate(UNLOADED_IMAGES).catch(() => [])) as string[];
      if (urls.length && this.pausedAt == null) this.unloadedSeen.push({ wallMs, count: urls.length, sample: urls[0], url: this.page.url() });
    }
  }

  /** 抽查到的「還沒載好的圖片」合併成章節時間的時間段；落在暫停裡的（點擊後換頁是回溯暫停）不算。 */
  private unloadedSpans(): NonNullable<CaptureQuality['unloadedImages']> {
    const spans: NonNullable<CaptureQuality['unloadedImages']> = [];
    for (const s of this.unloadedSeen) {
      if (this.pauses.some((p) => s.wallMs > p.startWall && s.wallMs < p.endWall)) continue;
      const ms = Math.round(toChapterMs(s.wallMs, this.t0Wall, this.pauses));
      const last = spans.at(-1);
      if (last && last.url === s.url && ms - last.toMs <= IMAGE_CHECK_MS * 2.5) {
        last.toMs = ms;
        last.count = Math.max(last.count, s.count);
      } else spans.push({ fromMs: ms, toMs: ms, count: s.count, sample: s.sample, url: s.url });
    }
    return spans;
  }

  /** 截圖空檔 [from, to]（牆上時間）是不是網頁造成的：期間有主框架換頁、long task，或剛點擊完網頁在更新。 */
  private async pageCausedGap(from: number, to: number): Promise<string | null> {
    if (this.navAt.some((t) => t >= from - 300 && t <= to + 300)) return '換頁';
    const jank = (await this.page.evaluate(() => (window as unknown as { __tutJank?: [number, number][] }).__tutJank ?? []).catch(() => [])) as [number, number][];
    // long task 蓋住空檔的大部分（容許兩邊時鐘差 30 ms）
    const covered = jank.filter(([s, d]) => s < to + 30 && s + d > from - 30).reduce((a, [s, d]) => a + Math.min(to, s + d) - Math.max(from, s), 0);
    if (covered >= (to - from) * 0.5) return `網頁主執行緒卡住（long task ${Math.round(covered)} ms）`;
    if (from <= this.actionBusyUntil) return `點擊後網頁更新（${this.lastAction}）`;
    return null;
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
      await this.endPause();
    }
  }

  private async endPause(): Promise<void> {
    if (this.pausedAt == null) return;
    // 讓暫停期間的最後畫面有機會送出
    await sleep(120);
    this.pauses.push({ startWall: this.pausedAt, endWall: Date.now() });
    this.pausedAt = null;
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
      status: normalizeStatus(opts.status, opts.note),
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
    const { images = true, fonts = true, frames = 2, timeout = 30_000, strict = false } = opts;
    const body = async () => {
      const deadline = Date.now() + timeout;
      const left = () => Math.max(1, deadline - Date.now());
      const problems: string[] = [];
      if (opts.ready) {
        const loc = typeof opts.ready === 'string' ? this.page.getByText(opts.ready).first() : opts.ready;
        await loc.waitFor({ state: 'visible', timeout: left() }).catch(() => problems.push(`等不到 ${loc}`));
      }
      // 反覆確認到三件事同時成立：網路安靜、畫面內圖片／字型載完、連續幾張截圖一樣。
      // （Next.js 會先改網址再換畫面；只檢查一次可能檢查到舊頁）
      let ok = false;
      let why = '';
      while (!ok && Date.now() < deadline) {
        if (!(await this.networkQuiet(300, Math.min(4000, left())))) why = '網路一直沒停';
        if ((fonts || images) && !(await this.assetsReady(fonts, images, left()))) {
          why = fonts && images ? '字型或畫面內圖片沒載完' : images ? '畫面內圖片沒載完' : '字型沒載完';
          continue;
        }
        if (!(await this.framesStable(frames, deadline))) {
          why = `畫面一直在變（連續 ${frames} 張截圖沒有一樣過${await this.changingRegion()}）`;
          continue;
        }
        // 穩定之後再確認一次：期間若又冒出新圖片或新請求就再來一輪
        ok = this.inflight.size === 0 && (!(fonts || images) || (await this.assetsReady(fonts, images, 1)));
        if (!ok) why = '穩定後又有新的載入';
      }
      if (!ok) problems.push(why || '逾時');
      if (problems.length) {
        const msg = `［${this.current?.caption ?? '步驟外'}］${this.page.url()} ${timeout / 1000} 秒內畫面沒穩定：${problems.join('；')}`;
        if (strict) throw new Error(msg);
        console.warn(`注意：${msg}`);
        this.warnings.push(msg);
      }
    };
    await (opts.offRecord ? this.offRecord(body) : body());
  }

  /** 網路安靜：進行中的請求數連續 quietMs 都是 0（自己數，SPA 換頁也算得到）。最多等 maxMs。 */
  private async networkQuiet(quietMs: number, maxMs: number): Promise<boolean> {
    const until = Date.now() + maxMs;
    let quietSince = this.inflight.size === 0 ? Date.now() : 0;
    while (Date.now() < until) {
      if (this.inflight.size === 0) {
        quietSince ||= Date.now();
        if (Date.now() - quietSince >= quietMs) return true;
      } else quietSince = 0;
      await this.wait_(25);
    }
    return false;
  }

  /** 畫面內的圖片都載完並解碼、字型載完（延遲載入的圖改成立即載入）。 */
  private async assetsReady(fonts: boolean, images: boolean, maxMs: number): Promise<boolean> {
    const until = Date.now() + maxMs;
    for (;;) {
      const ready = await this.page
        .evaluate(
          async ({ fonts, images }) => {
            if (fonts && document.fonts.status !== 'loaded') return false;
            if (!images) return true;
            const vw = innerWidth;
            const vh = innerHeight;
            const visible = Array.from(document.images).filter((img) => {
              const r = img.getBoundingClientRect();
              return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw && getComputedStyle(img).visibility !== 'hidden';
            });
            for (const img of visible) if (img.loading === 'lazy') img.loading = 'eager';
            if (!visible.every((img) => img.complete && img.naturalWidth > 0)) return false;
            // 解碼最多等 1 秒（壞圖的 decode 可能永遠不回）
            await Promise.race([Promise.all(visible.map((img) => img.decode().catch(() => {}))), new Promise((r) => setTimeout(r, 1000))]);
            return true;
          },
          { fonts, images },
        )
        .catch(() => false);
      if (ready) return true;
      if (Date.now() >= until) return false;
      await this.wait_(100);
    }
  }

  /** 最後兩張截圖哪裡不一樣（CSS px），給「畫面一直在變」的警告用。 */
  private async changingRegion(): Promise<string> {
    const [a, b] = this.raw.slice(-2).map((f) => f.file);
    if (!a || !b) return '';
    try {
      const { stderr } = await run('ffmpeg', ['-v', 'info', '-i', a, '-i', b, '-filter_complex', '[0][1]blend=all_mode=difference,format=gray,bbox=min_val=24', '-f', 'null', '-']);
      const m = [...stderr.matchAll(/x1:(\d+) x2:(\d+) y1:(\d+) y2:(\d+)/g)].at(-1);
      if (!m) return '';
      const [x1, x2, y1, y2] = m.slice(1).map((v) => Math.round(Number(v) / this.zoom));
      return `；變動範圍約 x ${x1}～${x2}、y ${y1}～${y2}（CSS px）`;
    } catch {
      return '';
    }
  }

  /** 從現在起連續 n 張截圖內容完全一樣。 */
  private async framesStable(n: number, deadline: number): Promise<boolean> {
    const start = this.frameCount;
    while (!(this.frameCount - start >= n && this.sameRun >= n - 1)) {
      if (Date.now() > deadline) return false;
      await this.wait_(30);
    }
    return true;
  }

  async hover(locator: Locator): Promise<void> {
    this.lastAction = `hover ${locator}`;
    this.check();
    await this.moveTo(await this.targetOf(locator));
    await this.settleOn(locator);
  }

  /**
   * 點擊。若因此換頁（連結、整頁載入或 Next.js 的 client-side 換頁）：從點擊那一刻起暫停計時，
   * 等新頁穩定（圖片、字型、版面）再繼續——影片從「點下去」直接切到載好的新頁。傳 false 不等。
   */
  async click(locator: Locator, stable: WaitStableOptions | false = {}): Promise<void> {
    await this.hover(locator);
    await this.wait_(150);
    const before = this.page.url();
    this.lastAction = `click ${locator}`;
    // 會不會換頁：點的是指向別頁的連結，或點下去後送出了換頁請求
    const linkTo = await locator
      .evaluate((el) => {
        const a = el.closest('a[href]') as HTMLAnchorElement | null;
        if (!a || (a.target && a.target !== '_self')) return null;
        const u = new URL(a.href, location.href);
        return u.origin + u.pathname + u.search === location.origin + location.pathname + location.search ? null : u.href;
      })
      .catch(() => null);
    let navRequested = false;
    const onReq = (r: Request) => {
      if (r.frame() !== this.page.mainFrame()) return;
      if (r.resourceType() === 'document' || /[?&]_rsc=/.test(r.url()) || r.headers()['rsc'] === '1') navRequested = true;
    };
    this.page.on('request', onReq);
    // 送滑鼠事件之前就開始監看換頁：Next.js 的 client-side 換頁（pushState）在 click 事件裡同步發生，
    // framenavigated 會跟 mouse.up() 的回應同時到，晚一步才裝監看就會漏掉、把載到一半的新頁錄進去
    const watch: NavWatch = { startWall: Date.now(), navigated: false, autoPaused: false, clickEvent: null };
    if (stable !== false) this.navWatch = watch;
    try {
      this.actionBusyUntil = Date.now() + 2000;
      await this.page.mouse.down();
      await this.wait_(70);
      await this.page.mouse.up();
      // 記在放開滑鼠（click 事件在這時觸發）且頁面畫出下一格之後：波紋與頁面反應同一格出現。
      // 換頁已經讓計時暫停的話，now() 就是暫停那一刻（影片切到新頁的那一格）
      await this.nextPaint();
      const clickEvent = { type: 'click' as const, atMs: this.now(), x: this.cursor.x, y: this.cursor.y };
      this.events.push(clickEvent);
      watch.clickEvent = clickEvent;
      await this.wait_(350);
      if (stable !== false && (linkTo || navRequested)) {
        // 等換頁發生（偵測到時 navDetected 會暫停計時）
        const until = Date.now() + NAV_WAIT_MS;
        while (!watch.navigated && this.page.url() === before && Date.now() < until) await this.wait_(30);
      }
      // 網址變了卻沒收到 framenavigated（保險）
      if (stable !== false && !watch.navigated && this.page.url() !== before) this.navDetected(watch);
    } finally {
      this.page.off('request', onReq);
      this.navWatch = null;
    }
    if (watch.navigated) {
      if (watch.autoPaused) {
        try {
          await this.page.waitForLoadState('load').catch(() => {});
          await this.waitStable({ ...(stable || {}), offRecord: false });
        } finally {
          await this.endPause();
        }
      } else await this.waitStable({ ...(stable || {}), offRecord: true }); // 已在 offRecord 裡：照樣等穩定
    }
    this.noteUrl();
  }

  /**
   * 點擊後偵測到換頁（framenavigated，或網址變了）：從裝上監看那一刻（滑鼠按下去之前）起暫停計時——
   * 新頁的任何畫面都不可能比它早，所以載到一半的畫面絕不會進影片；之後等新頁穩定再繼續。
   * 暫停是回溯的：點擊到偵測之間已經截下的影格，收尾時會整段丟掉（只留暫停中最後一張當新頁的第一格）。
   * 點擊事件也對到暫停那一刻，所以 click、url 與影片切到新頁的那一格是同一個時間。
   */
  private navDetected(w: NavWatch): void {
    if (w.navigated) return;
    w.navigated = true;
    if (this.pausedAt == null) {
      this.pausedAt = w.startWall;
      w.autoPaused = true;
    }
    if (w.clickEvent) w.clickEvent.atMs = toChapterMs(this.pausedAt, this.t0Wall, this.pauses);
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
    this.lastAction = `scroll ${target}`;
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
    await Promise.race([this.watching, sleep(1500)]);
    this.check(); // 收尾前一刻若中止（例如間隔過大）就報錯
    await this.cdp?.detach().catch(() => {});
    // 錄影結束就歸還名額：後面的編碼與 render 不佔名額
    this.slot?.release();
    this.page.off('close', this.onClose);
    this.page.off('crash', this.onCrash);
    this.page.off('framenavigated', this.onNav);
    this.page.off('request', this.onReqStart);
    this.page.off('requestfinished', this.onReqEnd);
    this.page.off('requestfailed', this.onReqEnd);

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
    // 空檔換成章節時間；被回溯暫停（點擊後換頁）吃掉、影片裡看不到的就不算
    const chapter = (wall: number) => toChapterMs(wall, this.t0Wall, this.pauses);
    const pageJank = this.pageJank
      .map((j) => ({ atMs: Math.round(chapter(j.toWall)), gapMs: Math.round(chapter(j.toWall) - chapter(j.fromWall)), reason: j.reason, url: j.url }))
      .filter((j) => j.gapMs > GAP_WARN_MS);
    const jankWarnings = pageJank.map((j) => `章節時間 ${(j.atMs / 1000).toFixed(1)} 秒：${j.reason}，畫面停了 ${j.gapMs} ms（${j.url}）`);
    const unloadedImages = this.unloadedSpans();
    const unloadedWarnings = unloadedImages.map(
      (u) =>
        `章節時間 ${(u.fromMs / 1000).toFixed(1)}～${(u.toMs / 1000).toFixed(1)} 秒：畫面內有還沒載好的圖片（${u.count} 張，例如 ${u.sample}；${u.url}），` +
        '這一段請用 waitStable 或 goto／click 自動等穩定',
    );
    for (const w of [...quality.warnings, ...jankWarnings, ...unloadedWarnings]) console.warn(`注意（截圖品質）：${w}`);

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
      quality: {
        ...quality,
        pageJank,
        unloadedImages,
        warnings: [...quality.warnings, ...jankWarnings, ...unloadedWarnings, ...this.warnings],
        ok: quality.ok && this.warnings.length === 0 && unloadedImages.length === 0,
      },
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
