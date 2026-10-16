// 錄影測試共用的純檢查（不開瀏覽器；checks.test.ts 用固定時間的案例證明每一條抓得到什麼、放得過什麼）：
//   1. quality 旗標與數字一致：ok、warnings 各自跟「達標與否」一致（旗標錯、漏掉警告分開抓）
//   2. 逐格對齊：每一格的上限只看「這一格應選的那張截圖」前後的局部間隔，別處有一個大間隔不會把整章的上限抬高
//   3. 點擊變色：第一張黑格要落在點擊前兩張到後兩張截圖之間

import assert from 'node:assert/strict';
import { GAP_SEVERE_MS, GAP_WARN_MS, MIN_FPS, type CaptureQuality } from '../frames.ts';
import { CAPTURE_OPTS, STRICT } from './env.ts';

// ── 1. quality 一致 ──────────────────────────────────

/** 達到單路標準：整段與每一步都 ≥ 25 張／秒、最大間隔 ≤ 50 ms。 */
export function meetsStandard(q: CaptureQuality): boolean {
  return q.fps >= MIN_FPS && q.maxGapMs <= GAP_WARN_MS && q.steps.every((s) => s.fps >= MIN_FPS && s.maxGapMs <= GAP_WARN_MS);
}

/**
 * quality 要跟數字一致：達標 ⇔ ok=true ⇔ 沒有警告。ok 與 warnings 分開斷言——
 * 「沒達標、有警告、卻 ok=true」與「沒達標、ok=false、卻沒警告」各自會失敗（合在一起寫 `ok && 無警告 === 達標` 會放過前者）。
 * 達不達標是機器表現，只印出來；strict 時才當失敗。回傳有沒有達標。
 */
export function assertQualityConsistent(
  name: string,
  q: CaptureQuality,
  { strict = STRICT, abortLimit = CAPTURE_OPTS.maxGapMs ?? GAP_SEVERE_MS }: { strict?: boolean; abortLimit?: number } = {},
): boolean {
  const meets = meetsStandard(q);
  const nums = `${q.fps} 張／秒、最大間隔 ${q.maxGapMs} ms、各步 ${q.steps.map((s) => `${s.fps}／${s.maxGapMs}`).join('、')}`;
  assert.ok(q.maxGapMs <= abortLimit, `${name}：間隔 ${q.maxGapMs} ms 已超過中止門檻 ${abortLimit} ms 卻沒中止`);
  assert.equal(q.ok, meets, `${name}：數字${meets ? '達標' : '沒達標'}（${nums}）但 quality.ok=${q.ok}；warnings=${JSON.stringify(q.warnings)}`);
  assert.equal(q.warnings.length === 0, meets, `${name}：數字${meets ? '達標卻有警告' : '沒達標卻沒有警告'}（${nums}）；warnings=${JSON.stringify(q.warnings)}`);
  if (!meets) console.log(`${name}：這次沒達到單路標準（${nums}${q.system ? `；loadavg ${q.system.start.loadavg1}→${q.system.peak.loadavg1}` : ''}），引擎已正確標記 ok=false`);
  if (strict) assert.ok(meets, `${name}：TUTORIAL_STRICT_QUALITY 要求達到單路標準（${nums}）`);
  return meets;
}

// ── 2. 逐格對齊 ──────────────────────────────────────

/** clip 固定 30 fps：一格 33.3 ms。 */
export const FRAME_MS = 1000 / 30;

/**
 * 「畫面內容時間」與「那張截圖的時間」之間的殘差上限。內容最多舊一個 rAF（16.7 ms）；截圖時刻取請求中點、再以校正窗的中位數延遲校正，
 * 兩者各抖動 ±10 ms 左右。實測：空機（間隔 36～38 ms）逐格總誤差最大 19～21 ms ≈ 純量化誤差（間隔 − 半格），殘差接近 0；
 * loadavg 11 時最大間隔 67 ms、總誤差 69 ms → 殘差約 19 ms。選錯一張截圖會差一個局部間隔（≥ 33 ms），超過這個殘差。
 */
export const RESIDUAL_MS = 30;

/**
 * 第 k 格（格位時間 slotMs）應該用哪一張截圖：時間 ≤ 格位中點（slotMs ＋ 半格）的最後一張；都還沒有就第一張。
 * 這是固定幀率輸出的規則，在這裡獨立寫一次（不呼叫引擎的 cfrSlots），引擎選錯格才抓得到。
 */
export function expectedCapture(captures: readonly number[], slotMs: number, frameMs = FRAME_MS): number {
  let pick = captures[0];
  for (const c of captures) {
    if (c <= slotMs + frameMs / 2) pick = c;
    else break;
  }
  return pick;
}

/** 截圖 c 第一次出現的格位時間（第一個中點 ≥ c 的格位）。 */
export function slotOf(captureMs: number, frameMs = FRAME_MS): number {
  return Math.max(0, Math.ceil((captureMs - frameMs / 2) / frameMs - 1e-6)) * frameMs;
}

