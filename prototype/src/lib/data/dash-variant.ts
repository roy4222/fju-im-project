/**
 * 後台版本（原型評選用）。Roy 2026-09-09：V1 模組網格「沒有到很愛」，再出三個版本讓他可點、可比。
 * 版本存 cookie `fju-dash-variant`，由右下角切換列 POST /api/proto-variant 寫入；定案後刪掉其餘版本與這個檔案。
 * 對應規格 §16.2 Prototype A 的三個方向：A 時間軸／截止日優先、B 狀態優先、C Kiranism 式側欄＋快捷卡（＝V1）。
 */
export const DASH_VARIANTS = ["grid", "timeline", "console", "navy"] as const;
export type DashVariant = (typeof DASH_VARIANTS)[number];

export const DASH_VARIANT_COOKIE = "fju-dash-variant";
export const DEFAULT_DASH_VARIANT: DashVariant = "grid";

export const DASH_VARIANT_META: Record<DashVariant, { label: string; short: string; blurb: string }> = {
  grid: { label: "V1 模組網格", short: "V1", blurb: "灰底白卡、四統計磚、三欄模組（目前版）" },
  timeline: { label: "V2 時間軸", short: "V2", blurb: "白底、截止日優先、單欄工作單＋右側里程碑" },
  console: { label: "V3 控制台", short: "V3", blurb: "狀態優先、細線分格、里程碑橫軌、數字等寬" },
  navy: { label: "V4 系網深藍", short: "V4", blurb: "深藍側欄、暖白內容、統計一條、兩欄模組" },
};

export function isDashVariant(v: string | undefined): v is DashVariant {
  return (DASH_VARIANTS as readonly string[]).includes(v ?? "");
}
