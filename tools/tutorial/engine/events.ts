// events.json 的格式。錄影寫、後製讀；時間一律是「章節影片時間」（ms，clip 第 0 格＝0）。
// 座標一律是 clip 影片像素（CSS px × zoom），不含上方假網址列。page 是錄影時的 CSS viewport。

import type { Point } from './cursor.ts';
import type { CaptureQuality } from './frames.ts';

export type StatusKind = 'ok' | 'warn' | 'bad' | 'pending';
/**
 * 步驟的狀態標記。畫面上只顯示圖示＋白話（say）；evidence（依據，例如「story-2 第 39 步」）不上畫面，
 * 只寫進 events.json 與 assemble 產出的 feature-timeline／index.html。舊寫法的 note 視為 evidence。
 */
export type Status = { kind: StatusKind; say?: string; evidence?: string; note?: string };
/** 劇本裡 step() 的 status 寫法：新寫法是物件；舊寫法是字串（說明放在 note，視為 evidence）。 */
export type StepStatus = { kind: StatusKind; say?: string; evidence?: string };

/** 白話超過這麼多字就在畫面上截斷加「…」（events.json 留全文）。 */
export const SAY_MAX_CHARS = 22;
const STATUS_WORD: Record<StatusKind, string> = { ok: '正常', warn: '', bad: '', pending: '等你決定：' };

export type StepRecord = {
  index: number; // 1 起算
  caption: string;
  narration: string;
  status?: Status;
  startMs: number;
  endMs: number;
  audio?: { file: string; startMs: number; durationMs: number };
};

export type ChapterEvent =
  | { type: 'move'; startMs: number; endMs: number; from: Point; to: Point }
  | { type: 'click'; atMs: number; x: number; y: number }
  | { type: 'type'; startMs: number; endMs: number; text: string }
  | { type: 'select'; atMs: number; value: string }
  | { type: 'upload'; atMs: number; file: string }
  | { type: 'scroll'; startMs: number; endMs: number; dy: number; dx?: number }
  | { type: 'press'; atMs: number; key: string }
  | { type: 'url'; atMs: number; url: string };

/** 按鍵提示在畫面上停留多久。 */
export const PRESS_HINT_MS = 800;

const KEY_LABEL: Record<string, string> = {
  Enter: '⏎ Enter', Escape: 'Esc', Tab: '⇥ Tab', Backspace: '⌫ Backspace', Delete: '⌦ Delete', Space: '␣ Space', ' ': '␣ Space',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Home: 'Home', End: 'End', PageUp: 'PgUp', PageDown: 'PgDn',
  Meta: '⌘', Control: 'Ctrl', Alt: '⌥', Shift: '⇧', ControlOrMeta: '⌘',
};

/** Playwright 的按鍵名（例如 Enter、Control+A、Meta+K）→ 畫面上的鍵帽字（⏎ Enter、Ctrl A、⌘ K）。 */
export function keyLabel(key: string): string {
  return key
    .split('+')
    .map((k) => KEY_LABEL[k] ?? (k.length === 1 ? k.toUpperCase() : k))
    .join(' ');
}

export type ChapterEvents = {
  version: 1;
  /** 分鏡的段編號（例如 3-3、5A-2）。 */
  id?: string;
  chapter: string;
  number?: number;
  subtitle?: string;
  /** captionHeight：下方字幕帶（頁面區在網址列與字幕帶之間）；舊資料沒有這欄，字幕改畫在頁面上。 */
  output: { width: number; height: number; chromeHeight: number; captionHeight?: number };
  page: { width: number; height: number; zoom: number };
  /** captureLatencyMs：開頭校正量到的「畫面內容 → 截圖」延遲，影格時間已扣掉。 */
  clip: { file: string; durationMs: number; fps: number; captureLatencyMs: number };
  /** 截圖品質：每秒張數、最大間隔；ok=false 代表有段落超標（warnings 說明哪裡）。 */
  quality?: CaptureQuality;
  displayOrigin: string;
  cursorStart: Point;
  steps: StepRecord[];
  events: ChapterEvent[];
};

export const STATUS_ICON: Record<StatusKind, string> = { ok: '✅', warn: '⚠️', bad: '❌', pending: '🟡' };

/** 畫面上顯示的白話（不含圖示）：ok 沒寫 say 就是「正常」；pending 前面加「等你決定：」；超過 SAY_MAX_CHARS 字截斷加「…」。 */
export function statusSay(st: Pick<Status, 'kind' | 'say'>): string {
  const say = (st.say ?? '').trim();
  const text = st.kind === 'ok' ? say || STATUS_WORD.ok : `${STATUS_WORD[st.kind]}${say}`;
  const chars = [...text];
  return chars.length > SAY_MAX_CHARS ? `${chars.slice(0, SAY_MAX_CHARS).join('')}…` : text;
}

/** 圖示＋白話，例如「✅ 正常」「🟡 等你決定：名稱要不要改」。 */
export function statusLabel(st: Pick<Status, 'kind' | 'say'>): string {
  const say = statusSay(st);
  return say ? `${STATUS_ICON[st.kind]} ${say}` : STATUS_ICON[st.kind];
}

/** 依據（不上畫面）：新寫法 evidence，舊寫法 note。 */
export function statusEvidence(st: Pick<Status, 'evidence' | 'note'> | undefined): string | undefined {
  const e = (st?.evidence ?? st?.note ?? '').trim();
  return e || undefined;
}

/** 劇本給的 status（字串或物件）＋舊的 note → events.json 的 Status；全文保留，截斷只在畫面上做。 */
export function normalizeStatus(status: StatusKind | StepStatus | undefined, note?: string): Status | undefined {
  if (!status) return undefined;
  if (typeof status === 'string') return { kind: status, ...(note ? { evidence: note } : {}) };
  const out: Status = { kind: status.kind };
  if (status.say?.trim()) out.say = status.say.trim();
  const evidence = (status.evidence ?? note ?? '').trim();
  if (evidence) out.evidence = evidence;
  return out;
}

/** 段編號：id，舊資料用 number。 */
export function chapterId(ev: Pick<ChapterEvents, 'id' | 'number'>): string | undefined {
  return ev.id ?? (ev.number != null ? String(ev.number) : undefined);
}

/** 「3-3｜學生｜繳交作業」這種章節全名。 */
export function chapterLabel(ev: Pick<ChapterEvents, 'id' | 'chapter' | 'number'>): string {
  const id = chapterId(ev);
  return id == null ? ev.chapter : `${id}｜${ev.chapter}`;
}
