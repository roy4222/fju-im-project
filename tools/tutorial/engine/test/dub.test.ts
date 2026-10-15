import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkMaxTempo, dubBatch, dubChapter, fitSpeech, loudnessGainDb, MAX_TEMPO, measureLoudness } from '../dub.ts';
import type { ChapterEvents } from '../events.ts';
import type { ChapterMeta } from '../meta.ts';
import { geminiProvider, probeDurationMs, TtsQuotaError, type TtsProvider } from '../tts.ts';

test('fit：短的照原速（後面自然是靜音）、可用時間＝到下一句起播前 0.2 秒、最後一句到 clip 結束前', () => {
  const { fits, over } = fitSpeech(
    [
      { index: 2, startMs: 10_000, durationMs: 4000 },
      { index: 1, startMs: 250, durationMs: 6000 },
    ],
    16_000,
  );
  assert.deepEqual(over, []);
  assert.deepEqual(
    fits.map((f) => [f.index, f.availableMs, f.tempo, f.playedMs]),
    [
      [1, 9550, 1, 6000],
      [2, 5800, 1, 4000],
    ],
  );
});

test('fit：長的用 atempo 加速到剛好放得下（≤ 1.3 倍）', () => {
  const { fits, over } = fitSpeech([
    { index: 1, startMs: 0, durationMs: 11_000 },
    { index: 2, startMs: 10_200, durationMs: 1000 },
  ], 20_000);
  assert.deepEqual(over, []);
  assert.equal(fits[0].availableMs, 10_000);
  assert.equal(fits[0].tempo, 1.1);
  assert.equal(fits[0].playedMs, 10_000);
  // 進位到千分位：加速後一定不超過可用時間
  const odd = fitSpeech([{ index: 1, startMs: 0, durationMs: 10_001 }], 9_200).fits[0];
  assert.ok(odd.tempo > 1 && odd.tempo <= MAX_TEMPO);
  assert.ok(odd.durationMs / odd.tempo <= odd.availableMs);
});

test('fit：要超過 1.3 倍的列進 over（不硬塞），剛好 1.3 倍可以；--max-tempo 可以調低', () => {
  const items = [
    { index: 1, startMs: 0, durationMs: 13_000 },
    { index: 2, startMs: 10_200, durationMs: 13_100 },
    { index: 3, startMs: 20_400, durationMs: 1000 },
  ];
  assert.equal(MAX_TEMPO, 1.3);
  assert.deepEqual(fitSpeech(items, 30_000).over.map((f) => [f.index, f.tempo]), [[2, 1.31]]);
  assert.deepEqual(fitSpeech(items, 30_000, { maxTempo: 1.25 }).over.map((f) => f.index), [1, 2]);
});

test('加速上限：非有限值、小於 1、大於 1.3 都拒絕（API 與 fitSpeech）', () => {
  for (const bad of [2, 1.31, Number.NaN, Number.POSITIVE_INFINITY, 0.9]) {
    assert.throws(() => checkMaxTempo(bad), /1～1\.3/, String(bad));
    assert.throws(() => fitSpeech([{ index: 1, startMs: 0, durationMs: 1000 }], 5000, { maxTempo: bad }), /1～1\.3/);
  }
  assert.equal(checkMaxTempo(1.3), 1.3);
  assert.equal(checkMaxTempo(1.25), 1.25);
});

test('響度增益：補到目標 LUFS、峰值不超過 −1 dBFS、量不到就不動', () => {
  assert.equal(loudnessGainDb({ lufs: -20, peakDb: -10 }), 4);
  assert.equal(loudnessGainDb({ lufs: -20, peakDb: -3 }), 2);
  assert.equal(loudnessGainDb({ lufs: -12, peakDb: -2 }), -4);
  assert.equal(loudnessGainDb({ lufs: Number.NEGATIVE_INFINITY, peakDb: -99 }), 0);
});

// ── 實際用 ffmpeg 重配一段（假 TTS：每句是指定長度的正弦波） ──

function makeChapter(dir: string, id = '9-9'): ChapterEvents {
  mkdirSync(dir, { recursive: true });
  const ev: ChapterEvents = {
    version: 1,
    id,
    chapter: '測試｜重配音',
    output: { width: 320, height: 180, chromeHeight: 20, captionHeight: 30 },
    page: { width: 320, height: 130, zoom: 1 },
    clip: { file: 'clip.mp4', durationMs: 6000, fps: 30, captureLatencyMs: 0 },
    displayOrigin: 'test.local',
    cursorStart: { x: 0, y: 0 },
    steps: [
      { index: 1, caption: '第一步', narration: '第一步先打開首頁，看到下一步框。', startMs: 0, endMs: 3000, audio: { file: 'audio/step-01.wav', startMs: 250, durationMs: 2000 } },
      { index: 2, caption: '沒有配音', narration: '', startMs: 3000, endMs: 3500 },
      { index: 3, caption: '第三步', narration: '再看繳交歷史。', startMs: 3500, endMs: 6000, audio: { file: 'audio/step-03.wav', startMs: 3750, durationMs: 1500 } },
    ],
    events: [],
  };
  writeFileSync(join(dir, 'events.json'), JSON.stringify(ev));
  // 成品：2.5 秒標題卡＋6 秒 clip，畫面是會動的測試圖（逐格都不同）
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=8.5', '-f', 'lavfi', '-i', 'sine=f=200:d=8.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(dir, `${id}.mp4`)]);
  return ev;
}

