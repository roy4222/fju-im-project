// 錄影的「場地」：每次錄影一個獨立 run 目錄（原子建立，撞名就拒絕），
// 加上全機共用的錄影名額（同一台機器同時最多 2 路在錄，其餘排隊）。

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export const DEFAULT_OUT_ROOT = join(homedir(), 'work', 'tutorial-out', 'runs');
/** 錄影中的標記檔：存在代表這個 run 還在錄（或錄到一半異常中止），render 會拒絕。 */
export const RECORDING_MARK = '.recording';
/** 錄影失敗時留下的說明檔。 */
export const FAILED_MARK = 'FAILED.txt';

/** 主腦定案：同一台機器同時最多 2 路在錄（再多截圖會掉到每秒 25 張以下）。 */
export const DEFAULT_RECORD_SLOTS = 2;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 新的 run 目錄路徑（還沒建立）：<root>/<label>-<時間>-<亂碼>。 */
export function newRunDir(root: string, label: string): string {
  const slug = label.replace(/[\s/\\:*?"<>|｜]+/g, '-').replace(/^-+|-+$/g, '') || 'run';
  return join(resolve(root), `${slug}-${stamp()}-${Math.random().toString(36).slice(2, 6)}`);
}

/**
 * 原子地佔下 outDir：上層可以不存在，但 outDir 本身必須不存在（mkdir 不加 recursive，撞名直接 EEXIST）。
 * 佔下後寫入錄影中標記。
 */
export function claimOutDir(outDir: string): string {
  const dir = resolve(outDir);
  mkdirSync(dirname(dir), { recursive: true });
  try {
    mkdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`輸出目錄已存在，拒絕覆蓋：${dir}（每次錄影請用新的 run 目錄；不指定 outDir 會自動建立）`);
    }
    throw e;
  }
  const fd = openSync(join(dir, RECORDING_MARK), 'wx');
  writeSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() }));
  closeSync(fd);
  return dir;
}

/** render／assemble 前檢查：還在錄或錄失敗的目錄不能用。 */
export function assertRunComplete(dir: string): void {
  if (existsSync(join(dir, FAILED_MARK))) {
    throw new Error(`這個 run 錄影失敗，不能後製：${dir}\n${readFileSync(join(dir, FAILED_MARK), 'utf8')}`);
  }
  if (existsSync(join(dir, RECORDING_MARK))) {
    throw new Error(`這個 run 還在錄影（或異常中止沒清掉 ${RECORDING_MARK}）：${dir}`);
  }
}

// ── 全機錄影名額 ─────────────────────────────────────

export type RecordSlot = { index: number; file: string; release(): void };

export type SlotOptions = {
  /** 名額鎖放哪；預設 ~/work/tutorial-out/.record-slots（可用 TUTORIAL_SLOTS_DIR 覆寫）。 */
  dir?: string;
  /** 同時幾路；預設 2（可用 TUTORIAL_RECORD_SLOTS 覆寫）。 */
  max?: number;
  /** 誰在用（印在等待訊息與鎖檔裡）。 */
  label?: string;
  pollMs?: number;
  log?: (msg: string) => void;
  signal?: AbortSignal;
};

export function defaultSlotsDir(): string {
  return process.env.TUTORIAL_SLOTS_DIR ?? join(homedir(), 'work', 'tutorial-out', '.record-slots');
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

type Holder = { pid: number; host: string; label: string; since: string };

function readHolder(file: string): Holder | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Holder;
  } catch {
    return null;
  }
}

/**
 * 拿一個錄影名額；滿了就排隊（每秒重試），開始等時印「等待錄影名額」。
 * 持有者的程序已不在（同一台機器）就視為過期、直接回收。程序結束時自動歸還。
 */
export async function acquireRecordSlot(opts: SlotOptions = {}): Promise<RecordSlot> {
  const dir = opts.dir ?? defaultSlotsDir();
  const max = opts.max ?? Number(process.env.TUTORIAL_RECORD_SLOTS ?? DEFAULT_RECORD_SLOTS);
  const log = opts.log ?? ((m: string) => console.log(m));
  const label = opts.label ?? basename(process.argv[1] ?? 'tutorial');
  mkdirSync(dir, { recursive: true });
  let waitingSince = 0;
  let lastLog = 0;
  for (;;) {
    if (opts.signal?.aborted) throw new Error('等待錄影名額時被取消');
    for (let i = 0; i < max; i++) {
      const file = join(dir, `slot-${i}.lock`);
      let fd: number;
      try {
        fd = openSync(file, 'wx');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        const h = readHolder(file);
        if (h && h.host === hostname() && !alive(h.pid)) {
          try {
            unlinkSync(file); // 前一個程序沒歸還就結束了
          } catch {}
          i--;
        }
        continue;
      }
      const me: Holder = { pid: process.pid, host: hostname(), label, since: new Date().toISOString() };
      writeSync(fd, JSON.stringify(me));
      closeSync(fd);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        process.off('exit', release);
        const h = readHolder(file);
        if (h && h.pid === me.pid && h.since === me.since) {
          try {
            unlinkSync(file);
          } catch {}
        }
      };
      process.on('exit', release);
      if (waitingSince) log(`拿到錄影名額 ${i + 1}/${max}（等了 ${((Date.now() - waitingSince) / 1000).toFixed(0)} 秒）`);
      return { index: i, file, release };
    }
    const now = Date.now();
    if (!waitingSince) waitingSince = now;
    if (now - lastLog >= 30_000) {
      lastLog = now;
      const holders = Array.from({ length: max }, (_, i) => readHolder(join(dir, `slot-${i}.lock`)))
        .filter((h): h is Holder => !!h)
        .map((h) => h.label);
      log(`等待錄影名額…（同時最多 ${max} 路，錄影中：${holders.join('、') || '—'}）`);
    }
    await sleep(opts.pollMs ?? 1000);
  }
}
