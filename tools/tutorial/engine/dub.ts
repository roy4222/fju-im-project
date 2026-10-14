// 只換聲音的重新 render：對一段已錄好、已 render 的成品，不開瀏覽器、不重錄，用另一個 TTS 重念每步配音，
// 接在原本的起播時間混成新音軌；影像直接複製（-c:v copy，畫面逐格不變）。輸出到另一個資料夾，不碰原本的成品。

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { chapterId, type ChapterEvents } from './events.ts';
import { chapterMeta, narrationMix, TITLE_MS, type ChapterMeta } from './render.ts';
import { buildCues, toSrt, toVtt } from './subtitles.ts';
import { probeDurationMs, type TtsProvider } from './tts.ts';

const run = promisify(execFile);

/** 新配音最晚要在下一句起播前這麼多 ms 結束。 */
export const DUB_GAP_MS = 200;
/** 新配音太長時最多加速到幾倍。 */
export const MAX_TEMPO = 1.25;

/** 一句新配音：clip 時間的起播點與新音檔長度。 */
export type FitInput = { index: number; startMs: number; durationMs: number };
/** availableMs：到下一句起播（最後一句到 clip 結束）前 gapMs；tempo：要加速幾倍（1＝原速，短的後面自然是靜音）。 */
export type Fit = FitInput & { availableMs: number; tempo: number; playedMs: number };

/**
 * 決定每句要不要加速：放得下就原速；放不下就 atempo＝長度／可用時間（無條件進位到千分位）；
 * 超過 maxTempo 的列在 over（呼叫端要報錯，不硬塞、也不蓋到下一句）。
 */
export function fitSpeech(items: readonly FitInput[], clipEndMs: number, opts: { gapMs?: number; maxTempo?: number } = {}): { fits: Fit[]; over: Fit[] } {
  const gap = opts.gapMs ?? DUB_GAP_MS;
  const max = opts.maxTempo ?? MAX_TEMPO;
  const sorted = [...items].sort((a, b) => a.startMs - b.startMs);
  const fits = sorted.map((it, i) => {
    const next = i + 1 < sorted.length ? sorted[i + 1].startMs : clipEndMs;
    const availableMs = Math.max(0, next - it.startMs - gap);
    const tempo = it.durationMs <= availableMs ? 1 : availableMs > 0 ? Math.ceil((it.durationMs / availableMs) * 1000) / 1000 : Infinity;
    return { ...it, availableMs, tempo, playedMs: Math.round(it.durationMs / tempo) };
  });
  return { fits, over: fits.filter((f) => f.tempo > max) };
}

export function overflowMessage(label: string, over: readonly Fit[], maxTempo = MAX_TEMPO): string {
  const lines = over.map((f) => `  第 ${f.index} 步：新配音 ${(f.durationMs / 1000).toFixed(2)} 秒，可用 ${(f.availableMs / 1000).toFixed(2)} 秒，要 ${f.tempo.toFixed(2)} 倍`);
  return `${label}：${over.length} 句新配音塞不進原本的時間（上限 ${maxTempo} 倍），沒有輸出影片；請縮短配音或重錄這幾步：\n${lines.join('\n')}`;
}

export type DubOptions = {
  /** 已 render 的一段：chapters/<段>/（events.json＋<段>.mp4）或 run 目錄（events.json＋chapter.mp4）。 */
  dir: string;
  tts: TtsProvider;
  /** 輸出資料夾，例如 ~/work/tutorial-out/dub-Charon/3-3；不能是來源資料夾。 */
  outDir: string;
  /** 標題卡長度；預設 2500，會用影片長度核對。 */
  titleMs?: number;
  maxTempo?: number;
  gapMs?: number;
};

export type DubStep = { index: number; originalMs: number; newMs: number; availableMs: number; tempo: number; playedMs: number };
export type DubResult = { file: string; srt: string; vtt: string; meta: ChapterMeta; steps: DubStep[]; maxTempo: number };

/** 找這段的成品 mp4：<段>.mp4、chapter.mp4，或 chapter.json 指的檔。 */
function sourceVideo(dir: string, id: string | undefined): string {
  const candidates = [id ? join(dir, `${id}.mp4`) : '', join(dir, `${basename(dir)}.mp4`), join(dir, 'chapter.mp4')].filter(Boolean);
  const metaFile = join(dir, 'chapter.json');
  if (existsSync(metaFile)) candidates.push(resolve(dir, (JSON.parse(readFileSync(metaFile, 'utf8')) as ChapterMeta).file));
  const found = candidates.find((f) => existsSync(f));
  if (!found) throw new Error(`${dir} 找不到成品影片（試過 ${candidates.map((f) => basename(f)).join('、')}）：先 render 這一段`);
  return found;
}

