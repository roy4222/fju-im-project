// 後製時間軸：純函式。把 events.json 換成「輸出影片時間」上的疊加片段與游標動畫。

import { cursorAt, type Move, type Point } from './cursor.ts';
import { keyLabel, PRESS_HINT_MS, type ChapterEvents, type Status } from './events.ts';

export type OverlayState = {
  /** overlaySegments 只放畫面用得到的 kind 與 say（evidence 不進疊加層，也不會讓片段多切一刀）。 */
  step?: { index: number; caption: string; status?: Status };
  url?: string;
  /** 正在顯示的按鍵提示（鍵帽字），按下後停留 PRESS_HINT_MS。 */
  press?: string;
};

export type Segment = { startMs: number; endMs: number; state: OverlayState };

/** 把 clip 時間切成疊加狀態固定的片段（步驟或網址一變就切）。 */
export function overlaySegments(ev: ChapterEvents): Segment[] {
  const cuts = new Set<number>([0, ev.clip.durationMs]);
  for (const s of ev.steps) cuts.add(s.startMs).add(s.endMs);
  for (const e of ev.events) if (e.type === 'url') cuts.add(e.atMs);
  const presses = ev.events.filter((e) => e.type === 'press');
  for (const e of presses) cuts.add(e.atMs).add(Math.min(ev.clip.durationMs, e.atMs + PRESS_HINT_MS));
  const times = [...cuts].filter((t) => t >= 0 && t <= ev.clip.durationMs).sort((a, b) => a - b);
  const urls = ev.events.filter((e) => e.type === 'url');
  const segs: Segment[] = [];
  for (let i = 0; i + 1 < times.length; i++) {
    const [a, b] = [times[i], times[i + 1]];
    if (b <= a) continue;
    const s = ev.steps.find((x) => x.startMs <= a && a < x.endMs);
    const u = [...urls].reverse().find((x) => x.atMs <= a) ?? urls[0];
    const p = [...presses].reverse().find((x) => x.atMs <= a && a < x.atMs + PRESS_HINT_MS);
    const state: OverlayState = {
      step: s ? { index: s.index, caption: s.caption, status: s.status ? { kind: s.status.kind, ...(s.status.say ? { say: s.status.say } : {}) } : undefined } : undefined,
      url: u ? displayUrl(u.url, ev.displayOrigin) : undefined,
      ...(p ? { press: keyLabel(p.key) } : {}),
    };
    const prev = segs.at(-1);
    if (prev && JSON.stringify(prev.state) === JSON.stringify(state)) prev.endMs = b;
    else segs.push({ startMs: a, endMs: b, state });
  }
  return segs;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 假網址列顯示的字：主機＋路徑＋查詢，不顯示 https://；值是 UUID 的查詢參數（例如 ?cohort=<uuid>）不顯示（events.json 仍是真實網址）。 */
export function displayUrl(url: string, displayOrigin?: string): string {
  try {
    const u = new URL(url);
    const host = displayOrigin || u.host;
    // 直接在原始查詢字串上過濾：只拿掉值是 UUID 的那一組（同名的其他值留著），其餘參數保留原本的編碼
    const query = u.search
      .slice(1)
      .split('&')
      .filter((part) => part && !UUID.test(safeDecode(part.slice(part.indexOf('=') + 1))))
      .join('&');
    const rest = safeDecode(`${u.pathname}${query ? `?${query}` : ''}${u.hash}`);
    return rest === '/' ? host : `${host}${rest}`;
  } catch {
    return url;
  }
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// ── 游標與波紋（ASS 字幕檔，PlayRes = 輸出大小） ─────────────────

/** 系網橘：web/src/app/globals.css 的 --primary（oklch(0.6683 0.1741 51.05)）。 */
export const BRAND_ORANGE = '#E56E00';

const ARROW = 'm 0 0 l 0 25 l 5.6 19.4 l 9.6 28.4 l 13.2 26.8 l 9.4 18 l 17.4 18 l 0 0';
const CURSOR_SCALE = 140;
const RIPPLE_MS = 650;

const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');

/** 以 (0,0) 為圓心、半徑 r 的圓。\an7 下 libass 把繪圖座標原點放在 \pos，所以圓心就在 \pos。 */
function circle(r: number): string {
  const c = (r * 0.5523).toFixed(1);
  const R = r.toFixed(1);
  return `m 0 -${R} b ${c} -${R} ${R} -${c} ${R} 0 b ${R} ${c} ${c} ${R} 0 ${R} b -${c} ${R} -${R} ${c} -${R} 0 b -${R} -${c} -${c} -${R} 0 -${R}`;
}

function assTime(ms: number): string {
  const cs = Math.max(0, Math.round(ms / 10));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

function assColor(hex: string): string {
  const h = hex.replace('#', '');
  return `&H${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}&`.toUpperCase();
}

/**
 * 產生游標與點擊波紋的 ASS。offsetMs：clip 時間 0 在輸出影片的位置（標題卡長度）。
 * 移動中每一格一個事件（位置取自同一套緩動函式），靜止時一個長事件。
 */
export function cursorAss(ev: ChapterEvents, offsetMs: number, fps = 30): string {
  const { width, height, chromeHeight } = ev.output;
  const moves: Move[] = ev.events.filter((e) => e.type === 'move').map(({ startMs, endMs, from, to }) => ({ startMs, endMs, from, to }));
  const lines: string[] = [];
  const at = (p: Point) => ({ x: Math.round(p.x), y: Math.round(p.y + chromeHeight) });
  const cursor = (a: number, b: number, p: Point) => {
    if (b - a < 1) return;
    const q = at(p);
    const [ta, tb] = [assTime(a + offsetMs), assTime(b + offsetMs)];
    if (ta === tb) return;
    lines.push(
      `Dialogue: 1,${ta},${tb},C,,0,0,0,,{\\an7\\pos(${q.x + 2},${q.y + 4})\\fscx${CURSOR_SCALE}\\fscy${CURSOR_SCALE}\\bord0\\shad0\\blur5\\1c&H000000&\\1a&H80&\\p1}${ARROW}`,
      `Dialogue: 2,${ta},${tb},C,,0,0,0,,{\\an7\\pos(${q.x},${q.y})\\fscx${CURSOR_SCALE}\\fscy${CURSOR_SCALE}\\bord1.6\\shad0\\1c&HFFFFFF&\\3c&H000000&\\p1}${ARROW}`,
    );
  };
  const frame = 1000 / fps;
  let t = 0;
  let pos = ev.cursorStart;
  for (const m of moves) {
    cursor(t, m.startMs, pos);
    for (let a = m.startMs; a < m.endMs; a += frame) {
      cursor(a, Math.min(a + frame, m.endMs), cursorAt([m], m.from, a + frame / 2));
    }
    pos = m.to;
    t = m.endMs;
  }
  cursor(t, ev.clip.durationMs, pos);

  // 波紋：每格畫一個以點擊點為圓心的圓（不用 \t 縮放，libass 縮放繪圖的基準點不在圓心）
  const orange = assColor(BRAND_ORANGE);
  for (const e of ev.events) {
    if (e.type !== 'click') continue;
    const q = at(e);
    for (const delay of [0, 150]) {
      for (let a = 0; a < RIPPLE_MS; a += frame) {
        const u = a / RIPPLE_MS;
        const k = 1 - (1 - u) ** 3; // easeOutCubic
        const r = 10 + 48 * k;
        const fill = Math.round(0x70 + (0xff - 0x70) * u);
        const line = Math.round(0x10 + (0xff - 0x10) * u);
        const t0 = e.atMs + delay + a;
        const [ta, tb] = [assTime(t0 + offsetMs), assTime(t0 + frame + offsetMs)];
        if (ta === tb) continue;
        lines.push(
          `Dialogue: 0,${ta},${tb},C,,0,0,0,,{\\an7\\pos(${q.x},${q.y})\\bord3\\shad0\\1c${orange}\\3c${orange}\\1a&H${hex2(fill)}&\\3a&H${hex2(line)}&\\p1}${circle(r)}`,
        );
      }
    }
  }

  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: C,Arial,20,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...lines,
    '',
  ].join('\n');
}
