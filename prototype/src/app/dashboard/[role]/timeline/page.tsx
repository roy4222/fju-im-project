import { notFound } from "next/navigation";
import { PageTitle } from "@/components/dashboard/primitives";
import { TimelineZigzag } from "@/components/dashboard/timeline-zigzag";
import { isValidRole } from "@/lib/nav-config";
import { SCHEDULE, SCHEDULE_YEAR, currentStage } from "@/lib/fixtures";

/**
 * 專題時間軸（Roy 2026-09-10：只有學生有；管理員這頁是拿來調整階段與日期的；老師沒有）。
 * 樣式選了畫布的 B「直立蛇形」，見 components/dashboard/timeline-zigzag.tsx。
 */
export default async function TimelinePage({ params }: PageProps<"/dashboard/[role]/timeline">) {
  const { role } = await params;
  if (!isValidRole(role) || role === "teacher") notFound();
  const cur = currentStage();
  const done = SCHEDULE.filter((s) => s.status === "done").length;
  return (
    <div className="flex flex-col gap-5">
      <PageTitle title={role === "admin" ? "時間軸設定" : "專題時間軸"} description={`${SCHEDULE_YEAR.label}・${SCHEDULE.length} 個階段，已完成 ${done} 個；現在是「${cur.title}」。`} />
      <TimelineZigzag stages={SCHEDULE} role={role} canEdit={role === "admin"} />
    </div>
  );
}
