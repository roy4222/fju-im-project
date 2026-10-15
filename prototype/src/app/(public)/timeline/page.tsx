import type { Metadata } from "next";
import { PageHead } from "@/components/public/blocks";
import { NeedLogin } from "@/components/public/need-login";
import { NowStrip, StageTrack } from "@/components/public/stage-track";
import { SCHEDULE, SCHEDULE_YEAR, currentStage } from "@/lib/fixtures";
import { getViewer } from "@/lib/data/viewer";

export const metadata: Metadata = { title: "專題時程", robots: { index: false }, alternates: { canonical: "/timeline" } };

/**
 * 專題時程（學生後台 v1，Roy 2026-10-15）：從後台搬到前台，登入後可看。
 * 本屆各階段、目前在哪、各階段的收件；橫向鋸齒里程碑，不用表格。
 */
export default async function TimelinePage() {
  const viewer = await getViewer();
  if (!viewer.isMember || viewer.role === "guest") return <NeedLogin returnTo="/timeline" what="專題時程" />;
  const stage = currentStage();
  const year = `${SCHEDULE_YEAR.label}（${SCHEDULE_YEAR.from.slice(0, 4)}–${SCHEDULE_YEAR.to.slice(0, 4)}）`;
  return (
    <>
      <PageHead title="專題時程" description={`${year}・${SCHEDULE.length} 個階段。點收件可以直接去交。`} crumbs={[{ label: "專題時程" }]} />
      <div className="mx-auto flex max-w-6xl flex-col gap-8 px-5 py-10">
        <NowStrip stage={stage} nextLabel={viewer.role === "student" ? { label: "回我的專題事務", href: "/dashboard/student" } : undefined} />
        <StageTrack stages={SCHEDULE} role={viewer.role} />
      </div>
    </>
  );
}
