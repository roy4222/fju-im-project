import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GEMINI_TTS_MODEL, geminiProvider, OPENROUTER_SPEECH_URL, parsePcmType, pcmToWav, redactSecrets, TtsQuotaError, ttsFromEnv } from '../tts.ts';

const KEY = 'sk-or-test-secret';

type Call = { url: string; body: Record<string, unknown>; auth: string | null };

/** 假 HTTP：依序回 responses（status、可選 headers）；200 回 ms 長的 24 kHz 靜音 PCM。 */
function fakeFetch(responses: { status: number; ms?: number; headers?: Record<string, string>; body?: string }[]) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)), auth: headers.get('authorization') });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (r.status === 200) {
      const samples = Math.round(((r.ms ?? 1000) / 1000) * 24000);
      return new Response(new Uint8Array(samples * 2), { status: 200, headers: { 'content-type': 'audio/pcm;rate=24000;channels=1', ...r.headers } });
    }
    return new Response(r.body ?? `{"error":"${r.status}"}`, { status: r.status, headers: r.headers });
  }) as typeof fetch;
  return { fn, calls };
}

const tmp = () => mkdtempSync(join(tmpdir(), 'tts-test-'));
const noSleep = async () => {};

test('pcmToWav：44 byte 標頭、24 kHz 單聲道 16 bit、資料長度正確', () => {
  const pcm = new Uint8Array(48000); // 1 秒
  const wav = pcmToWav(pcm, 24000, 1);
  assert.equal(wav.length, 44 + 48000);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(4), 36 + 48000);
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.equal(wav.readUInt32LE(28), 48000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.toString('ascii', 36, 40), 'data');
  assert.equal(wav.readUInt32LE(40), 48000);
  assert.deepEqual(parsePcmType('audio/pcm;rate=24000;channels=1'), { rate: 24000, channels: 1 });
  assert.deepEqual(parsePcmType(null), { rate: 24000, channels: 1 });
});

