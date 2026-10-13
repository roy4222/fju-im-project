// 疊加圖層：字幕條、假網址列、狀態標記、章節標題卡。用 Chromium 把 HTML 畫成透明 PNG，
// 中文字（PingFang TC／Noto Sans TC）與彩色 emoji 都交給瀏覽器排版。

import type { Browser } from 'playwright';
import { STATUS_ICON, statusSay, type StatusKind } from './events.ts';
import { BRAND_ORANGE, type OverlayState } from './timeline.ts';

const FONT = `"PingFang TC", "Noto Sans TC", "Noto Sans CJK TC", "Heiti TC", sans-serif`;
const NAVY = '#14284B';

const STATUS_COLOR: Record<StatusKind, string> = {
  ok: '#1E8E3E',
  warn: '#D97706',
  bad: '#D93025',
  pending: '#CA8A04',
};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function page(width: number, height: number, body: string, background = 'transparent'): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0}
  html,body{width:${width}px;height:${height}px;background:${background};font-family:${FONT};overflow:hidden;-webkit-font-smoothing:antialiased}
  </style></head><body>${body}</body></html>`;
}

/** 一個疊加片段的整張 HTML（透明底）。 */
export function overlayHtml(state: OverlayState, size: { width: number; height: number; chromeHeight: number }, stepLabel?: string): string {
  const { width, chromeHeight } = size;
  const st = state.step?.status;
  // 狀態標記放在假網址列右端：永遠在右上角，又不會蓋住網站自己的導覽列。
  // 只顯示圖示＋白話（say；超過 22 字截斷），依據（evidence／舊的 note）不上畫面
  const say = st ? statusSay(st) : '';
  const badge = st
    ? `<div style="flex:none;max-width:900px;height:56px;display:flex;align-items:center;gap:12px;padding:0 24px 0 16px;border-radius:28px;background:#fff;border:3px solid ${STATUS_COLOR[st.kind]};box-shadow:0 2px 10px rgba(0,0,0,.12)">
        <span style="font-size:32px;line-height:1;font-family:'Apple Color Emoji','Noto Color Emoji',sans-serif">${STATUS_ICON[st.kind]}</span>
        ${say ? `<span style="font-size:27px;font-weight:600;color:#1F2937;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(say)}</span>` : ''}
      </div>`
    : '';
  const parts: string[] = [];
  parts.push(`<div style="position:absolute;left:0;top:0;width:${width}px;height:${chromeHeight}px;background:#ECEEF1;border-bottom:1px solid #D0D4DA;display:flex;align-items:center;padding:0 24px 0 28px;gap:22px">
    <div style="display:flex;gap:10px">${['#FF5F57', '#FEBC2E', '#28C840'].map((c) => `<span style="width:16px;height:16px;border-radius:50%;background:${c};display:block"></span>`).join('')}</div>
    <div style="display:flex;gap:18px;color:#6B7280;font-size:26px;margin-left:14px">‹ <span>›</span> <span>↻</span></div>
    <div style="flex:1;min-width:0;height:50px;border-radius:25px;background:#fff;display:flex;align-items:center;padding:0 24px;gap:14px;font-size:25px;color:#1F2937;letter-spacing:.2px;white-space:nowrap;overflow:hidden">
      <svg style="flex:none" width="18" height="22" viewBox="0 0 18 22"><rect x="1" y="9" width="16" height="12" rx="2.5" fill="#5F6368"/><path d="M4.5 9V6a4.5 4.5 0 0 1 9 0v3" stroke="#5F6368" stroke-width="2.4" fill="none"/></svg>
      <span>${state.url ? urlParts(state.url) : ''}</span>
    </div>
    ${badge}
  </div>`);
  if (state.step) {
    const label = stepLabel ?? String(state.step.index);
    parts.push(`<div style="position:absolute;left:0;right:0;bottom:44px;display:flex;justify-content:center">
      <div style="max-width:${width - 240}px;display:flex;align-items:center;gap:26px;padding:22px 40px 22px 24px;border-radius:22px;background:rgba(17,20,28,.86);box-shadow:0 10px 30px rgba(0,0,0,.25)">
        <span style="flex:none;min-width:64px;height:64px;padding:0 14px;border-radius:32px;background:${BRAND_ORANGE};color:#fff;font-size:32px;font-weight:700;display:flex;align-items:center;justify-content:center">${esc(label)}</span>
        <span style="color:#fff;font-size:46px;font-weight:600;line-height:1.3">${esc(state.step.caption)}</span>
      </div></div>`);
  }
  return page(width, size.height, parts.join(''));
}

function urlParts(url: string): string {
  const i = url.indexOf('/');
  if (i < 0) return `<span style="color:#111827">${esc(url)}</span>`;
  return `<span style="color:#111827">${esc(url.slice(0, i))}</span><span style="color:#6B7280">${esc(url.slice(i))}</span>`;
}

/** 章節標題卡（不透明）。 */
export function titleCardHtml(title: string, subtitle: string | undefined, size: { width: number; height: number }): string {
  return page(
    size.width,
    size.height,
    `<div style="position:absolute;inset:0;background:radial-gradient(ellipse at 30% 20%, #1F3A6B 0%, ${NAVY} 55%, #0B1830 100%)"></div>
    <div style="position:absolute;left:180px;top:0;bottom:0;display:flex;flex-direction:column;justify-content:center;gap:34px">
      <div style="width:120px;height:10px;border-radius:5px;background:${BRAND_ORANGE}"></div>
      <div style="color:#fff;font-size:120px;font-weight:700;letter-spacing:2px;line-height:1.1">${esc(title)}</div>
      ${subtitle ? `<div style="color:#E6ECF5;font-size:68px;font-weight:500;line-height:1.2">${esc(subtitle)}</div>` : ''}
    </div>
    <div style="position:absolute;left:180px;bottom:90px;color:#9FB0CC;font-size:30px;letter-spacing:1px">輔仁大學資訊管理學系　專題平台操作教學</div>`,
  );
}

/** 依序把 HTML 畫成 PNG（同一個分頁重用）。 */
export async function renderHtmlPngs(
  browser: Browser,
  jobs: { html: string; file: string; transparent: boolean }[],
  size: { width: number; height: number },
): Promise<void> {
  const ctx = await browser.newContext({ viewport: size, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  for (const j of jobs) {
    await p.setContent(j.html, { waitUntil: 'load' });
    await p.evaluate(() => document.fonts.ready);
    await p.screenshot({ path: j.file, omitBackground: j.transparent, type: 'png' });
  }
  await ctx.close();
}
