// events.json 的格式。錄影寫、後製讀；時間一律是「章節影片時間」（ms，clip 第 0 格＝0）。
// 座標一律是 clip 影片像素（CSS px × zoom），不含上方假網址列。page 是錄影時的 CSS viewport。

import type { Point } from './cursor.ts';
import type { CaptureQuality } from './frames.ts';

export type StatusKind = 'ok' | 'warn' | 'bad' | 'pending';
export type Status = { kind: StatusKind; note?: string };

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
  | { type: 'scroll'; startMs: number; endMs: number; dy: number }
  | { type: 'url'; atMs: number; url: string };

export type ChapterEvents = {
  version: 1;
  /** 分鏡的段編號（例如 3-3、5A-2）。 */
  id?: string;
  chapter: string;
  number?: number;
  subtitle?: string;
  output: { width: number; height: number; chromeHeight: number };
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

/** 段編號：id，舊資料用 number。 */
export function chapterId(ev: Pick<ChapterEvents, 'id' | 'number'>): string | undefined {
  return ev.id ?? (ev.number != null ? String(ev.number) : undefined);
}

/** 「3-3｜學生｜繳交作業」這種章節全名。 */
export function chapterLabel(ev: Pick<ChapterEvents, 'id' | 'chapter' | 'number'>): string {
  const id = chapterId(ev);
  return id == null ? ev.chapter : `${id}｜${ev.chapter}`;
}
