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

// ── 截圖品質 ─────────────────────────────────────────

/** 兩張截圖間隔超過這個值就警告（影片會有一格以上的停頓，對齊誤差可能超過 50 ms）。 */
export const GAP_WARN_MS = 50;
/** 超過這個值視為嚴重：錄影中止並報錯。 */
export const GAP_SEVERE_MS = 100;
/** 一段裡的平均截圖速率低於這個值就警告。 */
export const MIN_FPS = 25;

export type SpanQuality = { fps: number; maxGapMs: number; p95GapMs: number; ok: boolean };
/** 錄影當下的系統負載（判斷截圖間隔過大是不是機器太忙）：loadavg 與可用記憶體（MB；macOS 的 free 偏保守）。 */
export type LoadSample = { /** 採樣時間（epoch ms）。 */ at: number; loadavg1: number; loadavg5: number; freeMemMB: number };
/** end 是「停止截圖那一刻」的快照：之後的 ffmpeg 解碼／編碼負載不算進來。 */
export type SystemLoad = { cpus: number; totalMemMB: number; start: LoadSample; peak: { loadavg1: number; freeMemMB: number }; end: LoadSample };
export type CaptureQuality = SpanQuality & {
  steps: (SpanQuality & { index: number })[];
  warnings: string[];
  /** 網頁自己卡住或換頁造成的截圖空檔（不中止錄影，只標記）。 */
  pageJank?: { atMs: number; gapMs: number; reason: string; url: string }[];
  /** 錄影中抽查到畫面內有還沒載好的圖片的時間段（章節時間；有就 ok=false）。 */
  unloadedImages?: { fromMs: number; toMs: number; count: number; sample: string; url: string }[];
  /** 錄影開始、期間峰值與結束時的系統負載。 */
  system?: SystemLoad;
};

function spanQuality(times: readonly number[], from: number, to: number): SpanQuality {
  const inside = times.filter((t) => t >= from && t <= to);
  const pts = [from, ...inside, to];
  const gaps = pts.slice(1).map((t, i) => t - pts[i]).filter((g) => g > 0);
  const sorted = [...gaps].sort((a, b) => a - b);
  const dur = Math.max(1, to - from);
  const q = {
    fps: Math.round((inside.length / dur) * 1000 * 10) / 10,
    maxGapMs: Math.round(sorted.at(-1) ?? dur),
    p95GapMs: Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? dur),
  };
  return { ...q, ok: q.maxGapMs <= GAP_WARN_MS && q.fps >= MIN_FPS };
}

/**
 * 依章節時間上的影格（已扣暫停）算截圖品質：整段與每一步的平均張數／秒、最大與 p95 間隔。
 * 只算錄進影片的時間；暫停期間不算。
 */
export function captureQuality(
  frameMs: readonly number[],
  steps: readonly { index: number; startMs: number; endMs: number }[],
  durationMs: number,
): CaptureQuality {
  const times = [...frameMs].sort((a, b) => a - b);
  const all = spanQuality(times, times[0] ?? 0, durationMs);
  const perStep = steps.map((s) => ({ index: s.index, ...spanQuality(times, s.startMs, s.endMs) }));
  const warnings: string[] = [];
  for (const s of perStep) {
    if (!s.ok) warnings.push(`步驟 ${s.index}：截圖 ${s.fps} 張／秒、最大間隔 ${s.maxGapMs} ms（標準：≥ ${MIN_FPS} 張／秒、間隔 ≤ ${GAP_WARN_MS} ms）`);
  }
  if (!all.ok && warnings.length === 0) warnings.push(`整段：截圖 ${all.fps} 張／秒、最大間隔 ${all.maxGapMs} ms`);
  return { ...all, ok: all.ok && perStep.every((s) => s.ok), steps: perStep, warnings };
}
