// 配音 provider。預設用 macOS 內建 say（繁中 Meijia）；要換服務就實作 TtsProvider。

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export type Speech = { file: string; durationMs: number };

export interface TtsProvider {
  /** 把 text 念成音檔放在 dir 下，回傳檔案與長度。同樣的輸入應該可以重用快取。 */
  synth(text: string, dir: string): Promise<Speech>;
}

export async function probeDurationMs(file: string): Promise<number> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  const sec = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(sec)) throw new Error(`ffprobe 量不到長度：${file}`);
  return Math.round(sec * 1000);
}

export type SayOptions = { voice?: string; rate?: number };

/** macOS say → aiff → 48k 單聲道 wav（後製直接用）。 */
export function sayProvider({ voice = 'Meijia', rate = 190 }: SayOptions = {}): TtsProvider {
  return {
    async synth(text, dir) {
      mkdirSync(dir, { recursive: true });
      const key = createHash('sha1').update(`${voice}|${rate}|${text}`).digest('hex').slice(0, 12);
      const wav = join(dir, `say-${key}.wav`);
      if (!existsSync(wav)) {
        const aiff = join(dir, `say-${key}.aiff`);
        await run('say', ['-v', voice, '-r', String(rate), '-o', aiff, text]);
        await run('ffmpeg', ['-y', '-v', 'error', '-i', aiff, '-ar', '48000', '-ac', '1', wav]);
      }
      return { file: wav, durationMs: await probeDurationMs(wav) };
    },
  };
}

/** 測試用：產生指定長度的靜音，不需要 say。 */
export function silentProvider(msPerChar = 120): TtsProvider {
  return {
    async synth(text, dir) {
      mkdirSync(dir, { recursive: true });
      const ms = Math.max(300, [...text].length * msPerChar);
      const wav = join(dir, `silent-${ms}.wav`);
      if (!existsSync(wav)) {
        await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', String(ms / 1000), wav]);
      }
      return { file: wav, durationMs: await probeDurationMs(wav) };
    },
  };
}
