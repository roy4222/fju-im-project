// 配音 provider。預設用 macOS 內建 say（繁中 Meijia）；TUTORIAL_TTS=gemini 改用 OpenRouter 的 Gemini TTS（見 ttsFromEnv）。
// 要換服務就實作 TtsProvider。

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
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

// ── Gemini TTS（OpenRouter） ─────────────────────────────

export const GEMINI_TTS_MODEL = 'google/gemini-3.8-flash-tts';
export const OPENROUTER_SPEECH_URL = 'https://openrouter.ai/api/v1/audio/speech';
export const DEFAULT_TTS_CACHE = join(homedir(), 'work', 'tutorial-out', 'tts-cache');

/** s16le 裸 PCM → WAV（加 44 byte 標頭）。 */
export function pcmToWav(pcm: Uint8Array, rate = 24000, channels = 1): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** 「audio/pcm;rate=24000;channels=1」→ { rate, channels }（缺的用預設）。 */
export function parsePcmType(contentType: string | null): { rate: number; channels: number } {
  const get = (k: string, d: number) => {
    const m = (contentType ?? '').match(new RegExp(`${k}=(\\d+)`));
    return m ? Number(m[1]) : d;
  };
  return { rate: get('rate', 24000), channels: get('channels', 1) };
}

export type GeminiOptions = {
  voice: string;
  model?: string;
  /** 快取資料夾：依「模型＋聲音＋文字」雜湊存 wav，重跑不重複計費。 */
  cacheDir?: string;
  /** 金鑰；預設從 macOS 鑰匙圈讀 OPENROUTER_API_KEY（只在快取沒命中時讀）。 */
  apiKey?: () => Promise<string>;
  /** 測試用：假 HTTP。 */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** 429／5xx 最多試幾次（含第一次）。 */
  maxAttempts?: number;
};

export type GeminiProvider = TtsProvider & {
  /** 這個 provider 打了幾次 API（含重試）、快取命中幾次。 */
  readonly stats: { calls: number; cacheHits: number };
};

async function keychainKey(): Promise<string> {
  const fromEnv = process.env.OPENROUTER_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    const { stdout } = await run('security', ['find-generic-password', '-s', 'OPENROUTER_API_KEY', '-w']);
    const key = stdout.trim();
    if (key) return key;
  } catch {
    // 落到下面的錯誤
  }
  throw new Error('讀不到 OpenRouter 金鑰：鑰匙圈沒有 OPENROUTER_API_KEY（security find-generic-password -s OPENROUTER_API_KEY），也沒有同名環境變數');
}

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * OpenRouter `google/gemini-3.8-flash-tts`。只接受 response_format=pcm，回 s16le（預設 24 kHz 單聲道），轉成 wav 放進快取。
 * 429／5xx 退避重試（429 有 Retry-After 就照它）；402 是沒額度，直接停。錯誤訊息不含金鑰。
 */
export function geminiProvider(opts: GeminiOptions): GeminiProvider {
  const model = opts.model ?? GEMINI_TTS_MODEL;
  const cacheDir = opts.cacheDir ?? DEFAULT_TTS_CACHE;
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxAttempts = opts.maxAttempts ?? 6;
  const getKey = opts.apiKey ?? keychainKey;
  const stats = { calls: 0, cacheHits: 0 };
  let key: Promise<string> | undefined;

  async function request(text: string): Promise<{ pcm: Uint8Array; rate: number; channels: number }> {
    key ??= getKey();
    const auth = await key;
    for (let attempt = 1; ; attempt++) {
      stats.calls++;
      let res: Response;
      try {
        res = await doFetch(OPENROUTER_SPEECH_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, input: text, voice: opts.voice, response_format: 'pcm' }),
        });
      } catch (e) {
        // 連線失敗（斷線、逾時）跟 5xx 一樣退避重試
        if (attempt >= maxAttempts) throw new Error(`Gemini TTS 連不上（第 ${attempt} 次）：${(e as Error).message}`);
        await sleep(Math.min(30_000, 1000 * 2 ** (attempt - 1)));
        continue;
      }
      if (res.ok) {
        const pcm = new Uint8Array(await res.arrayBuffer());
        if (pcm.length < 2) throw new Error(`Gemini TTS 回傳空音檔（${opts.voice}）：${text.slice(0, 20)}…`);
        return { pcm, ...parsePcmType(res.headers.get('content-type')) };
      }
      const body = (await res.text().catch(() => '')).slice(0, 200);
      if (res.status === 402) throw new Error(`Gemini TTS 回 402：OpenRouter 沒有額度了，先儲值再跑（${body}）`);
      if (!RETRY_STATUS.has(res.status) || attempt >= maxAttempts) {
        throw new Error(`Gemini TTS 回 ${res.status}（第 ${attempt} 次）：${body}`);
      }
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(30_000, 1000 * 2 ** (attempt - 1)));
    }
  }

  return {
    stats,
    async synth(text) {
      mkdirSync(cacheDir, { recursive: true });
      const hash = createHash('sha256').update(`${model}\n${opts.voice}\n${text}`).digest('hex').slice(0, 20);
      const wav = join(cacheDir, `gemini-${opts.voice}-${hash}.wav`);
      if (existsSync(wav)) {
        stats.cacheHits++;
      } else {
        const { pcm, rate, channels } = await request(text);
        const tmp = `${wav}.${process.pid}.tmp`;
        writeFileSync(tmp, pcmToWav(pcm, rate, channels));
        renameSync(tmp, wav);
      }
      return { file: wav, durationMs: wavDurationMs(wav) };
    },
  };
}

/** 讀 wav 標頭算長度（只支援本檔寫的 44 byte 標準標頭）。 */
function wavDurationMs(file: string): number {
  const buf = readFileSync(file);
  const channels = buf.readUInt16LE(22);
  const rate = buf.readUInt32LE(24);
  const bits = buf.readUInt16LE(34);
  return Math.round(((buf.length - 44) / (rate * channels * (bits / 8))) * 1000);
}

/**
 * 依環境變數選 provider：TUTORIAL_TTS=gemini（聲音 TUTORIAL_TTS_VOICE，必填；模型 TUTORIAL_TTS_MODEL 可省）；
 * 其他或沒設＝macOS say（TUTORIAL_TTS_VOICE 沒設就是 Meijia）。
 */
export function ttsFromEnv(env: NodeJS.ProcessEnv = process.env): TtsProvider & { name: string; voice: string } {
  const voice = env.TUTORIAL_TTS_VOICE?.trim();
  if (env.TUTORIAL_TTS === 'gemini') {
    if (!voice) throw new Error('TUTORIAL_TTS=gemini 要配 TUTORIAL_TTS_VOICE（例如 Charon、Orus、Algenib、Alnilam、Iapetus、Kore）');
    return Object.assign(geminiProvider({ voice, model: env.TUTORIAL_TTS_MODEL?.trim() || undefined }), { name: 'gemini', voice });
  }
  return Object.assign(sayProvider(voice ? { voice } : {}), { name: 'say', voice: voice ?? 'Meijia' });
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
