// 配音全文字幕（SRT／WebVTT）：純函式。每步配音一則，起訖＝這句在影片裡實際起播與結束；
// 一則最多 2 行、每行約 18 個全形字（半形字算半個），太長就照標點切成多則、時間依字數分配。章節標題卡沒有配音，所以不出字幕。

export type Cue = { startMs: number; endMs: number; lines: string[] };

export const LINE_MAX = 18;
export const LINES_MAX = 2;

/** 寬度：全形字 1、半形（ASCII）0.5。 */
export function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += ch.codePointAt(0)! <= 0x7f ? 0.5 : 1;
  return w;
}

/** 可以斷開的標點（斷在標點後面）；後面緊接的右引號／右括號跟著前一段。 */
const CLAUSE = /[^，。、；：！？,;:!?]+[，。、；：！？,;:!?]*[」』）)]*|[，。、；：！？,;:!?」』）)]+/gu;

/** 把一段寬度超過 max 的字硬切成每段 ≤ max。 */
function hardSplit(s: string, max: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const ch of s) {
    if (cur && textWidth(cur + ch) > max) {
      out.push(cur);
      cur = '';
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** 文字 → 一則一則（每則是幾行）。先照標點切成子句，子句裝成行，每兩行一則。 */
export function splitNarration(text: string, maxLine = LINE_MAX, maxLines = LINES_MAX): string[][] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const pieces = (clean.match(CLAUSE) ?? [clean]).flatMap((c) => hardSplit(c, maxLine));
  const lines: string[] = [];
  let cur = '';
  for (const p of pieces) {
    if (cur && textWidth(cur + p) > maxLine) {
      lines.push(cur.trim());
      cur = '';
    }
    cur += p;
  }
  if (cur.trim()) lines.push(cur.trim());
  const cues: string[][] = [];
  for (let i = 0; i < lines.length; i += maxLines) cues.push(lines.slice(i, i + maxLines).filter(Boolean));
  return cues.filter((c) => c.length);
}

/** 一句配音 → 字幕則；時間依每則字數（寬度）比例分配，最後一則剛好結束在 endMs。 */
export function narrationCues(text: string, startMs: number, endMs: number, maxLine = LINE_MAX, maxLines = LINES_MAX): Cue[] {
  const chunks = splitNarration(text, maxLine, maxLines);
  const weights = chunks.map((c) => Math.max(0.5, textWidth(c.join(''))));
  const total = weights.reduce((a, b) => a + b, 0);
  const cues: Cue[] = [];
  let acc = 0;
  chunks.forEach((lines, i) => {
    const a = Math.round(startMs + ((endMs - startMs) * acc) / total);
    acc += weights[i];
    const b = i === chunks.length - 1 ? endMs : Math.round(startMs + ((endMs - startMs) * acc) / total);
    cues.push({ startMs: a, endMs: b, lines });
  });
  return cues;
}

/** 一句配音在影片裡的位置（影片時間，ms）。 */
export type NarrationSpan = { narration: string; startMs: number; endMs: number };

/** 多句 → 依時間排好、不重疊的字幕則（前一則的結束最多到下一則開始）。 */
export function buildCues(spans: readonly NarrationSpan[]): Cue[] {
  const cues = [...spans]
    .filter((s) => s.narration.trim() && s.endMs > s.startMs)
    .sort((a, b) => a.startMs - b.startMs)
    .flatMap((s) => narrationCues(s.narration, s.startMs, s.endMs));
  for (let i = 0; i + 1 < cues.length; i++) cues[i].endMs = Math.min(cues[i].endMs, cues[i + 1].startMs);
  return cues.filter((c) => c.endMs > c.startMs);
}

function clock(ms: number, sep: ',' | '.'): string {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3_600_000);
  const m = Math.floor((t % 3_600_000) / 60_000);
  const s = Math.floor((t % 60_000) / 1000);
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${p2(h)}:${p2(m)}:${p2(s)}${sep}${String(t % 1000).padStart(3, '0')}`;
}

/** SRT：序號、`00:01:02,345 --> 00:01:05,000`、字幕行、空行。 */
export function toSrt(cues: readonly Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${clock(c.startMs, ',')} --> ${clock(c.endMs, ',')}\n${c.lines.join('\n')}\n`).join('\n');
}

/** WebVTT：`WEBVTT` 標頭、時間用點。 */
export function toVtt(cues: readonly Cue[]): string {
  return `WEBVTT\n\n${cues.map((c) => `${clock(c.startMs, '.')} --> ${clock(c.endMs, '.')}\n${c.lines.join('\n')}\n`).join('\n')}`;
}