/**
 * 假 TTS：依文字查長度與音量（dB），產生 440 Hz 正弦波 wav；前後各墊 0.3 秒（像 Gemini）：
 * 0.05 秒靜音＋0.25 秒比語音小 33 dB 的「換氣聲」（正規化後約 −48 dB）（舊門檻 −50 dB 削不掉的那種）。記錄被叫了幾次。
 */
function toneProvider(dir: string, byText: Record<string, number | [ms: number, db: number]>): TtsProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async synth(text) {
      calls.push(text);
      mkdirSync(dir, { recursive: true });
      const [ms, db] = typeof byText[text] === 'number' ? [byText[text], 0] : byText[text];
      const file = join(dir, `tone-${calls.length}.wav`);
      // 語音振幅 A（0.125＝−18 dBFS 峰值，再加 db）；換氣聲小 33 dB
      const A = 0.125 * 10 ** (db / 20);
      const B = A * 10 ** (-33 / 20);
      const T = ms / 1000;
      const expr = `if(between(t,0.05,0.3)+between(t,${T + 0.3},${T + 0.55}),${B}*sin(2*PI*150*t),if(between(t,0.3,${T + 0.3}),${A}*sin(2*PI*440*t),0))`;
      execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `aevalsrc='${expr}':s=24000:d=${T + 0.6}`, '-ac', '1', '-c:a', 'pcm_s16le', file]);
      return { file, durationMs: await probeDurationMs(file) };
    },
  };
}

/** 影片 [a, b) 秒的整體響度（LUFS）。 */
async function lufsAt(f: string, a: number, b: number, tmp: string): Promise<number> {
  const cut = join(tmp, `cut-${a}-${b}.wav`);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-ss', String(a), '-t', String(b - a), '-i', f, '-map', '0:a', cut]);
  return (await measureLoudness(cut)).lufs;
}

const framemd5 = (f: string) =>
  execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-map', '0:v', '-c', 'copy', '-f', 'framemd5', '-'], { encoding: 'utf8' })
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(',').at(-1)!.trim());

