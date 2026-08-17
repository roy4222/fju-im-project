import { Geist, Geist_Mono, Kaisei_Tokumin, Noto_Sans_TC, Noto_Serif_TC } from "next/font/google";

/**
 * 字體策略
 *
 * 三個角色，各自有明確理由：
 *
 * 1. Kaisei Tokumin（明體，日系）— 拉丁字母、數字與站名 wordmark。
 *    Roy 指定的字體。它有個性，但字集是日文（7930 字符），繁中缺字包含
 *    產／歷／檔／繳／查／內／辦／錄 這些導覽與區塊標題用字，因此
 *    **不用於中文長文**，只用在跨語系不會露餡的位置。
 *
 * 2. Noto Serif TC（思源宋體）— 中文標題。與 Kaisei Tokumin 同為明體風格，
 *    字集完整，Google Fonts 有 324 個 unicode-range 分片。
 *
 * 3. Noto Sans TC + Geist — 內文、UI、表格。小字級下無襯線可讀性明顯較好
 *    （apple-design §15：字體選擇要服務尺寸，不是全站一套）。
 *
 * CJK 字體不指定 subsets 並設 preload: false —— 否則 next/font 會要求明確
 * subset，而繁中 subset 一次載入是好幾 MB。瀏覽器只會下載命中的分片。
 */

export const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

export const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const kaiseiTokumin = Kaisei_Tokumin({
  variable: "--font-kaisei",
  weight: ["400", "500", "700"],
  subsets: ["latin"],
});

export const notoSerifTC = Noto_Serif_TC({
  variable: "--font-serif-tc",
  weight: ["400", "600", "700"],
  preload: false,
});

export const notoSansTC = Noto_Sans_TC({
  variable: "--font-sans-tc",
  weight: ["400", "500", "700"],
  preload: false,
});

export const fontVariables = [
  geistSans.variable,
  geistMono.variable,
  kaiseiTokumin.variable,
  notoSerifTC.variable,
  notoSansTC.variable,
].join(" ");
