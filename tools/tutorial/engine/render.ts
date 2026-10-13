// 後製一章：clip.mp4 + events.json + 配音 → 1920×1080 30fps H.264 mp4。
//
// 圖層由下到上：白底 → 錄到的頁面（放在網址列下面）→ 疊加 PNG（網址列、字幕條、狀態標記；
// 開頭是標題卡）→ ASS（點擊波紋、游標）。全部用 ffmpeg 一次合成，可重複執行。

import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { chapterId, chapterLabel, type ChapterEvents } from './events.ts';
import { overlayHtml, renderHtmlPngs, titleCardHtml } from './overlay.ts';
import { assertRunComplete } from './runs.ts';
import { cursorAss, overlaySegments } from './timeline.ts';

const run = promisify(execFile);

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
  steps: { index: number; caption: string; startMs: number; status?: string }[];
};

export type RenderOptions = {
  /** 錄影輸出資料夾（裡面有 events.json、clip.mp4、audio/）。 */
  dir: string;
  /** 輸出 mp4，預設 <dir>/chapter.mp4。 */
  out?: string;
  titleMs?: number;
  /** x264 品質（越小越好），預設 18。 */
  crf?: number;
};

export async function renderChapter(opts: RenderOptions): Promise<{ file: string; meta: ChapterMeta }> {
  const dir = resolve(opts.dir);
  assertRunComplete(dir);
  const ev = JSON.parse(readFileSync(join(dir, 'events.json'), 'utf8')) as ChapterEvents;
  const out = resolve(opts.out ?? join(dir, 'chapter.mp4'));
  const titleMs = opts.titleMs ?? TITLE_MS;
  const { width, height, chromeHeight } = ev.output;
  const totalMs = titleMs + ev.clip.durationMs;
  const work = join(dir, 'render');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  // 1) 疊加 PNG：標題卡＋每個狀態片段（同樣內容只畫一次）
  const segs = overlaySegments(ev);
  const jobs: { html: string; file: string; transparent: boolean }[] = [];
  const parts = ev.chapter.split('｜');
  const id = chapterId(ev);
  const title = id == null ? parts[0] : `${id}｜${parts[0]}`;
  const subtitle = ev.subtitle ?? (parts.length > 1 ? parts.slice(1).join('｜') : undefined);
  jobs.push({ html: titleCardHtml(title, subtitle, { width, height }), file: join(work, 'title.png'), transparent: false });
  const fileByKey = new Map<string, string>();
  const list = ['ffconcat version 1.0', `file 'title.png'`, `duration ${(titleMs / 1000).toFixed(3)}`];
  for (const s of segs) {
    const key = JSON.stringify(s.state);
    let file = fileByKey.get(key);
    if (!file) {
      file = `ov-${String(fileByKey.size + 1).padStart(3, '0')}.png`;
      fileByKey.set(key, file);
      jobs.push({ html: overlayHtml(s.state, ev.output), file: join(work, file), transparent: true });
    }
    list.push(`file '${file}'`, `duration ${((s.endMs - s.startMs) / 1000).toFixed(3)}`);
  }
  list.push(list.at(-2)!);
  writeFileSync(join(work, 'overlays.ffconcat'), list.join('\n'));
  const browser = await chromium.launch();
  try {
    await renderHtmlPngs(browser, jobs, { width, height });
  } finally {
    await browser.close();
  }

  // 2) 游標與波紋
  writeFileSync(join(work, 'cursor.ass'), cursorAss(ev, titleMs, ev.clip.fps));

  // 3) 配音：每步的音檔放到它的起播時間
  const audios = ev.steps.filter((s) => s.audio);
  const audioInputs = audios.flatMap((s) => ['-i', join(dir, s.audio!.file)]);
  const T = (totalMs / 1000).toFixed(3);
  const aFilters = audios.map((s, i) => {
    const d = Math.round(titleMs + s.audio!.startMs);
    return `[${i + 2}:a]aresample=48000,aformat=channel_layouts=mono,adelay=${d}:all=1[a${i}]`;
  });
  const audioGraph = audios.length
    ? `${aFilters.join(';')};${audios.map((_, i) => `[a${i}]`).join('')}amix=inputs=${audios.length}:normalize=0:duration=longest,apad,atrim=0:${T},afade=t=out:st=${(totalMs / 1000 - 0.4).toFixed(3)}:d=0.4,aformat=channel_layouts=stereo[a]`
    : `anullsrc=r=48000:cl=stereo,atrim=0:${T}[a]`;

  const graph = [
    `color=c=white:s=${width}x${height}:r=${ev.clip.fps}:d=${T}[bg]`,
    `[0:v]setpts=PTS-STARTPTS+${(titleMs / 1000).toFixed(3)}/TB[pg]`,
    `[bg][pg]overlay=0:${chromeHeight}:eof_action=pass[base]`,
    `[1:v]format=rgba[ov]`,
    `[base][ov]overlay=0:0:format=auto:eof_action=repeat,ass=cursor.ass,fade=t=in:st=0:d=0.4,fade=t=out:st=${(totalMs / 1000 - 0.4).toFixed(3)}:d=0.4,format=yuv420p[v]`,
    audioGraph,
  ].join(';');

  await run(
    'ffmpeg',
    [
      '-y', '-v', 'error',
      '-i', join(dir, ev.clip.file),
      // 標題卡是 RGB、其餘 RGBA：不關 reinit 的話 ffmpeg 換格式時會丟掉第一張
      '-reinit_filter', '0', '-f', 'concat', '-safe', '0', '-i', 'overlays.ffconcat',
      ...audioInputs,
      '-filter_complex', graph,
      '-map', '[v]', '-map', '[a]',
      '-t', T, '-r', String(ev.clip.fps), '-fps_mode', 'cfr',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', String(opts.crf ?? 18), '-profile:v', 'high', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
      '-movflags', '+faststart', out,
    ],
    { cwd: work, maxBuffer: 1 << 24 },
  );

  const meta: ChapterMeta = {
    label: chapterLabel(ev),
    id,
    number: ev.number,
    chapter: ev.chapter,
    file: relative(dir, out),
    durationMs: totalMs,
    titleMs,
    steps: ev.steps.map((s) => ({ index: s.index, caption: s.caption, startMs: Math.round(titleMs + s.startMs), status: s.status?.kind })),
  };
  writeFileSync(join(dir, 'chapter.json'), JSON.stringify(meta, null, 2));
  return { file: out, meta };
}
