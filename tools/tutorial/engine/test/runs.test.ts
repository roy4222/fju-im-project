import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { acquireRecordSlot, assertRunComplete, claimOutDir, newRunDir, probeRecordSlots, RECORDING_MARK } from '../runs.ts';

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

test('錄影名額預設 1 路：第 2 路排隊；TUTORIAL_RECORD_SLOTS=2 可以開第 2 路', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tutorial-slots-'));
  const saved = process.env.TUTORIAL_RECORD_SLOTS;
  delete process.env.TUTORIAL_RECORD_SLOTS;
  try {
    const s1 = await acquireRecordSlot({ dir, label: 'A', pollMs: 50 });
    let got = false;
    const logs: string[] = [];
    const p2 = acquireRecordSlot({ dir, label: 'B', pollMs: 50, log: (m) => logs.push(m) }).then((s) => {
      got = true;
      return s;
    });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(got, false, '預設 1 路：第 2 路要等');
    assert.ok(logs[0]?.includes('同時最多 1 路'), logs.join('\n'));
    s1.release();
    (await p2).release();
    process.env.TUTORIAL_RECORD_SLOTS = '2';
    const a = await acquireRecordSlot({ dir, label: 'A' });
    const b = await acquireRecordSlot({ dir, label: 'B' }); // 不用等
    assert.notEqual(a.index, b.index);
    a.release();
    b.release();
  } finally {
    if (saved == null) delete process.env.TUTORIAL_RECORD_SLOTS;
    else process.env.TUTORIAL_RECORD_SLOTS = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('錄影名額：鎖檔常駐、不自己回收；沒有程序持有就是空的名額（舊鎖檔內容無所謂）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tutorial-slots-'));
  try {
    const { hostname } = await import('node:os');
    for (const i of [0, 1]) writeFileSync(join(dir, `slot-${i}.lock`), JSON.stringify({ pid: 999_999, host: hostname(), label: 'dead', since: 'x' }));
    assert.deepEqual(probeRecordSlots({ dir, max: 2 }).map((s) => s.held), [false, false]);
    const s = await acquireRecordSlot({ dir, max: 2, pollMs: 50, label: 'me' });
    assert.deepEqual(probeRecordSlots({ dir, max: 2 }).map((x) => [x.held, x.holder?.label]), [[true, 'me'], [false, undefined]]);
    s.release();
    assert.deepEqual(probeRecordSlots({ dir, max: 2 }).map((x) => x.held), [false, false]);
    assert.ok(existsSync(join(dir, 'slot-0.lock')), '鎖檔不刪');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 跨程序（跟實際一樣：每路錄影是獨立程序）──────────────────────

const HOLDER = join(import.meta.dirname, 'slot-holder.ts');

type Hold = { index: number; from: number; to: number };

function parseHold(stdout: string): Hold {
  const acq = stdout.match(/^ACQUIRED (\d+) (\d+)$/m);
  const rel = stdout.match(/^RELEASING (\d+)$/m);
  assert.ok(acq && rel, `輸出不完整：${JSON.stringify(stdout)}`);
  return { index: Number(acq[1]), from: Number(acq[2]), to: Number(rel[1]) };
}

/** 任何時刻同時持有的最多幾個（區間端點都取「持有中」的保守時間：拿到之後、歸還之前）。 */
function maxConcurrent(holds: Hold[]): number {
  const edges = holds.flatMap((h) => [
    { t: h.from, d: 1 },
    { t: h.to, d: -1 },
  ]);
  edges.sort((a, b) => a.t - b.t || a.d - b.d); // 同一毫秒先算歸還
  let cur = 0;
  let max = 0;
  for (const e of edges) max = Math.max(max, (cur += e.d));
  return max;
}

test('錄影名額（跨程序）：5 個程序同時搶 2 個名額，任何時刻持有者 ≤ 2；就算目錄裡留著舊鎖檔也一樣', { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tutorial-slots-race-'));
  try {
    // 舊做法會各自「回收」這兩個持有者已不在的鎖檔，互相刪掉對方剛拿到的鎖 → 3 路同時錄
    const { hostname } = await import('node:os');
    for (const i of [0, 1]) writeFileSync(join(dir, `slot-${i}.lock`), JSON.stringify({ pid: 999_999, host: hostname(), label: 'dead', since: 'x' }));
    const startAt = String(Date.now() + 1500); // 5 個程序各自啟動完，在同一毫秒開始搶
    const holds = (
      await Promise.all(Array.from({ length: 5 }, () => promisify(execFile)('node', [HOLDER, dir, '2', '400', startAt])))
    ).map((r) => parseHold(r.stdout));
    assert.ok(
      holds.every((h) => h.index === 0 || h.index === 1),
      `名額編號只能是 0 或 1：${JSON.stringify(holds)}`,
    );
    assert.equal(maxConcurrent(holds), 2, `同時持有者超過 2：${JSON.stringify(holds)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('錄影名額（跨程序）：持有者被 kill -9，名額自動釋放給排隊中的程序', { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tutorial-slots-kill-'));
  const procs: ChildProcess[] = [];
  const exited = (p: ChildProcess) => (p.exitCode != null || p.signalCode != null ? Promise.resolve() : new Promise<void>((r) => p.once('exit', () => r())));
  const start = (hold: string) => {
    const p = spawn('node', [HOLDER, dir, '2', hold], { stdio: ['ignore', 'pipe', 'inherit'] });
    procs.push(p);
    let out = '';
    const lines: string[] = [];
    const waiters: ((line: string) => void)[] = [];
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (chunk: string) => {
      out += chunk;
      const parts = out.split('\n');
      out = parts.pop()!;
      for (const l of parts) {
        lines.push(l);
        waiters.splice(0).forEach((w) => w(l));
      }
    });
    const next = (ms: number) =>
      new Promise<string | null>((resolve) => {
        if (lines.length) return resolve(lines.shift()!);
        const t = setTimeout(() => resolve(null), ms);
        waiters.push((l) => {
          clearTimeout(t);
          lines.shift();
          resolve(l);
        });
      });
    return { p, next };
  };
  try {
    const a = start('forever');
    const b = start('forever');
    const [la, lb] = await Promise.all([a.next(5000), b.next(5000)]);
    assert.match(la ?? '', /^ACQUIRED/);
    assert.match(lb ?? '', /^ACQUIRED/);
    const c = start('200');
    assert.equal(await c.next(600), null, '第 3 路要排隊');
    const freed = Number(la!.split(' ')[1]);
    a.p.kill('SIGKILL');
    const lc = await c.next(3000);
    assert.match(lc ?? '', /^ACQUIRED/, '持有者死掉後排隊的要拿到');
    assert.equal(Number(lc!.split(' ')[1]), freed, '拿到的是死掉那一路的名額');
    await exited(c.p);
  } finally {
    for (const p of procs) if (p.exitCode == null && p.signalCode == null) p.kill('SIGKILL');
    await Promise.all(procs.map(exited));
    rmSync(dir, { recursive: true, force: true });
  }
});
