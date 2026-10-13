import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planMove, cursorAt, MOVE_MIN_MS, MOVE_MAX_MS, MAX_SPEED_PX_PER_MS } from '../cursor.ts';

const far = { x: 0, y: 0 };
const cases = [
  { to: { x: 30, y: 10 } }, // 很近
  { to: { x: 600, y: 300 } },
  { to: { x: 1920, y: 1000 } }, // 對角線，最遠
];

test('一般距離每段 600～900 ms；超遠距離由速度上限拉長', () => {
  for (const c of cases.slice(0, 2)) {
    const m = planMove(far, c.to, 1000);
    const d = m.endMs - m.startMs;
    assert.ok(d >= MOVE_MIN_MS && d <= MOVE_MAX_MS, `duration ${d}`);
  }
  const m = planMove(far, cases[2].to, 0);
  assert.ok(m.endMs > MOVE_MAX_MS && m.endMs < 1500, `far duration ${m.endMs}`);
});

test('路徑上任兩影格間的速度不超過上限（含緩動峰值）', () => {
  for (const c of cases) {
    const m = planMove(far, c.to, 0);
    let prev = cursorAt([m], far, 0);
    for (let t = 1000 / 30; t <= m.endMs + 1; t += 1000 / 30) {
      const p = cursorAt([m], far, t);
      const v = Math.hypot(p.x - prev.x, p.y - prev.y) / (1000 / 30);
      assert.ok(v <= MAX_SPEED_PX_PER_MS + 1e-9, `speed ${v.toFixed(3)} px/ms`);
      prev = p;
    }
  }
});

test('緩動：起點與終點速度趨近 0，路徑端點正確', () => {
  const to = { x: 800, y: 400 };
  const m = planMove(far, to, 0);
  const a = cursorAt([m], far, 0);
  const b = cursorAt([m], far, 10);
  const end = cursorAt([m], far, m.endMs);
  assert.deepEqual(a, far);
  assert.ok(Math.hypot(b.x, b.y) < 2, 'starts slowly');
  assert.deepEqual(end, to);
  assert.deepEqual(cursorAt([m], far, m.endMs + 5000), to);
});

test('多段移動之間游標停在上一段終點', () => {
  const m1 = planMove({ x: 0, y: 0 }, { x: 100, y: 100 }, 0);
  const m2 = planMove(m1.to, { x: 500, y: 100 }, m1.endMs + 1000);
  const p = cursorAt([m1, m2], { x: 0, y: 0 }, m1.endMs + 500);
  assert.deepEqual(p, { x: 100, y: 100 });
});

import { captureQuality } from '../frames.ts';

test('captureQuality：每秒張數與最大間隔，超標的步驟會被標記', () => {
  const smooth = Array.from({ length: 300 }, (_, i) => i * 33); // 30 張／秒
  const q1 = captureQuality(smooth, [{ index: 1, startMs: 0, endMs: 9900 }], 9900);
  assert.ok(q1.ok && q1.fps > 29 && q1.maxGapMs <= 34, JSON.stringify(q1));
  // 第二步中間停了 120 ms
  const stall = smooth.filter((t) => t < 5000 || t > 5120);
  const q2 = captureQuality(stall, [{ index: 1, startMs: 0, endMs: 4900 }, { index: 2, startMs: 4900, endMs: 9900 }], 9900);
  assert.equal(q2.ok, false);
  assert.equal(q2.steps[0].ok, true);
  assert.equal(q2.steps[1].ok, false);
  assert.ok(q2.steps[1].maxGapMs >= 120);
  assert.ok(q2.warnings[0].startsWith('步驟 2'), q2.warnings.join());
  // 每秒只有 20 張
  const slow = Array.from({ length: 200 }, (_, i) => i * 50);
  assert.equal(captureQuality(slow, [], 9950).ok, false);
});