export type FrameCheck = {
  k: number;
  slotMs: number;
  /** 這一格畫面內容的章節時間（條碼） */
  codeMs: number;
  /** 這一格應選的截圖時間 */
  captureMs: number;
  /** 局部截圖間隔：應選的那張到下一張 */
  gapMs: number;
  /** 格位時間 − 內容時間（影片時間與內容時間的總誤差） */
  errMs: number;
  /** 應選截圖時間 − 內容時間（總誤差扣掉量化之後剩下的） */
  residualMs: number;
  /** 這一格的總誤差上限 ＝ |格位 − 應選截圖| ＋ 殘差 ≤ 局部間隔 − 半格 ＋ 殘差 */
  boundMs: number;
  ok: boolean;
};

/**
 * 逐格檢查（含重複格）：每一格的內容時間要是「這一格應選的那張截圖」的時間（± 殘差）。
 * 等價於總誤差 ≤ 量化誤差 ＋ 殘差；量化誤差只跟這一格前後的局部間隔有關，所以別處一個 160 ms 的間隔不會放寬這裡。
 * 選錯一張截圖（差一個局部間隔）、或某一格平移 150 ms，都會在那一格失敗，不管中位數多漂亮。
 * codes[k] 為 0 表示那一格還沒畫出條碼，跳過；ranges 是要看的章節時間段（每段最後一格不算）。
 */
export function checkFrames(
  captures: readonly number[],
  codes: readonly number[],
  ranges: readonly { fromMs: number; toMs: number }[],
  frameMs = FRAME_MS,
): FrameCheck[] {
  const sorted = [...captures].sort((a, b) => a - b);
  const out: FrameCheck[] = [];
  for (const r of ranges) {
    for (let k = Math.ceil(r.fromMs / frameMs); (k + 1) * frameMs < r.toMs && k < codes.length; k++) {
      const codeMs = codes[k];
      if (!codeMs) continue;
      const slotMs = k * frameMs;
      const captureMs = expectedCapture(sorted, slotMs, frameMs);
      const i = sorted.indexOf(captureMs);
      const gapMs = i + 1 < sorted.length ? sorted[i + 1] - captureMs : frameMs;
      const errMs = slotMs - codeMs;
      const residualMs = captureMs - codeMs;
      const boundMs = Math.abs(slotMs - captureMs) + RESIDUAL_MS;
      out.push({ k, slotMs, codeMs, captureMs, gapMs, errMs, residualMs, boundMs, ok: Math.abs(residualMs) <= RESIDUAL_MS });
    }
  }
  return out;
}

/** 失敗的格，一格一行（空陣列＝全部對齊）。 */
export function frameViolations(checks: readonly FrameCheck[]): string[] {
  return checks
    .filter((c) => !c.ok)
    .map(
      (c) =>
        `#${c.k}（${(c.slotMs / 1000).toFixed(2)} 秒）誤差 ${c.errMs.toFixed(1)} ms，超過這一格的局部上限 ${c.boundMs.toFixed(1)} ms` +
        `（應選 ${c.captureMs.toFixed(1)} ms 那張截圖、局部間隔 ${c.gapMs.toFixed(0)} ms；內容時間 ${c.codeMs}、殘差 ${c.residualMs.toFixed(1)} ms）`,
    );
}

// ── 3. 點擊變色 ──────────────────────────────────────

export type ClickCheck = {
  /** 第一張黑格的格位時間 − click.atMs */
  errMs: number;
  loMs: number;
  hiMs: number;
  /** 點擊前的最後兩張截圖（由早到晚） */
  before: number[];
  /** 點擊後的前兩張截圖 */
  after: number[];
  ok: boolean;
};

/**
 * 點擊與變色對齊：click.atMs 記在放開滑鼠、頁面畫出下一格、再經一次 evaluate 來回之後（晚黑格的那一次 rAF 約 5～25 ms，機器忙時更久），
 * 所以變黑的第一張截圖常常是 atMs 前的最後一張，截圖密（間隔 20～25 ms）時可能是前第二張；
 * 另一邊，atMs 後的第一張可能因殘差還沒黑、最晚是第二張（實測三次分別落在前最後一張、前最後一張、後第二張）。
 * 第一張黑格的格位要落在 slot(前第二張)～slot(後第二張) 之間——上下限都是點擊前後的局部截圖，點擊時間平移 150 ms 一定超出。
 */
export function checkClick(captures: readonly number[], clickAtMs: number, firstPressedK: number, frameMs = FRAME_MS): ClickCheck {
  const sorted = [...captures].sort((a, b) => a - b);
  const before = sorted.filter((c) => c <= clickAtMs).slice(-2);
  if (before.length === 0) before.push(sorted[0]);
  const after = sorted.filter((c) => c > clickAtMs).slice(0, 2);
  const loMs = slotOf(before[0], frameMs) - clickAtMs;
  const hiMs = slotOf(after.at(-1) ?? before.at(-1)!, frameMs) - clickAtMs;
  const errMs = firstPressedK * frameMs - clickAtMs;
  return { errMs, loMs, hiMs, before, after, ok: firstPressedK >= 0 && errMs >= loMs - 1e-6 && errMs <= hiMs + 1e-6 };
}
