import { notFound } from "next/navigation";
import { PageTitle } from "@/components/dashboard/primitives";
import { TimelineZigzag } from "@/components/dashboard/timeline-zigzag";
import { isValidRole } from "@/lib/nav-config";
import { SCHEDULE, SCHEDULE_YEAR } from "@/lib/fixtures";

/**
 * 專題時間軸（Roy 2026-09-10：只有學生有；管理員這頁是拿來調整階段與日期的；老師沒有）。
 * 樣式選了畫布的 B「直立蛇形」，見 components/dashboard/timeline-zigzag.tsx。
 * 學期進度（時間）與我的待辦分開：這頁只講時間；待辦在作業區。
 */
export default async function TimelinePage({ params }: PageProps<"/dashboard/[role]/timeline">) {
  const { role } = await params;
  if (!isValidRole(role) || role === "teacher") notFound();
  const done = SCHEDULE.filter((s) => s.status === "done").length;
  /* 學年顯示西元對照（S-04 第 4 點） */
  const year = `${SCHEDULE_YEAR.label}（${SCHEDULE_YEAR.from.slice(0, 4)}–${SCHEDULE_YEAR.to.slice(0, 4)}）`;
  return (
    <div className="flex flex-col gap-5">
      <PageTitle title={role === "admin" ? "時間軸設定" : "專題時間軸"} description={`${year}・${SCHEDULE.length} 個階段，已過 ${done} 個`} />
      <TimelineZigzag stages={SCHEDULE} role={role} canEdit={role === "admin"} />
    </div>
  );
}
