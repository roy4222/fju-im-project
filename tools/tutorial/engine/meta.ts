// chapter.json（章節摘要）與配音混音：render、dub、assemble 共用。不依賴 Playwright，不開瀏覽器。

import { chapterId, chapterLabel, statusEvidence, type ChapterEvents, type StatusKind } from './events.ts';

/** 標題卡長度。 */
export const TITLE_MS = 2500;

/** 給 assemble 用的章節摘要（時間是本章輸出影片時間）。 */
export type ChapterMeta = {
  label: string;
  /** 分鏡的段編號（例如 3-3）。 */
  id?: string;
  number?: number;
  chapter: string;
  /** 相對於 chapter.json 所在資料夾。 */
  file: string;
  durationMs: number;
  titleMs: number;
  steps: ChapterMetaStep[];
};

/** 一步的摘要：status 是物件（kind＋白話 say＋依據 evidence）；舊的 chapter.json 裡是字串 kind。 */
export type ChapterMetaStep = {
  index: number;
  caption: string;
  startMs: number;
  status?: { kind: StatusKind; say?: string; evidence?: string } | StatusKind;
  /** 配音全文與它在本章輸出影片裡的起播時間、長度（assemble 用來出字幕）；舊的 chapter.json 沒有。 */
  narration?: string;
  audio?: { startMs: number; durationMs: number };
};

/**
 * 配音混音的 filter：第 firstInput 個輸入起依序是各句音檔，delaysMs 是各句在輸出影片的起播時間。
 * 混成 totalMs 長的立體聲 [a]，結尾 0.4 秒淡出；沒有配音就是靜音。
 */
export function narrationMix(delaysMs: readonly number[], totalMs: number, firstInput: number): string {
  const T = (totalMs / 1000).toFixed(3);
  if (!delaysMs.length) return `anullsrc=r=48000:cl=stereo,atrim=0:${T}[a]`;
  const aFilters = delaysMs.map((d, i) => `[${i + firstInput}:a]aresample=48000,aformat=channel_layouts=mono,adelay=${Math.round(d)}:all=1[a${i}]`);
  return `${aFilters.join(';')};${delaysMs.map((_, i) => `[a${i}]`).join('')}amix=inputs=${delaysMs.length}:normalize=0:duration=longest,apad,atrim=0:${T},afade=t=out:st=${(totalMs / 1000 - 0.4).toFixed(3)}:d=0.4,aformat=channel_layouts=stereo[a]`;
}

/**
 * chapter.json 的內容（時間換成本章輸出影片時間）。audio 可以換掉每步的配音（重配音用，clip 時間）；
 * 沒給就用 events.json 錄影時的配音。
 */
export function chapterMeta(ev: ChapterEvents, titleMs: number, file: string, audio?: ReadonlyMap<number, { startMs: number; durationMs: number }>): ChapterMeta {
  return {
    label: chapterLabel(ev),
    id: chapterId(ev),
    number: ev.number,
    chapter: ev.chapter,
    file,
    durationMs: titleMs + ev.clip.durationMs,
    titleMs,
    steps: ev.steps.map((s) => {
      const a = audio ? audio.get(s.index) : s.audio;
      return {
        index: s.index,
        caption: s.caption,
        startMs: Math.round(titleMs + s.startMs),
        ...(s.status
          ? { status: { kind: s.status.kind, ...(s.status.say ? { say: s.status.say } : {}), ...(statusEvidence(s.status) ? { evidence: statusEvidence(s.status) } : {}) } }
          : {}),
        ...(s.narration ? { narration: s.narration } : {}),
        ...(a && s.narration ? { audio: { startMs: Math.round(titleMs + a.startMs), durationMs: Math.round(a.durationMs) } } : {}),
      };
    }),
  };
}