export async function dubChapter(opts: DubOptions): Promise<DubResult> {
  const dir = resolve(opts.dir);
  const outDir = resolve(opts.outDir);
  if (outDir === dir) throw new Error(`重配音的輸出不能寫回來源資料夾：${dir}`);
  const evFile = join(dir, 'events.json');
  if (!existsSync(evFile)) throw new Error(`找不到 ${evFile}`);
  const ev = JSON.parse(readFileSync(evFile, 'utf8')) as ChapterEvents;
  const id = chapterId(ev) ?? basename(dir);
  const label = `${id}｜${ev.chapter}`;
  const video = sourceVideo(dir, chapterId(ev));
  const titleMs = opts.titleMs ?? TITLE_MS;
  const totalMs = titleMs + ev.clip.durationMs;
  const videoMs = await probeDurationMs(video);
  if (Math.abs(videoMs - totalMs) > 100) {
    throw new Error(`${label}：影片 ${(videoMs / 1000).toFixed(3)} 秒，跟標題卡 ${titleMs} ms＋clip ${ev.clip.durationMs} ms 對不上；用 titleMs 指定標題卡長度`);
  }
  const maxTempo = opts.maxTempo ?? MAX_TEMPO;

  // 1) 每步重念（provider 自己有快取）
  const speeches = new Map<number, { file: string; durationMs: number }>();
  const narrated = ev.steps.filter((s) => s.narration.trim() && s.audio);
  for (const s of narrated) speeches.set(s.index, await opts.tts.synth(s.narration, join(outDir, '.tts')));

  // 2) 放不放得下
  const { fits, over } = fitSpeech(
    narrated.map((s) => ({ index: s.index, startMs: s.audio!.startMs, durationMs: speeches.get(s.index)!.durationMs })),
    ev.clip.durationMs,
    { gapMs: opts.gapMs, maxTempo },
  );
  const original = new Map(narrated.map((s) => [s.index, s.audio!.durationMs]));
  const report = (played?: Map<number, number>): DubStep[] =>
    fits.map((f) => ({ index: f.index, originalMs: original.get(f.index)!, newMs: f.durationMs, availableMs: f.availableMs, tempo: f.tempo, playedMs: played?.get(f.index) ?? f.playedMs }));
  mkdirSync(outDir, { recursive: true });
  if (over.length) {
    writeFileSync(join(outDir, 'dub.json'), JSON.stringify({ label, ok: false, maxTempo, steps: report() }, null, 2));
    throw new Error(overflowMessage(label, over, maxTempo));
  }

  // 3) 每句轉成 48k 單聲道，需要時加速（截在可用時間內，atempo 的長度有幾 ms 誤差）
  const audioDir = join(outDir, 'audio');
  rmSync(audioDir, { recursive: true, force: true });
  mkdirSync(audioDir, { recursive: true });
  const played = new Map<number, number>();
  const files: string[] = [];
  for (const f of fits) {
    const out = join(audioDir, `step-${String(f.index).padStart(2, '0')}.wav`);
    const af = ['aresample=48000', 'aformat=channel_layouts=mono', ...(f.tempo > 1 ? [`atempo=${f.tempo}`, `atrim=0:${(f.availableMs / 1000).toFixed(3)}`] : [])].join(',');
    await run('ffmpeg', ['-y', '-v', 'error', '-i', speeches.get(f.index)!.file, '-af', af, '-ar', '48000', '-ac', '1', out]);
    played.set(f.index, await probeDurationMs(out));
    files.push(out);
  }

  // 4) 混音：影像直接複製
  const file = join(outDir, `${id}.mp4`);
  const T = (totalMs / 1000).toFixed(3);
  await run(
    'ffmpeg',
    [
      '-y', '-v', 'error',
      '-i', video,
      ...files.flatMap((f) => ['-i', f]),
      '-filter_complex', narrationMix(fits.map((f) => titleMs + f.startMs), totalMs, 1),
      '-map', '0:v', '-map', '[a]', '-t', T,
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
      '-movflags', '+faststart', file,
    ],
    { maxBuffer: 1 << 24 },
  );

  // 5) chapter.json（assemble 可以直接吃這個資料夾）與字幕
  const meta = chapterMeta(ev, titleMs, basename(file), new Map(fits.map((f) => [f.index, { startMs: f.startMs, durationMs: played.get(f.index)! }])));
  writeFileSync(join(outDir, 'chapter.json'), JSON.stringify(meta, null, 2));
  const cues = buildCues(meta.steps.flatMap((s) => (s.narration && s.audio ? [{ narration: s.narration, startMs: s.audio.startMs, endMs: s.audio.startMs + s.audio.durationMs }] : [])));
  const srt = join(outDir, `${id}.srt`);
  const vtt = join(outDir, `${id}.vtt`);
  writeFileSync(srt, toSrt(cues));
  writeFileSync(vtt, toVtt(cues));
  const steps = report(played);
  const maxUsed = Math.max(1, ...steps.map((s) => s.tempo));
  writeFileSync(join(outDir, 'dub.json'), JSON.stringify({ label, ok: true, source: video, maxTempo, maxUsedTempo: maxUsed, steps }, null, 2));
  return { file, srt, vtt, meta, steps, maxTempo: maxUsed };
}
