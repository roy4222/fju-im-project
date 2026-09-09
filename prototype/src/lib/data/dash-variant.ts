/**
 * 後台版本（原型評選用）。2026-09-09 Roy 選定 V4 系網深藍為基底，再出三種首頁時間軸做法讓他挑。
 * 版本存 cookie `fju-dash-variant`，由右下角切換列 POST /api/proto-variant 寫入；定案後刪掉其餘版本與這個檔案。
 */
export const DASH_VARIANTS = ["rail", "agenda", "chart"] as const;
export type DashVariant = (typeof DASH_VARIANTS)[number];

export const DASH_VARIANT_COOKIE = "fju-dash-variant";
export const DEFAULT_DASH_VARIANT: DashVariant = "rail";

export const DASH_VARIANT_META: Record<DashVariant, { label: string; short: string; blurb: string }> = {
  rail: { label: "V4-A 軌道", short: "A 軌道", blurb: "時程做成橫向路線圖：一站一階段，現在這站放大、列出這階段要做的事" },
  agenda: { label: "V4-B 行程", short: "B 行程", blurb: "時程做成直式行程表：左邊日期、右邊階段，現在的階段展開；公告在下面" },
  chart: { label: "V4-C 甘特", short: "C 甘特", blurb: "時程做成甘特圖：每個階段一條橫槓對到月份，今天一條線；公告在下面" },
};

export function isDashVariant(v: string | undefined): v is DashVariant {
  return (DASH_VARIANTS as readonly string[]).includes(v ?? "");
}
