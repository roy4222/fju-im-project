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
import { cpus, freemem, loadavg, totalmem } from 'node:os';
import { basename, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { chromium, type Browser, type CDPSession, type Frame, type Locator, type Page, type Request } from 'playwright';
import { cursorAt, planMove, type Move, type Point } from './cursor.ts';
import { normalizeStatus, PRESS_HINT_MS, type ChapterEvent, type ChapterEvents, type StatusKind, type StepRecord, type StepStatus } from './events.ts';
import { captureQuality, cfrSlots, GAP_SEVERE_MS, GAP_WARN_MS, timeFrames, toChapterMs, type CaptureQuality, type LoadSample, type Pause, type RawFrame, type SystemLoad } from './frames.ts';
import { acquireRecordSlot, claimOutDir, DEFAULT_OUT_ROOT, FAILED_MARK, newRunDir, RECORDING_MARK, type RecordSlot, type SlotOptions } from './runs.ts';
import { ttsFromEnv, type TtsProvider } from './tts.ts';

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
/** 下方字幕帶高度（影片像素）：字幕、按鍵提示都在這裡，永遠不蓋到頁面。頁面區＝影片高 − 網址列 − 字幕帶。 */
export const CAPTION_HEIGHT = 120;
/**
 * 網頁放大倍率：CSS 1280×587 的視窗以 1.5 倍實際像素渲染，錄成 1920×880 的頁面區；
 * 網頁正文 15px 在 1080p 裡約 22px（手機、筆電上看得清楚），版面仍是桌機版。
 *
 * 用瀏覽器層級的 --force-device-scale-factor，而不是 Playwright 的 deviceScaleFactor 模擬：
 * 模擬時 screencast 與 CDP 截圖都只給 CSS 大小（1280 寬）的影格；若另開 session 設裝置參數，
 * 截圖雖是 1920 寬，滑鼠座標卻會被再除一次 1.5。
 */
export const DEFAULT_ZOOM = 1.5;
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
/** 點擊後最多等多久讓換頁或這一下發出的請求完成。 */
const NAV_WAIT_MS = 8000;
/** 點的是別頁的連結時，至少給它這麼久開始換頁（換頁一直沒來就不等了；這段等待不進影片）。 */
const NAV_GRACE_MS = 1500;
/**
 * 進行中超過這麼久的請求視為「不會結束的」（長連線、或 Playwright 漏了結束通知），不再當成網路沒安靜。
 * 實測：換頁那一刻還在飛的 fetch（例如 Next.js 的 RSC prefetch）Playwright 1.63 不會再發 requestfinished／requestfailed。
 */
const STALE_REQUEST_MS = 10_000;
/** 錄影中每隔這麼久抽查一次畫面內有沒有還沒載好的圖片（記進 quality、不中止）。 */
const IMAGE_CHECK_MS = 100;
/** 每隔這麼久記一次系統負載（loadavg、可用記憶體），寫進 quality.system。 */
const LOAD_SAMPLE_MS = 5000;

/**
 * 頁面內的平滑捲動（scrollIntoView 與 smoothScroll 共用；以字串傳進頁面，用 new Function 還原）：
 * 把 sc 捲到 (left, top)，easeInOutSine，時長照距離（speed＝每 CSS px 幾 ms，500～1400 ms），回傳實際位移。
 */
const SCROLL_ANIMATE_JS = `(sc, left, top, speed) => new Promise((resolve) => {
  const ease = (u) => (1 - Math.cos(Math.PI * u)) / 2;
  const x0 = sc.scrollLeft, y0 = sc.scrollTop;
  const tx = Math.max(0, Math.min(left, sc.scrollWidth - sc.clientWidth));
  const ty = Math.max(0, Math.min(top, sc.scrollHeight - sc.clientHeight));
  const dist = Math.max(Math.abs(tx - x0), Math.abs(ty - y0));
  if (dist < 1) return resolve({ dx: 0, dy: 0 });
  const ms = Math.min(1400, Math.max(500, dist * speed));
  const t0 = performance.now();
  const f = (now) => {
    const u = Math.min(1, (now - t0) / ms);
    sc.scrollTo({ left: x0 + (tx - x0) * ease(u), top: y0 + (ty - y0) * ease(u), behavior: 'instant' });
    if (u < 1) requestAnimationFrame(f);
    else resolve({ dx: sc.scrollLeft - x0, dy: sc.scrollTop - y0 });
  };
  requestAnimationFrame(f);
})`;

/**
 * 可見區 r（viewport 座標）四邊被固定元素蓋掉多少 CSS px（以字串傳進頁面；t.click 捲動用，#412）：
 * position 是 sticky 或 fixed、對應那一邊有設偏移（top／bottom／left／right 不是 auto）、貼著那一邊（多個疊起來的
 * 也算，例如黏頂列下面再黏表頭）、而且跟 el 同一欄（上下邊）或同一列（左右邊）。el 自己、它的祖先與子孫、
 * pointer-events: none 或看不見的、比可見區一半還大的（對話框遮罩之類）都不算。
 */
export const STICKY_INSETS_JS = `(el, r) => {
  const e = el.getBoundingClientRect();
  const w = r.right - r.left, h = r.bottom - r.top;
  const spans = { top: [], bottom: [], left: [], right: [] };
  for (const s of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(s);
    if (cs.position !== 'sticky' && cs.position !== 'fixed') continue;
    if (s.contains(el) || el.contains(s)) continue;
    if (cs.visibility !== 'visible' || cs.pointerEvents === 'none' || Number(cs.opacity) === 0) continue;
    const b = s.getBoundingClientRect();
    if (b.width < 1 || b.height < 1 || b.right <= r.left || b.left >= r.right || b.bottom <= r.top || b.top >= r.bottom) continue;
    const sameCol = b.left < e.right && b.right > e.left;
    const sameRow = b.top < e.bottom && b.bottom > e.top;
    if (sameCol && b.height < h / 2) {
      if (cs.top !== 'auto') spans.top.push([b.top - r.top, b.bottom - r.top]);
      if (cs.bottom !== 'auto') spans.bottom.push([r.bottom - b.bottom, r.bottom - b.top]);
    }
    if (sameRow && b.width < w / 2) {
      if (cs.left !== 'auto') spans.left.push([b.left - r.left, b.right - r.left]);
      if (cs.right !== 'auto') spans.right.push([r.right - b.right, r.right - b.left]);
    }
  }
  const inset = (list) => {
    let d = 0;
    for (const [from, to] of list.sort((a, b) => a[0] - b[0])) if (from <= d + 2) d = Math.max(d, to);
    return d;
  };
  return { top: inset(spans.top), bottom: inset(spans.bottom), left: inset(spans.left), right: inset(spans.right) };
}`;

function loadSample(): LoadSample {
  const [l1, l5] = loadavg();
  return { at: Date.now(), loadavg1: Math.round(l1 * 100) / 100, loadavg5: Math.round(l5 * 100) / 100, freeMemMB: Math.round(freemem() / 1048576) };
}

/** 點擊後監看換頁（送滑鼠事件前就裝上，否則同步的 SPA 換頁會漏掉）。 */
type NavWatch = {
  /** 裝上監看的那一刻（滑鼠還沒按下去）：偵測到換頁就從這一刻起暫停，新頁的任何畫面都不可能比它早。 */
  startWall: number;
  /** 點擊前的網址：判斷之後的 framenavigated 是真的換頁還是同文件改網址。 */
  before: string;
  /** 真的換頁了（整頁載入、或路徑變了的 SPA 換頁）。 */
  navigated: boolean;
  /** 只是同文件改了網址（篩選改查詢字串、replaceState、改 hash）：不算換頁，UI 過程照錄。 */
  sameDoc: boolean;
  /** 主框架送出了整頁請求（整頁載入，就算網址相同也算換頁）。 */
  docRequested: boolean;
  /** 是這次點擊讓計時暫停的（不是在別人的 offRecord 裡）。 */
  autoPaused: boolean;
  /** 已記下的動作事件（click 或 press）：偵測到換頁後把它對到暫停那一刻。 */
  actionEvent: { atMs: number } | null;
};

/** 只有 origin 或路徑不同才算換頁；查詢字串、hash 不算（篩選按鈕只改查詢字串時，畫面過程要保留）。 */
export function isPageChange(before: string, after: string): boolean {
  try {
    const a = new URL(before);
    const b = new URL(after);
    return a.origin !== b.origin || a.pathname !== b.pathname;
  } catch {
    return before !== after;
  }
}

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
  /** 最多等多久，預設 30 秒（在暫停中等，不佔影片時間）；超過會警告並記在 events.json（strict 時改成報錯）。 */
  timeout?: number;
  strict?: boolean;
  /** 已無作用：等待一律不進影片（逾時也一樣）。留著是為了舊劇本相容。 */
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
  /** 輸出影片大小，預設 1920×1080；頁面區是寬 ×（高 − 網址列 − 字幕帶），CSS viewport 再除以 zoom。 */
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

/** 影片頁面區（像素）＝影片大小扣掉上方網址列與下方字幕帶。 */
export function pageArea(viewport: { width: number; height: number }): { width: number; height: number } {
  return { width: viewport.width, height: viewport.height - CHROME_HEIGHT - CAPTION_HEIGHT };
}

/** 影片頁面區對應的 CSS viewport。高度無條件進位，多出的一兩列像素在輸出時裁掉。 */
export function cssViewport(viewport: { width: number; height: number }, zoom: number): { width: number; height: number } {
  const area = pageArea(viewport);
  return { width: Math.round(area.width / zoom), height: Math.ceil(area.height / zoom) };
}

/** 開一個適合錄影的分頁（真實視窗、不做 viewport 模擬，視窗內容區調成 CSS 1280×587）、繁中、台北時區。 */
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
    // 點擊引發的換頁：整頁載入（有主框架的 document 請求）或路徑變了的 SPA 換頁才算，從點擊那一刻起暫停計時、等新頁穩定再繼續；
    // 同文件只改查詢字串／hash（篩選按鈕、replaceState）不算換頁，畫面過程照錄
    if (this.docRequestAt > this.docCommitAt) this.docCommitAt = Date.now(); // 整頁載入 commit 了（pushState 沒有 document 請求）
    const w = this.navWatch;
    if (w) {
      if (w.docRequested || isPageChange(w.before, f.url())) this.navDetected(w);
      else w.sameDoc = true;
    }
    this.noteUrl();
  };
  private navWatch: NavWatch | null = null;
  /** 進行中的網路請求 → 開始時間與是否主框架（waitStable 判斷網路安靜；長連線不算）。 */
  private readonly inflight = new Map<Request, { at: number; main: boolean }>();
  /** 最近一次主框架整頁請求、以及新文件 commit（framenavigated）的時間：commit 之前就在飛的請求都屬於舊文件，整頁載入後一律清掉。 */
  private docRequestAt = 0;
  private docCommitAt = 0;
  private readonly staleNoted = new Set<Request>();
  private readonly onReqStart = (r: Request) => {
    const type = r.resourceType();
    if (type === 'websocket' || type === 'eventsource') return;
    const main = this.isMainFrame(r);
    if (type === 'document' && main) this.docRequestAt = Date.now();
    this.inflight.set(r, { at: Date.now(), main });
  };
  private readonly onReqEnd = (r: Request) => {
    this.inflight.delete(r);
  };
  /**
   * 整頁載入後（只有整頁載入會發 domcontentloaded）：換頁前就在飛的請求 Playwright 不會再通知結束，
   * 留在 inflight 裡會讓 waitStable 一直以為網路沒停、等到逾時，所以一律清掉。
   * 以新文件 commit 的時間為界：舊文件在送出整頁請求之後、commit 之前還可能再發請求（例如 Next.js 的 prefetch），那些也是死的；
   * 新文件自己的請求都在 commit 之後才開始。
   */
  private readonly onDocLoaded = () => {
    const cut = Math.max(this.docRequestAt, this.docCommitAt);
    for (const [r, { at }] of this.inflight) if (at < cut) this.inflight.delete(r);
  };
  /** 主框架換頁的時間（牆上時間），判斷截圖空檔是不是換頁造成的。 */
  private readonly navAt: number[] = [];
  /** 網頁自己卡住造成的截圖空檔（牆上時間；不中止，收尾時換成章節時間記在 events.json）。 */
  private readonly pageJank: { fromWall: number; toWall: number; reason: string; url: string }[] = [];
  /** 錄影中抽查到畫面內有還沒載好的圖片的時刻（牆上時間）。 */
  private readonly unloadedSeen: { wallMs: number; count: number; sample: string; url: string }[] = [];
  /** 系統負載：開始、峰值（最高 loadavg1、最低可用記憶體）。 */
  private loadStart: LoadSample = loadSample();
  private loadPeak = { loadavg1: this.loadStart.loadavg1, freeMemMB: this.loadStart.freeMemMB };
  private loadSampledAt = 0;

  private sampleLoad(): void {
    const s = loadSample();
    this.loadSampledAt = Date.now();
    this.loadPeak = { loadavg1: Math.max(this.loadPeak.loadavg1, s.loadavg1), freeMemMB: Math.min(this.loadPeak.freeMemMB, s.freeMemMB) };
  }

  /** 停止截圖那一刻的最終快照：之後的 ffmpeg 編碼、後製負載不算進去。 */
  private loadFinal: SystemLoad | null = null;

  private systemLoad(): SystemLoad {
    this.sampleLoad();
    return { cpus: cpus().length, totalMemMB: Math.round(totalmem() / 1048576), start: this.loadStart, peak: this.loadPeak, end: loadSample() };
  }

  constructor(opts: ChapterOptions) {
    this.opts = opts;
    this.page = opts.page;
    this.id = opts.id ?? (opts.number != null ? String(opts.number) : undefined);
    this.outDir = opts.outDir ?? newRunDir(opts.outRoot ?? DEFAULT_OUT_ROOT, `${this.id ?? ''} ${opts.chapter}`);
    this.tts = opts.tts ?? ttsFromEnv();
    const vp = opts.viewport ?? { width: 1920, height: 1080 };
    this.size = pageArea(vp);
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
    this.page.on('domcontentloaded', this.onDocLoaded);
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
    this.loadStart = loadSample();
    this.loadPeak = { loadavg1: this.loadStart.loadavg1, freeMemMB: this.loadStart.freeMemMB };
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
    this.page.off('domcontentloaded', this.onDocLoaded);
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
      if (Date.now() - this.loadSampledAt >= LOAD_SAMPLE_MS) this.sampleLoad();
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
      await this.waitStable(stable);
    });
  }

  /**
   * 等畫面穩定：指定元素出現、網路安靜、字型載入、畫面內圖片解碼完成、連續幾張截圖完全一樣。
   * goto 與點擊後換頁會自動呼叫一次；也可以在步驟裡自己呼叫。**等的過程一律不進影片**（暫停計時），
   * 逾時也一樣：只在指令列與 events.json 留警告，影片直接切到等完當下的畫面。
   */
  async waitStable(opts: WaitStableOptions = {}): Promise<void> {
    this.check();
    const { images = true, fonts = true, frames = 2, timeout = 30_000, strict = false } = opts;
    await this.offRecord(async () => {
      const deadline = Date.now() + timeout;
      const left = () => Math.max(1, deadline - Date.now());
      const problems: string[] = [];
      if (opts.ready) {
        const loc = typeof opts.ready === 'string' ? this.page.getByText(opts.ready).first() : opts.ready;
        await loc.waitFor({ state: 'visible', timeout: left() }).catch(() => problems.push(`等不到 ${loc}`));
      }
      // 反覆確認到四件事同時成立：網路安靜、畫面內圖片／字型載完、連續幾張截圖一樣、穩定後沒再冒出新載入。
      // （Next.js 會先改網址再換畫面；只檢查一次可能檢查到舊頁。）哪一項最後卡住就報哪一項，不要都寫成「畫面一直在變」。
      let ok = false;
      let stuck: 'network' | 'assets' | 'frames' | 'reload' | null = null;
      while (!ok && Date.now() < deadline) {
        if (!(await this.networkQuiet(300, Math.min(4000, left())))) {
          stuck = 'network';
          continue;
        }
        if ((fonts || images) && !(await this.assetsReady(fonts, images, Math.min(4000, left())))) {
          stuck = 'assets';
          continue;
        }
        if (!(await this.framesStable(frames, Math.min(3000, left())))) {
          stuck = 'frames';
          continue;
        }
        ok = this.pendingRequests().length === 0 && (!(fonts || images) || (await this.assetsReady(fonts, images, 1)));
        if (!ok) stuck = 'reload';
      }
      if (!ok) {
        const why = {
          network: () => `網路一直沒停（進行中：${this.pendingSummary()}）`,
          assets: () => (fonts && images ? '字型或畫面內圖片沒載完' : images ? '畫面內圖片沒載完' : '字型沒載完'),
          frames: async () => `畫面一直在變（連續 ${frames} 張截圖沒有一樣過${await this.changingRegion()}）`,
          reload: () => '穩定後又有新的載入',
        };
        problems.push(stuck ? await why[stuck]() : '逾時');
      }
      if (problems.length) {
        const msg = `［${this.current?.caption ?? '步驟外'}］${this.page.url()} ${timeout / 1000} 秒內畫面沒穩定：${problems.join('；')}（這段等待沒有錄進影片）`;
        if (strict) throw new Error(msg);
        console.warn(`注意：${msg}`);
        this.warnings.push(msg);
      }
    });
  }

  private isMainFrame(r: Request): boolean {
    try {
      return r.frame() === this.page.mainFrame();
    } catch {
      return false;
    }
  }

  /** 還在等的請求：進行中、而且還沒久到被視為「不會結束的」（超過 STALE_REQUEST_MS 的只在指令列提一次，不再等它）。 */
  private pendingRequests(since = 0): Request[] {
    const now = Date.now();
    const out: Request[] = [];
    for (const [r, { at }] of this.inflight) {
      if (at < since) continue;
      if (now - at >= STALE_REQUEST_MS) {
        if (!this.staleNoted.has(r)) {
          this.staleNoted.add(r);
          console.warn(`注意：${r.resourceType()} ${r.url()} 進行中超過 ${STALE_REQUEST_MS / 1000} 秒，之後不再等它`);
        }
        continue;
      }
      out.push(r);
    }
    return out;
  }

  private pendingSummary(): string {
    const list = this.pendingRequests().map((r) => `${r.resourceType()} ${r.url()}`);
    return list.length ? `${list.slice(0, 4).join('、')}${list.length > 4 ? ` 等 ${list.length} 個` : ''}` : '—';
  }

  /** 這次點擊之後主框架發出、還在飛的請求（判斷點擊的後續有沒有做完）。 */
  private clickRequestsPending(w: NavWatch): number {
    return this.pendingRequests(w.startWall).filter((r) => this.inflight.get(r)?.main).length;
  }

  /** 網路安靜：還在等的請求數連續 quietMs 都是 0（自己數，SPA 換頁也算得到）。最多等 maxMs。 */
  private async networkQuiet(quietMs: number, maxMs: number): Promise<boolean> {
    const until = Date.now() + maxMs;
    let quietSince = this.pendingRequests().length === 0 ? Date.now() : 0;
    while (Date.now() < until) {
      if (this.pendingRequests().length === 0) {
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
      // 兩張 JPEG 內容一樣就會逐位元相同，所以任何差異都是真的在變；門檻放低才看得到很細微的動畫（例如 pulse）
      const { stderr } = await run('ffmpeg', ['-v', 'info', '-i', a, '-i', b, '-filter_complex', '[0][1]blend=all_mode=difference,format=gray,bbox=min_val=6', '-f', 'null', '-']);
      const m = [...stderr.matchAll(/x1:(\d+) x2:(\d+) y1:(\d+) y2:(\d+)/g)].at(-1);
      if (!m) return '';
      const [x1, x2, y1, y2] = m.slice(1).map((v) => Math.round(Number(v) / this.zoom));
      return `；變動範圍約 x ${x1}～${x2}、y ${y1}～${y2}（CSS px）`;
    } catch {
      return '';
    }
  }

  /** 從現在起連續 n 張截圖內容完全一樣（最多等 maxMs）。 */
  private async framesStable(n: number, maxMs: number): Promise<boolean> {
    const start = this.frameCount;
    const until = Date.now() + maxMs;
    while (!(this.frameCount - start >= n && this.sameRun >= n - 1)) {
      if (Date.now() > until) return false;
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
   * 點擊。若因此**真的換頁**（整頁載入，或 Next.js client-side 換到別的路徑）：從點擊那一刻起暫停計時，
   * 等新頁穩定（圖片、字型、版面）再繼續——影片從「點下去」直接切到載好的新頁。
   * 只改查詢字串／hash（篩選按鈕、replaceState）不算換頁：畫面過程照錄，只等這一下發出的請求做完。
   * 點的是別頁的連結卻一直沒換頁時，那段等待也不進影片。傳 false 完全不等。
   */
  async click(locator: Locator, stable: WaitStableOptions | false = {}): Promise<void> {
    await this.hover(locator);
    await this.wait_(150);
    this.lastAction = `click ${locator}`;
    // 點的是不是連結（指到別的路徑才預期換頁；同路徑只改查詢字串的連結照一般點擊處理）
    const linkTo = await locator
      .evaluate((el) => {
        const a = el.closest('a[href]') as HTMLAnchorElement | null;
        if (!a || (a.target && a.target !== '_self')) return null;
        return new URL(a.href, location.href).href;
      })
      .catch(() => null);
    await this.withNavWatch({ stable, linkTo, settleMs: 350 }, async () => {
      await this.page.mouse.down();
      await this.wait_(70);
      await this.page.mouse.up();
      // 記在放開滑鼠（click 事件在這時觸發）且頁面畫出下一格之後：波紋與頁面反應同一格出現。
      // 換頁已經讓計時暫停的話，now() 就是暫停那一刻（影片切到新頁的那一格）
      await this.nextPaint();
      const ev = { type: 'click' as const, atMs: this.now(), x: this.cursor.x, y: this.cursor.y };
      this.events.push(ev);
      return ev;
    });
  }

  /**
   * 按一個鍵（Playwright 的鍵名：Enter、Escape、Tab、Control+A、Meta+K…）；字幕帶右邊出現小鍵帽提示 0.8 秒。
   * 換頁的處理跟 click 一樣（例如在表單裡按 Enter 送出而換頁：從按下那一刻起暫停，等新頁穩定；載入過程不進影片）。
   */
  async press(key: string, stable: WaitStableOptions | false = {}): Promise<void> {
    this.lastAction = `press ${key}`;
    this.check();
    await this.withNavWatch({ stable, linkTo: null, settleMs: Math.min(PRESS_HINT_MS, 400) }, async () => {
      await this.page.keyboard.press(key);
      await this.nextPaint();
      const ev = { type: 'press' as const, atMs: this.now(), key };
      this.events.push(ev);
      return ev;
    });
  }

  /**
   * 點擊、按鍵共用的換頁監看：送事件之前就裝上（Next.js 的 client-side 換頁在 click 事件裡同步 pushState，
   * framenavigated 會跟 mouse.up() 的回應同時到，晚一步才裝監看就會漏掉、把載到一半的新頁錄進去）；
   * 動作後等這一下的後續，真的換頁就回溯暫停、等新頁穩定，最後一定恢復計時。
   * linkTo：點的是連結時它指到的網址（指到別的路徑就預期會換頁，等換頁的這段不進影片，逾時也不進）。
   */
  private async withNavWatch(
    { stable, linkTo, settleMs }: { stable: WaitStableOptions | false; linkTo: string | null; settleMs: number },
    action: () => Promise<{ atMs: number }>,
  ): Promise<void> {
    const before = this.page.url();
    const watch: NavWatch = { startWall: Date.now(), before, navigated: false, sameDoc: false, docRequested: false, autoPaused: false, actionEvent: null };
    const onReq = (r: Request) => {
      if (r.resourceType() === 'document' && this.isMainFrame(r)) watch.docRequested = true;
    };
    this.page.on('request', onReq);
    if (stable !== false) this.navWatch = watch;
    // 最外層 finally：動作、等後續、等穩定任何一段拋錯，自己開的暫停都一定收尾（否則時鐘停住、之後的步驟長度都是 0）
    try {
      try {
        this.actionBusyUntil = Date.now() + 2000;
        watch.actionEvent = await action();
      await this.wait_(settleMs);
      if (stable !== false && !watch.navigated) {
        // 等這一下的後續：真的換頁（navDetected 會回溯暫停）、同文件改網址、或這一下發出的請求都結束。
        // 預期會換頁（點的是別頁的連結、或已送出整頁請求）時，這段等待不進影片——逾時也不進影片
        const expectNav = () => (linkTo != null && isPageChange(before, linkTo)) || watch.docRequested;
        const until = Date.now() + NAV_WAIT_MS;
        const grace = Date.now() + NAV_GRACE_MS;
        while (!watch.navigated && Date.now() < until) {
          if (expectNav() && this.pausedAt == null) {
            // 預期換頁（含動作之後才送出整頁請求，例如表單送出）：從現在起不進影片，偵測到換頁再回溯到動作前
            this.pausedAt = Date.now();
            watch.autoPaused = true;
          }
          const pending = this.clickRequestsPending(watch);
          if (pending === 0 && (watch.sameDoc || !expectNav() || Date.now() >= grace)) break;
          await this.wait_(30);
        }
        // 網址變了卻沒收到 framenavigated（保險）
        if (!watch.navigated && isPageChange(before, this.page.url())) this.navDetected(watch);
      }
      } finally {
        this.page.off('request', onReq);
        this.navWatch = null;
      }
      if (watch.navigated) {
        await this.page.waitForLoadState('load').catch(() => {});
        await this.waitStable(stable || {}); // 自己會暫停；已在暫停中就直接等
      }
    } finally {
      if (watch.autoPaused) await this.endPause();
    }
    this.noteUrl();
  }

  /**
   * 動作（點擊、按鍵）後偵測到真的換頁（整頁載入，或路徑變了）：從裝上監看那一刻（送事件之前）起暫停計時——
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
    } else if (w.autoPaused) this.pausedAt = w.startWall; // 自己為了等換頁開的暫停：起點挪回點擊前
    if (w.actionEvent) w.actionEvent.atMs = toChapterMs(this.pausedAt, this.t0Wall, this.pauses);
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

  /**
   * 平滑捲動（CSS px）：
   * - 數字：整頁往下捲幾 px（負數往上）。
   * - `{ x, y, within }`：橫向／直向捲 x、y px；`within` 指定捲哪個容器（例如比畫面寬的表格外層），不給就是整頁。
   * - Locator：把它捲到完整可見（直向到畫面上方三分之一；橫向與所在的每一層捲動容器都會處理）。
   * 捲完游標目標會照新位置重新量，所以點比畫面寬的表格最右邊的操作欄也會點對地方。
   */
  async scroll(target: number | Locator | { x?: number; y?: number; within?: Locator }): Promise<void> {
    this.lastAction = `scroll ${typeof target === 'object' && !isLocator(target) ? JSON.stringify({ x: target.x, y: target.y, within: String(target.within ?? '') }) : target}`;
    this.check();
    if (typeof target === 'number') return this.smoothScroll(0, target);
    if (isLocator(target)) {
      await target.waitFor({ state: 'visible', timeout: LOCATOR_TIMEOUT_MS }).catch((e) => this.fail(target, e));
      await this.scrollIntoView(target, 'third');
      return;
    }
    const { x = 0, y = 0, within } = target;
    if (within) await within.waitFor({ state: 'attached', timeout: LOCATOR_TIMEOUT_MS }).catch((e) => this.fail(within, e));
    await this.smoothScroll(x, y, within);
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
    this.loadFinal = this.systemLoad(); // 截圖停了就定格：後面的解碼、編碼不算錄影負載
    this.check(); // 收尾前一刻若中止（例如間隔過大）就報錯
    await this.cdp?.detach().catch(() => {});
    // 錄影結束就歸還名額：後面的編碼與 render 不佔名額
    this.slot?.release();
    this.page.off('close', this.onClose);
    this.page.off('crash', this.onCrash);
    this.page.off('framenavigated', this.onNav);
    this.page.off('domcontentloaded', this.onDocLoaded);
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
      // 影格本來就是 1920 寬：scale 不會重取樣；高度多出的一列（587×1.5=880.5）直接裁掉
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
      output: { width: this.size.width, height: this.size.height + CHROME_HEIGHT + CAPTION_HEIGHT, chromeHeight: CHROME_HEIGHT, captionHeight: CAPTION_HEIGHT },
      page: { width: this.css.width, height: this.css.height, zoom: this.zoom },
      clip: { file: 'clip.mp4', durationMs: Math.round((slots.length * 1000) / FPS), fps: FPS, captureLatencyMs },
      quality: {
        ...quality,
        pageJank,
        unloadedImages,
        system: this.loadFinal ?? this.systemLoad(),
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

  /**
   * 目標中心（影片像素）。元素沒有完整出現在安全區（網址列下方一點、頁面區底邊上方一點）或被哪一層捲動容器切到
   * （例如比畫面寬的表格最右邊的操作欄）就先平滑捲動（直向、橫向、每一層容器都處理），捲完再重新量位置。boundingBox 是 CSS px。
   */
  private async targetOf(locator: Locator): Promise<Point> {
    await locator.waitFor({ state: 'visible', timeout: LOCATOR_TIMEOUT_MS }).catch((e) => this.fail(locator, e));
    await this.scrollIntoView(locator, 'center');
    let box = await locator.boundingBox();
    if (!box) throw new Error(`找不到元素位置：${locator}`);
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    if (cx < 0 || cx > this.css.width || cy < 0 || cy > this.css.height) {
      await locator.scrollIntoViewIfNeeded();
      await this.wait_(200);
      box = await locator.boundingBox();
      if (!box) throw new Error(`捲動後找不到元素：${locator}`);
      const [nx, ny] = [box.x + box.width / 2, box.y + box.height / 2];
      if (nx < 0 || nx > this.css.width || ny < 0 || ny > this.css.height) {
        console.warn(`［${this.current?.caption ?? '步驟外'}］${locator} 捲不到畫面裡（中心在 CSS ${Math.round(nx)},${Math.round(ny)}）`);
      }
    }
    return this.toVideo({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
  }

  /**
   * 把元素捲進畫面：從最裡面的捲動容器往外，每一層（含整頁）各自平滑捲動，全部記成一個 scroll 事件（影片像素）。
   * - center（t.click 用）：只在元素沒有完整可見時捲——每層算讓元素落在可見區內的最小位移（留 24 px 邊）；
   *   整頁直向另外照安全區：元素中心不在「網址列下 40px ～ 底邊上 24px」之間就捲到畫面 42%。
   *   「可見區」扣掉蓋在邊上的 sticky／fixed 元素（黏頂列、黏住的表頭、固定的首欄，見 STICKY_INSETS_JS，#412）；
   *   捲完再量一次，捲動中才黏住的表頭還蓋著就再補一段，最多兩段。
   * - third（t.scroll(locator) 用）：**一律**把元素頂端對到可見區上方三分之一（整頁與每一層容器都是），
   *   已經看得到也一樣——劇本用它把某一區帶到畫面上方給觀眾看；橫向只在被切到時做最小位移。
   */
  private async scrollIntoView(locator: Locator, mode: 'center' | 'third'): Promise<void> {
    const startMs = this.now();
    const moved = await locator.evaluate(
      async (el, { topSafe, bottomSafe, margin, mode, speed, animateJs, insetsJs }) => {
        const animate = new Function(`return ${animateJs}`)() as (sc: Element, left: number, top: number, speed: number) => Promise<{ dx: number; dy: number }>;
        type Box = { left: number; top: number; right: number; bottom: number };
        const insetsOf = new Function(`return ${insetsJs}`)() as (el: Element, r: Box) => Box;
        const scrollable = (a: Element) => {
          const cs = getComputedStyle(a);
          const x = /(auto|scroll|overlay)/.test(cs.overflowX) && a.scrollWidth > a.clientWidth + 1;
          const y = /(auto|scroll|overlay)/.test(cs.overflowY) && a.scrollHeight > a.clientHeight + 1;
          return { x, y };
        };
        // 由內往外：元素的每一層捲動容器，最後是整頁
        const chain: { sc: Element; x: boolean; y: boolean; win: boolean }[] = [];
        const root = document.scrollingElement ?? document.documentElement;
        for (let a = el.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
          const { x, y } = scrollable(a);
          if (x || y) chain.push({ sc: a, x, y, win: false });
        }
        chain.push({ sc: root, x: root.scrollWidth > innerWidth + 1, y: root.scrollHeight > innerHeight + 1, win: true });
        let total = { dx: 0, dy: 0 };
        for (const { sc, x, y, win } of chain) {
          // center：第二段只在第一段捲完後還被蓋住時才會動（例如表頭捲動中才黏到頂端）
          for (let pass = 0; pass < (mode === 'center' ? 2 : 1); pass++) {
            const e = el.getBoundingClientRect();
            const full: Box = win
              ? { left: 0, top: 0, right: innerWidth, bottom: innerHeight }
              : (() => {
                  const b = sc.getBoundingClientRect();
                  return { left: b.left + sc.clientLeft, top: b.top + sc.clientTop, right: b.left + sc.clientLeft + sc.clientWidth, bottom: b.top + sc.clientTop + sc.clientHeight };
                })();
            // third 照舊對齊整個可見區；center 扣掉蓋在邊上的固定元素
            const ins = mode === 'center' ? insetsOf(el, full) : { left: 0, top: 0, right: 0, bottom: 0 };
            const r: Box = { left: full.left + ins.left, top: full.top + ins.top, right: full.right - ins.right, bottom: full.bottom - ins.bottom };
            let dx = 0;
            let dy = 0;
            if (x) {
              if (e.width > r.right - r.left - 2 * margin || e.left < r.left + margin) dx = e.left - (r.left + margin);
              else if (e.right > r.right - margin) dx = e.right - (r.right - margin);
            }
            if (y) {
              const h = r.bottom - r.top;
              if (mode === 'third') dy = e.top - (r.top + h * 0.3);
              else if (win) {
                const cy = (e.top + e.bottom) / 2;
                if (cy < full.top + topSafe || cy > full.bottom - bottomSafe || e.top < r.top || e.bottom > r.bottom) {
                  // 照舊捲到畫面 42%；有東西蓋住上下邊時，夾在沒被蓋住的範圍裡（留 margin，放不下就頂端對齊）
                  const half = e.height / 2;
                  let target = full.top + (full.bottom - full.top) * 0.42;
                  if (ins.top > 0 || ins.bottom > 0) target = Math.max(r.top + half, Math.min(Math.max(target, r.top + half + margin), r.bottom - half - margin));
                  dy = cy - target;
                }
              } else if (e.height > h - 2 * margin || e.top < r.top + margin) dy = e.top - (r.top + margin);
              else if (e.bottom > r.bottom - margin) dy = e.bottom - (r.bottom - margin);
            }
            if (pass > 0 && Math.abs(dx) < 1 && Math.abs(dy) < 1) break;
            const m = await animate(sc, sc.scrollLeft + dx, sc.scrollTop + dy, speed);
            total = { dx: total.dx + m.dx, dy: total.dy + m.dy };
          }
        }
        return total;
      },
      { topSafe: 40 / this.zoom, bottomSafe: 24 / this.zoom, margin: 24, mode, speed: this.zoom * 0.9, animateJs: SCROLL_ANIMATE_JS, insetsJs: STICKY_INSETS_JS },
    );
    await this.pushScroll(startMs, moved);
  }

  /** 有動才記 scroll 事件（影片像素）；動了就多停 150 ms 讓畫面落定。 */
  private async pushScroll(startMs: number, moved: { dx: number; dy: number }): Promise<void> {
    if (Math.abs(moved.dx) < 1 && Math.abs(moved.dy) < 1) return;
    await this.wait_(150);
    const ev: ChapterEvent = { type: 'scroll', startMs, endMs: this.now(), dy: Math.round(moved.dy * this.zoom) };
    if (Math.round(moved.dx * this.zoom) !== 0) ev.dx = Math.round(moved.dx * this.zoom);
    this.events.push(ev);
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

  /** dx、dy 是 CSS px；within 指定捲動容器（不給就是整頁）；捲動時長照畫面上移動的距離（影片像素）算。 */
  private async smoothScroll(dx: number, dy: number, within?: Locator): Promise<void> {
    if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
    const startMs = this.now();
    const args = { dx, dy, speed: this.zoom * 0.9, animateJs: SCROLL_ANIMATE_JS };
    type Animate = (sc: Element, left: number, top: number, speed: number) => Promise<{ dx: number; dy: number }>;
    const moved = within
      ? await within.evaluate((sc, { dx, dy, speed, animateJs }) => (new Function(`return ${animateJs}`)() as Animate)(sc, sc.scrollLeft + dx, sc.scrollTop + dy, speed), args)
      : await this.page.evaluate(({ dx, dy, speed, animateJs }) => {
          const sc = document.scrollingElement ?? document.documentElement;
          return (new Function(`return ${animateJs}`)() as Animate)(sc, sc.scrollLeft + dx, sc.scrollTop + dy, speed);
        }, args);
    await this.pushScroll(startMs, moved);
  }

  /** 給測試與後製參考：時間 t 的游標位置。 */
  cursorAt(t: number): Point {
    return cursorAt(this.moves, { x: Math.round(this.size.width * 0.5), y: Math.round(this.size.height * 0.45) }, t);
  }
}

function eventTime(e: ChapterEvent): number {
  return 'atMs' in e ? e.atMs : e.startMs;
}

function isLocator(x: unknown): x is Locator {
  return typeof x === 'object' && x != null && typeof (x as Locator).boundingBox === 'function' && typeof (x as Locator).evaluate === 'function';
}
