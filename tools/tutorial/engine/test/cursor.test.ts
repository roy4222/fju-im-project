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