test('Gemini：請求格式、pcm→wav、長度；同文字同聲音走快取不再打 API，換聲音才打', async () => {
  const dir = tmp();
  try {
    const { fn, calls } = fakeFetch([{ status: 200, ms: 1500 }]);
    const p = geminiProvider({ voice: 'Charon', cacheDir: dir, fetch: fn, apiKey: async () => KEY, sleep: noSleep });
    const a = await p.synth('從首頁找到要交的作業', '/unused');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, OPENROUTER_SPEECH_URL);
    assert.deepEqual(calls[0].body, { model: GEMINI_TTS_MODEL, input: '從首頁找到要交的作業', voice: 'Charon', response_format: 'pcm' });
    assert.equal(calls[0].auth, `Bearer ${KEY}`);
    assert.equal(a.durationMs, 1500);
    assert.ok(a.file.startsWith(dir));
    const head = readFileSync(a.file);
    assert.equal(head.toString('ascii', 0, 4), 'RIFF');
    assert.equal(head.readUInt32LE(24), 24000);

    const b = await p.synth('從首頁找到要交的作業', '/unused');
    assert.equal(b.file, a.file);
    assert.equal(calls.length, 1, '同一句第二次要讀快取');
    // 另一個 provider 實例（重跑）也一樣讀快取
    const p2 = geminiProvider({ voice: 'Charon', cacheDir: dir, fetch: fn, apiKey: async () => KEY });
    await p2.synth('從首頁找到要交的作業', '/unused');
    assert.equal(calls.length, 1);
    assert.deepEqual(p2.stats, { calls: 0, cacheHits: 1 });

    const kore = geminiProvider({ voice: 'Kore', cacheDir: dir, fetch: fn, apiKey: async () => KEY });
    const c = await kore.synth('從首頁找到要交的作業', '/unused');
    assert.equal(calls.length, 2, '換聲音要重念');
    assert.notEqual(c.file, a.file);
    const other = geminiProvider({ voice: 'Charon', model: 'google/other-tts', cacheDir: dir, fetch: fn, apiKey: async () => KEY });
    await other.synth('從首頁找到要交的作業', '/unused');
    assert.equal(calls.length, 3, '換模型要重念');
    assert.equal(readdirSync(dir).filter((f) => f.endsWith('.tmp')).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Gemini：429 退避後重試成功（有 Retry-After 照它），502 也重試', async () => {
  const dir = tmp();
  try {
    const waits: number[] = [];
    const { fn, calls } = fakeFetch([{ status: 429, headers: { 'retry-after': '3' } }, { status: 429 }, { status: 502 }, { status: 200, ms: 800 }]);
    const p = geminiProvider({ voice: 'Orus', cacheDir: dir, fetch: fn, apiKey: async () => KEY, sleep: async (ms) => void waits.push(ms) });
    const s = await p.synth('待繳分頁', '/unused');
    assert.equal(s.durationMs, 800);
    assert.equal(calls.length, 4);
    assert.deepEqual(waits, [3000, 2000, 4000]);
    assert.deepEqual(p.stats, { calls: 4, cacheHits: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Gemini：連線失敗（fetch 丟錯）也退避重試', async () => {
  const dir = tmp();
  try {
    const ok = fakeFetch([{ status: 200, ms: 500 }]);
    let n = 0;
    const flaky = (async (url: string | URL | Request, init?: RequestInit) => {
      if (n++ === 0) throw new TypeError('fetch failed');
      return ok.fn(url, init);
    }) as typeof fetch;
    const p = geminiProvider({ voice: 'Orus', cacheDir: dir, fetch: flaky, apiKey: async () => KEY, sleep: noSleep });
    assert.equal((await p.synth('斷線', '/unused')).durationMs, 500);
    assert.equal(p.stats.calls, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Gemini：429 一直來就在 maxAttempts 次後放棄；402 沒額度直接停、不重試；錯誤訊息不含金鑰', async () => {
  const dir = tmp();
  try {
    const busy = fakeFetch([{ status: 429 }]);
    const p = geminiProvider({ voice: 'Orus', cacheDir: dir, fetch: busy.fn, apiKey: async () => KEY, sleep: noSleep, maxAttempts: 3 });
    await assert.rejects(p.synth('一', '/unused'), (e: Error) => /429/.test(e.message) && !e.message.includes(KEY));
    assert.equal(busy.calls.length, 3);

    const broke = fakeFetch([{ status: 402, body: '{"error":"Insufficient credits"}' }]);
    const q = geminiProvider({ voice: 'Orus', cacheDir: dir, fetch: broke.fn, apiKey: async () => KEY, sleep: noSleep });
    await assert.rejects(q.synth('二', '/unused'), (e: Error) => e instanceof TtsQuotaError && /402/.test(e.message) && /額度/.test(e.message) && !e.message.includes(KEY));
    assert.equal(broke.calls.length, 1);

    const bad = fakeFetch([{ status: 400, body: 'mp3 not supported' }]);
    const r = geminiProvider({ voice: 'Orus', cacheDir: dir, fetch: bad.fn, apiKey: async () => KEY, sleep: noSleep });
    await assert.rejects(r.synth('三', '/unused'), /400/);
    assert.equal(bad.calls.length, 1);
    assert.equal(readdirSync(dir).length, 0, '失敗不留快取檔');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ttsFromEnv：gemini 要聲音；沒設就是 say', () => {
  assert.throws(() => ttsFromEnv({ TUTORIAL_TTS: 'gemini' }), /TUTORIAL_TTS_VOICE/);
  const g = ttsFromEnv({ TUTORIAL_TTS: 'gemini', TUTORIAL_TTS_VOICE: 'Charon' });
  assert.equal(g.name, 'gemini');
  assert.equal(g.voice, 'Charon');
  const s = ttsFromEnv({});
  assert.equal(s.name, 'say');
  assert.equal(s.voice, 'Meijia');
});

test('Gemini：收到標頭後讀 body 斷線、HTTP 520 都退避重試', async () => {
  for (const scenario of ['body-disconnect', 'http-520'] as const) {
    const dir = tmp();
    try {
      const ok = fakeFetch([{ status: 200, ms: 500 }]);
      let n = 0;
      const flaky = (async (url: string | URL | Request, init?: RequestInit) => {
        if (n++ === 0) {
          if (scenario === 'http-520') return new Response('Unknown upstream error', { status: 520 });
          const body = new ReadableStream({ start: (c) => c.error(new TypeError('terminated')) });
          return new Response(body, { status: 200, headers: { 'content-type': 'audio/pcm;rate=24000;channels=1' } });
        }
        return ok.fn(url, init);
      }) as typeof fetch;
      const p = geminiProvider({ voice: 'Orus', cacheDir: dir, fetch: flaky, apiKey: async () => KEY, sleep: noSleep });
      assert.equal((await p.synth(scenario, '/unused')).durationMs, 500, scenario);
      assert.equal(p.stats.calls, 2, scenario);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('Gemini：HTTP 錯誤內容或連線錯誤裡帶著金鑰，丟出的訊息都遮掉（含 sk-or- 開頭、Bearer 後面的字）', async () => {
  const fake = 'FAKE-REVIEW-KEY-DO-NOT-USE';
  const cases: [string, typeof fetch][] = [
    ['http-401', (async () => new Response(`Invalid authorization: ${fake}`, { status: 401 })) as typeof fetch],
    ['http-500', (async () => new Response(`upstream saw Bearer ${fake}`, { status: 500 })) as typeof fetch],
    ['transport', (async () => { throw new Error(`proxy rejected Bearer ${fake} and key ${fake}`); }) as typeof fetch],
    ['quota', (async () => new Response(`no credits for ${fake}`, { status: 402 })) as typeof fetch],
  ];
  for (const [name, f] of cases) {
    const dir = tmp();
    try {
      const p = geminiProvider({ voice: 'Orus', cacheDir: dir, fetch: f, apiKey: async () => fake, sleep: noSleep, maxAttempts: 2 });
      await assert.rejects(p.synth(name, '/unused'), (e: Error) => {
        assert.ok(!e.message.includes(fake), `${name} 洩漏金鑰：${e.message}`);
        assert.match(e.message, /\*\*\*/, name);
        return true;
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  assert.equal(redactSecrets('key sk-or-v1-abc_DEF-123 end'), 'key sk-or-*** end');
  assert.equal(redactSecrets('Authorization: Bearer abc.def'), 'Authorization: Bearer ***');
  assert.equal(redactSecrets('x MYKEY y MYKEY', ['MYKEY']), 'x *** y ***');
});
