// checks.ts 的固定時間案例（不開瀏覽器）：每一條檢查放得過什麼、一定抓到什麼。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GAP_WARN_MS, MIN_FPS, type CaptureQuality } from '../frames.ts';
import { assertQualityConsistent, checkClick, checkFrames, expectedCapture, FRAME_MS, frameViolations, RESIDUAL_MS, slotOf } from './checks.ts';

// ── quality 一致 ─────────────────────────────────────

/** 整段與唯一一步同樣的數字；ok／warnings 預設照數字給，反例再覆寫。 */
function quality(fps: number, maxGapMs: number, over: Partial<CaptureQuality> = {}): CaptureQuality {
  const ok = fps >= MIN_FPS && maxGapMs <= GAP_WARN_MS;
  const span = { fps, maxGapMs, p95GapMs: Math.min(maxGapMs, 40), ok };
  return { ...span, steps: [{ index: 0, ...span }], warnings: ok ? [] : [`步驟 0：截圖 ${fps} 張／秒、最大間隔 ${maxGapMs} ms`], ...over };
}
const opts = { strict: false, abortLimit: 300 };

test('quality 一致：達標 → ok=true、沒警告，回傳 true；沒達標 → ok=false、有警告，回傳 false（strict 時才失敗）', () => {
  assert.equal(assertQualityConsistent('達標', quality(34, 38), opts), true);
  assert.equal(assertQualityConsistent('張數不足', quality(22, 48), opts), false);
  assert.equal(assertQualityConsistent('間隔過大', quality(30, 71), opts), false);
  assert.throws(() => assertQualityConsistent('strict', quality(22, 48), { ...opts, strict: true }), /TUTORIAL_STRICT_QUALITY/);
});

test('quality 反例：沒達標、有警告、卻 ok=true → 失敗（合寫成「ok 且無警告 === 達標」會放過這個）', () => {
  assert.throws(() => assertQualityConsistent('旗標錯', quality(22, 48, { ok: true }), opts), /沒達標.*quality\.ok=true/);
});

test('quality 反例：沒達標、ok=false、卻漏掉警告 → 失敗', () => {
  assert.throws(() => assertQualityConsistent('漏警告', quality(22, 48, { warnings: [] }), opts), /沒達標卻沒有警告/);
});

test('quality 反例：達標卻 ok=false、達標卻有警告、超過中止門檻卻沒中止 → 各自失敗', () => {
  assert.throws(() => assertQualityConsistent('達標卻 false', quality(34, 38, { ok: false }), opts), /達標.*quality\.ok=false/);
  assert.throws(() => assertQualityConsistent('達標卻警告', quality(34, 38, { warnings: ['多餘'] }), opts), /達標卻有警告/);
  assert.throws(() => assertQualityConsistent('沒中止', quality(20, 320, { ok: false }), opts), /超過中止門檻 300 ms 卻沒中止/);
});

// ── 逐格對齊：固定時間的案例 ──────────────────────────

/** 每 40 ms 一張（25 張／秒，單路標準的下限）、2000～2160 ms 之間少三張 → 別處有一個 160 ms 的間隔。 */
const CAPS = Array.from({ length: 150 }, (_, i) => i * 40).filter((c) => c <= 2000 || c >= 2160);
/** 每一格的理想內容時間：這一格應選的截圖，內容比截圖舊 5 ms（一個 rAF 以內）。 */
const codesFor = (caps: readonly number[]) => Array.from({ length: 180 }, (_, k) => expectedCapture(caps, k * FRAME_MS) - 5);
const RANGE = [{ fromMs: 100, toMs: 5900 }];
const inHole = (slotMs: number) => slotMs > 2000 - FRAME_MS && slotMs < 2160 + FRAME_MS;

test('逐格：理想內容全過；上限是局部的——別處一個 160 ms 間隔不會抬高其他格（其他格上限 < 55 ms，舊的整章規則會變 190）', () => {
  const checks = checkFrames(CAPS, codesFor(CAPS), RANGE);
  assert.ok(checks.length > 150, `格數 ${checks.length}`);
  assert.deepEqual(frameViolations(checks), []);
  const outside = checks.filter((c) => !inHole(c.slotMs));
  const inside = checks.filter((c) => inHole(c.slotMs));
  assert.ok(outside.length > 140 && inside.length >= 4, `${outside.length}／${inside.length}`);
  // 40 ms 間隔：量化誤差 ≤ 40 − 16.7，上限 ≤ 23.3 ＋ 30
  assert.ok(outside.every((c) => c.boundMs < 55 && c.gapMs === 40), `上限 ${Math.max(...outside.map((c) => c.boundMs)).toFixed(1)}`);
  assert.ok(inside.some((c) => c.boundMs > 150 && c.gapMs === 160), '洞裡那幾格的上限才跟著 160 ms 的間隔走');
});

test('逐格：任何一格選錯一張截圖（差一個局部間隔，往前或往後）一定在那一格失敗，其他格不受影響', () => {
  const ideal = codesFor(CAPS);
  const checks = checkFrames(CAPS, ideal, RANGE);
  for (const c of checks) {
    const i = CAPS.indexOf(c.captureMs);
    for (const wrong of [CAPS[i - 1], CAPS[i + 1]]) {
      if (wrong == null) continue;
      const codes = [...ideal];
      codes[c.k] = wrong - 5;
      const bad = checkFrames(CAPS, codes, RANGE).filter((x) => !x.ok).map((x) => x.k);
      assert.deepEqual(bad, [c.k], `第 ${c.k} 格改成 ${wrong} 那張截圖（應選 ${c.captureMs}）`);
    }
  }
});

