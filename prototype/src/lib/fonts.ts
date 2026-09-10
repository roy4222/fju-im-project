import { Geist, Geist_Mono, Noto_Sans_TC } from "next/font/google";

/**
 * 字體策略（2026-09-07 Roy 定案，規格 §10.1）
 *
 * 全站黑體：Geist 負責拉丁字母與數字，Noto Sans TC 負責漢字。
 * 標題與內文同一套，靠字重（500／700／800）與字級建立層級。
 * 系網 im.fju.edu.tw 全站就是黑體、粗體標題，沒有襯線或展示字體；
 * 先前的 Noto Serif TC 與 Kaisei Tokumin 已移除（ANTI-PATTERNS 第 5 條）。
 *
 * CJK 字體不指定 subsets 並設 preload: false，瀏覽器只下載命中的 unicode-range 分片。
 */

export const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

export const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const notoSansTC = Noto_Sans_TC({
  variable: "--font-sans-tc",
  weight: ["400", "500", "700", "800"],
  preload: false,
});

export const fontVariables = [geistSans.variable, geistMono.variable, notoSansTC.variable].join(" ");