/** [a, b) 秒的音量（dB，RMS；astats 印在 stderr）。 */
function rms(f: string, a: number, b: number): number {
  const { stderr } = spawnSync('ffmpeg', ['-v', 'info', '-ss', String(a), '-t', String(b - a), '-i', f, '-map', '0:a', '-af', 'astats=measure_overall=RMS_level:measure_perchannel=0', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = [...stderr.matchAll(/RMS level dB: (-?[\d.]+|-inf)/g)].at(-1);
  return !m || m[1] === '-inf' ? -Infinity : Number(m[1]);
}

test('重配一段：影像逐格不變、長度不變、新配音接在原起播點、字幕對得上聲音、不動來源資料夾', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dub-test-'));
  try {
    const src = join(root, 'chapters', '9-9');
    makeChapter(src);
    const before = readFileSync(join(src, '9-9.mp4'));
    // 第一步 4 秒（削掉頭尾靜音與換氣聲、各留 50 ms 後 4.1 秒；可用 3750−250−200＝3300 ms → 1.243 倍）、
    // 第三步 1 秒（1.1 秒，原速），而且小 12 dB（正規化後要一樣大聲）
    const tts = toneProvider(join(root, 'tts'), { '第一步先打開首頁，看到下一步框。': 4000, '再看繳交歷史。': [1000, -12] });
    const out = join(root, 'dub-Test', '9-9');
    const r = await dubChapter({ dir: src, tts, outDir: out });

    assert.equal(tts.calls.length, 2, '沒有配音的步驟不念');
    assert.equal(r.file, join(out, '9-9.mp4'));
    assert.deepEqual(framemd5(r.file), framemd5(join(src, '9-9.mp4')), '影像要逐格一樣');
    assert.ok(Math.abs((await probeDurationMs(r.file)) - 8500) < 60);
    assert.deepEqual(readFileSync(join(src, '9-9.mp4')), before, '來源不能被改');

    assert.deepEqual(r.steps.map((s) => [s.index, s.tempo]), [[1, 1.243], [3, 1]]);
    assert.equal(r.maxTempo, 1.243);
    assert.ok(Math.abs(r.steps[0].newMs - 4100) < 30, `削完靜音 ${r.steps[0].newMs} ms`);
    const meta = JSON.parse(readFileSync(join(out, 'chapter.json'), 'utf8')) as ChapterMeta;
    assert.equal(meta.file, '9-9.mp4');
    const s1 = meta.steps[0].audio!;
    const s3 = meta.steps[2].audio!;
    assert.equal(s1.startMs, 2750);
    assert.ok(s1.durationMs <= 3300 && s1.durationMs > 3200, `加速後 ${s1.durationMs} ms`);
    assert.equal(s3.startMs, 6250);
    assert.ok(Math.abs(s3.durationMs - 1100) < 30);
    assert.equal(meta.steps[1].audio, undefined);

    const srt = readFileSync(r.srt, 'utf8');
    assert.match(srt, /^1\n00:00:02,750 --> /);
    assert.match(srt, /00:00:06,250 --> 00:00:07,3\d\d\n再看繳交歷史。\n/);
    assert.ok(readFileSync(r.vtt, 'utf8').startsWith('WEBVTT'));

    // 聲音對得上字幕：字幕期間有聲、句與句之間的空檔靜音、標題卡靜音
    assert.ok(rms(r.file, 2.85, 5.9) > -30, '第一句期間要有聲音');
    assert.ok(rms(r.file, 2.82, 2.92) > -30, '頭的靜音削掉了：字幕一出現就有聲音');
    assert.ok(rms(r.file, 6.1, 6.2) < -60, '第一句結束到第三句起播之間要安靜');
    assert.ok(rms(r.file, 6.35, 7.15) > -30, '第三句期間要有聲音');
    assert.ok(rms(r.file, 0.1, 2.6) < -60, '標題卡沒有配音');

    // 響度：兩句原本差 12 dB，正規化後都在 −16 LUFS 附近、彼此差 ≤ 1 LU
    assert.ok(Math.abs(r.steps[1].gainDb - r.steps[0].gainDb - 12) < 1, `增益 ${r.steps.map((s) => s.gainDb)}`);
    const l1 = await lufsAt(r.file, 2.8, 5.9, root);
    const l3 = await lufsAt(r.file, 6.3, 7.3, root);
    assert.ok(Math.abs(l1 + 16) <= 1.5 && Math.abs(l3 + 16) <= 1.5, `響度 ${l1} / ${l3}`);
    assert.ok(Math.abs(l1 - l3) <= 1, `兩句差 ${Math.abs(l1 - l3)} LU`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('重配一段：有一句超過 1.3 倍就報錯列出（3 位小數）、不輸出影片；輸出不能寫回來源；上限設太高直接拒絕、不打 TTS', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dub-test-'));
  try {
    const src = join(root, 'chapters', '9-9');
    makeChapter(src);
    const tts = toneProvider(join(root, 'tts'), { '第一步先打開首頁，看到下一步框。': 4500, '再看繳交歷史。': 1000 });
    const out = join(root, 'dub-Test', '9-9');
    await assert.rejects(dubChapter({ dir: src, tts, outDir: out }), (e: Error) => /第 1 步/.test(e.message) && /1\.394 倍/.test(e.message) && !/第 3 步/.test(e.message));
    assert.ok(!existsSync(join(out, '9-9.mp4')));
    const report = JSON.parse(readFileSync(join(out, 'dub.json'), 'utf8'));
    assert.equal(report.ok, false);
    await assert.rejects(dubChapter({ dir: src, tts, outDir: src }), /不能寫回來源/);
    const calls = tts.calls.length;
    await assert.rejects(dubChapter({ dir: src, tts, outDir: out, maxTempo: 2 }), /1～1\.3/);
    await assert.rejects(dubBatch([src], { tts, outRoot: join(root, 'dub-Test'), maxTempo: Number.NaN }), /1～1\.3/);
    assert.equal(tts.calls.length, calls, '上限不合法就不念');
    // CLI：--max-tempo 2、abc 都以代碼 2 結束、不開始
    const cli = join(import.meta.dirname, '..', 'cli.ts');
    for (const v of ['2', 'abc']) {
      const r = spawnSync(process.execPath, [cli, 'dub', '--max-tempo', v, '--out-root', join(root, 'cli'), src], { encoding: 'utf8', env: { ...process.env, TUTORIAL_TTS: '' } });
      assert.equal(r.status, 2, `--max-tempo ${v}：${r.stderr}`);
      assert.match(r.stderr, /1～1\.3/);
    }
    assert.ok(!existsSync(join(root, 'cli')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('批次：第一段 402（沒額度）就整批停下，API 呼叫數維持 1、後面的段列為沒做', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dub-test-'));
  try {
    const a = join(root, 'chapters', '9-1');
    const b = join(root, 'chapters', '9-2');
    makeChapter(a, '9-1');
    makeChapter(b, '9-2');
    let calls = 0;
    const tts = geminiProvider({
      voice: 'Test',
      cacheDir: join(root, 'cache'),
      apiKey: async () => 'FAKE-KEY',
      sleep: async () => {},
      fetch: (async () => {
        calls++;
        return new Response('Insufficient credits', { status: 402 });
      }) as typeof fetch,
    });
    const errors: Error[] = [];
    const r = await dubBatch([a, b], { tts, outRoot: join(root, 'dub-Test'), onFail: (_id, e) => errors.push(e) });
    assert.equal(calls, 1);
    assert.equal(tts.stats.calls, 1);
    assert.deepEqual(r.failed, ['9-1']);
    assert.deepEqual(r.skipped, ['9-2']);
    assert.ok(r.quota && /402/.test(r.quota));
    assert.ok(errors[0] instanceof TtsQuotaError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