test('逐格：一格錯位 150 ms、其他 170 多格完美（中位數約 12 ms，recorder.test.ts 的中位數門檻 25 抓不到）→ 失敗，訊息指出那一格與局部上限', () => {
  const codes = codesFor(CAPS);
  const k = 120; // 4.00 秒，離 160 ms 的洞很遠
  codes[k] -= 150;
  const checks = checkFrames(CAPS, codes, RANGE);
  const abs = checks.map((c) => Math.abs(c.errMs)).sort((a, b) => a - b);
  // 40 ms 間隔的量化誤差 −11.7～28.3 ms：中位數約 12 ms，整章只看中位數或整章上限（舊規則 160＋30＝190）都放得過這一格
  assert.ok(abs[abs.length >> 1] < 15, `中位數 ${abs[abs.length >> 1]}`);
  assert.ok(abs.at(-1)! < 190, `舊的整章上限 190 ms 放得過：最大 ${abs.at(-1)}`);
  const v = frameViolations(checks);
  assert.equal(v.length, 1);
  assert.match(v[0], /^#120（4\.00 秒）誤差 /);
  // 第 120 格（4000 ms）剛好落在 4000 那張截圖上：量化誤差 0，局部上限就是殘差 30
  assert.match(v[0], /超過這一格的局部上限 30\.0 ms（應選 4000\.0 ms 那張截圖、局部間隔 40 ms；內容時間 3845、殘差 155\.0 ms）$/);
  // 殘差剛好在容許邊緣：30 過、31 不過
  const edge = codesFor(CAPS);
  edge[k] = expectedCapture(CAPS, k * FRAME_MS) - RESIDUAL_MS;
  assert.deepEqual(frameViolations(checkFrames(CAPS, edge, RANGE)), []);
  edge[k] -= 1;
  assert.equal(frameViolations(checkFrames(CAPS, edge, RANGE)).length, 1);
});

test('逐格：條碼 0（還沒畫出來）的格跳過；每段最後一格不算', () => {
  const codes = codesFor(CAPS);
  codes[30] = 0;
  const ks = checkFrames(CAPS, codes, [{ fromMs: 1000, toMs: 1100 }]).map((c) => c.k);
  // 1000/33.3 = 30 → 第 30 格跳過；(k+1)×33.3 < 1100 → 最後是第 31 格
  assert.deepEqual(ks, [31]);
});

// ── 點擊變色 ─────────────────────────────────────────

test('點擊：黑格落在點擊前兩張到後兩張截圖之間都算對；再早一張、再晚一張、點擊時間平移 ±150 ms 一定失敗', () => {
  // 點在 3010 ms：前兩張 2960、3000，後兩張 3040、3080；頁面在 3005 畫黑 → 第一張黑截圖 3040 → 第 91 格（3033 ms）
  const at = 3010;
  const kOf = (c: number) => Math.round(slotOf(c) / FRAME_MS);
  // 3120 那張要到第 94 格才出現（第 93 格的中點 3116.7 還沒到它）；第 93 格仍是 3080 那張的重複格
  assert.deepEqual([kOf(2960), kOf(3000), kOf(3040), kOf(3080), kOf(3120)], [89, 90, 91, 92, 94]);
  const ok = checkClick(CAPS, at, 91);
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.deepEqual([ok.before, ok.after], [[2960, 3000], [3040, 3080]]);
  assert.ok(Math.abs(ok.errMs - 23.3) < 0.1 && Math.abs(ok.loMs - -43.3) < 0.1 && Math.abs(ok.hiMs - 56.7) < 0.1, JSON.stringify(ok));
  assert.ok(checkClick(CAPS, at, 90).ok && checkClick(CAPS, at, 89).ok, '點擊前最後兩張（atMs 記在畫出下一格、evaluate 來回之後）');
  assert.ok(checkClick(CAPS, at, 92).ok, '點擊後第二張（殘差）');
  assert.ok(!checkClick(CAPS, at, 88).ok && !checkClick(CAPS, at, 93).ok && !checkClick(CAPS, at, 94).ok, '再早一張、再晚一張（含 3080 的重複格）都不算');
  assert.ok(!checkClick(CAPS, at + 150, 91).ok, '點擊時間晚 150 ms');
  assert.ok(!checkClick(CAPS, at - 150, 91).ok, '點擊時間早 150 ms');
  assert.ok(!checkClick(CAPS, at, -1).ok, '沒有黑格');
  // 點擊落在 160 ms 的洞裡：範圍跟著洞走（前兩張 1960、2000，後兩張 2160、2200），平移 150 仍然超出
  const hole = checkClick(CAPS, 2100, kOf(2160));
  assert.ok(hole.ok && hole.before[1] === 2000 && hole.after[1] === 2200, JSON.stringify(hole));
  assert.ok(!checkClick(CAPS, 2100 + 150, kOf(2160)).ok && !checkClick(CAPS, 2100 - 150, kOf(2160)).ok);
});
