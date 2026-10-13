import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireRecordSlot, assertRunComplete, claimOutDir, newRunDir, RECORDING_MARK } from '../runs.ts';

test('claimOutDir：原子建立，撞名立刻拒絕；newRunDir 每次不同', () => {
  const root = mkdtempSync(join(tmpdir(), 'tutorial-runs-'));
  try {
    const a = newRunDir(root, '3-3 學生｜繳交作業');
    const b = newRunDir(root, '3-3 學生｜繳交作業');
    assert.notEqual(a, b);
    assert.match(a, /3-3-學生-繳交作業-\d{8}-\d{6}-[a-z0-9]+$/);
    claimOutDir(a);
    assert.ok(existsSync(join(a, RECORDING_MARK)));
    assert.throws(() => claimOutDir(a), /已存在，拒絕覆蓋/);
    assert.throws(() => assertRunComplete(a), /還在錄影/);
    rmSync(join(a, RECORDING_MARK));
    assertRunComplete(a);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('錄影名額：最多 2 路，第 3 路排隊並印「等待錄影名額」，有人歸還就拿到', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tutorial-slots-'));
  try {
    const logs: string[] = [];
    const s1 = await acquireRecordSlot({ dir, max: 2, label: 'A' });
    const s2 = await acquireRecordSlot({ dir, max: 2, label: 'B' });
    let got = false;
    const p3 = acquireRecordSlot({ dir, max: 2, label: 'C', pollMs: 50, log: (m) => logs.push(m) }).then((s) => {
      got = true;
      return s;
    });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(got, false, '第 3 路要等');
    assert.ok(logs[0]?.includes('等待錄影名額') && logs[0].includes('A') && logs[0].includes('B'), logs.join('\n'));
    s1.release();
    const s3 = await p3;
    assert.equal(s3.index, s1.index);
    s2.release();
    s3.release();
    // 都歸還後馬上拿得到
    (await acquireRecordSlot({ dir, max: 2 })).release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('錄影名額：持有者程序已結束的鎖會被回收', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tutorial-slots-'));
  try {
    const { hostname } = await import('node:os');
    for (const i of [0, 1]) writeFileSync(join(dir, `slot-${i}.lock`), JSON.stringify({ pid: 999_999, host: hostname(), label: 'dead', since: 'x' }));
    const s = await acquireRecordSlot({ dir, max: 2, pollMs: 50 });
    s.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
