// 錄影名額的跨程序測試用：拿一個名額、印出拿到的時間、抱著一段時間（或直到被殺）再歸還。
//   node engine/test/slot-holder.ts <slotsDir> <max> <holdMs|forever> [startAt]
// startAt（epoch ms）：等到那一刻才開始搶（讓好幾個程序真的同時搶）。
// 印出：ACQUIRED <index> <ms>（拿到之後）、RELEASING <ms>（歸還之前）、RELEASED <ms>（歸還之後）

import { acquireRecordSlot } from '../runs.ts';

const [dir, max, hold, startAt] = process.argv.slice(2);
if (startAt) {
  const at = Number(startAt);
  await new Promise((r) => setTimeout(r, Math.max(0, at - 5 - Date.now())));
  while (Date.now() < at) {} // 最後幾毫秒用忙等，開始時間差在 1 ms 內
}
const slot = await acquireRecordSlot({ dir, max: Number(max), pollMs: 20, label: `holder-${process.pid}`, log: () => {} });
process.stdout.write(`ACQUIRED ${slot.index} ${Date.now()}\n`);
if (hold === 'forever') {
  setInterval(() => {}, 1000);
} else {
  await new Promise((r) => setTimeout(r, Number(hold)));
  process.stdout.write(`RELEASING ${Date.now()}\n`);
  slot.release();
  process.stdout.write(`RELEASED ${Date.now()}\n`);
}
