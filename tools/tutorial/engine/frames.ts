// 畫面影格 → 固定 30fps 的 clip。純函式部分（時間換算、選格）在這裡，方便測試。

export type Pause = { startWall: number; endWall: number };
export type RawFrame = { file: string; wallMs: number };
export type TimedFrame = { file: string; ms: number };

/** 牆上時間 → 章節時間（扣掉開始前與所有暫停）。暫停中的時間點對到暫停開始那一刻。 */
export function toChapterMs(wall: number, t0Wall: number, pauses: readonly Pause[]): number {
  let paused = 0;
  for (const p of pauses) {
    if (wall >= p.endWall) paused += p.endWall - p.startWall;
    else if (wall > p.startWall) paused += wall - p.startWall;
  }
  return wall - t0Wall - paused;
}

/**
 * 把原始影格換成章節時間。暫停期間抓到的影格只留最後一張（暫停時畫面若有變，
 * 恢復錄影的那一刻就要是新畫面；沒變就沿用前一張）。
 */
export function timeFrames(raw: readonly RawFrame[], t0Wall: number, pauses: readonly Pause[]): TimedFrame[] {
  const sorted = [...raw].sort((a, b) => a.wallMs - b.wallMs);
  const out: TimedFrame[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const f = sorted[i];
    const inPause = pauses.find((p) => f.wallMs > p.startWall && f.wallMs < p.endWall);
    if (inPause) {
      const next = sorted[i + 1];
      if (next && next.wallMs < inPause.endWall) continue; // 同一段暫停內還有更新的
    }
    out.push({ file: f.file, ms: Math.max(0, toChapterMs(f.wallMs, t0Wall, pauses)) });
  }
  // 同一時間點只留最後一張
  return out.filter((f, i) => i === out.length - 1 || out[i + 1].ms > f.ms);
}

/**
 * 每個 30fps 格位挑「時間最接近、且不晚於格位中點」的影格，輸出固定幀率序列。
 * 回傳 slots[k] = 第 k 格要用的影格檔。
 */
export function cfrSlots(frames: readonly TimedFrame[], durationMs: number, fps = 30): string[] {
  if (frames.length === 0) return [];
  const step = 1000 / fps;
  const n = Math.max(1, Math.round(durationMs / step));
  const slots: string[] = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const limit = k * step + step / 2;
    while (j + 1 < frames.length && frames[j + 1].ms <= limit) j++;
    slots.push(frames[j].file);
  }
  return slots;
}
