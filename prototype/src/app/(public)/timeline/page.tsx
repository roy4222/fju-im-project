import type { Metadata } from "next";
import { PageHead } from "@/components/public/blocks";
import { NeedLogin } from "@/components/public/need-login";
import { StageRail } from "@/components/public/stage-track";
import { FullCalendar, type CalItem } from "@/components/public/full-calendar";
import { CALENDAR_EVENTS, CALENDAR_KIND_LABEL, SCHEDULE, SCHEDULE_YEAR, TODAY_YMD, type Role } from "@/lib/fixtures";
import { studentTodos } from "@/lib/student-v1";
import { getViewer } from "@/lib/data/viewer";

export const metadata: Metadata = { title: "專題時程", robots: { index: false }, alternates: { canonical: "/timeline" } };

/**
 * 專題時程（學生後台 v1 搬到前台，登入後可看）。
 * 第 3 輪（Roy 2026-10-15）：首頁的小月曆搬來這裡——上方階段時間軸、下方完整月曆（截止日＋活動＋競賽）。
 * 學生的截止日用自己的待辦（同一個口徑，有已交／逾期顏色）；老師、系辦看系上的截止日加上自己的工作期限。
 */
function itemsFor(role: Role): CalItem[] {
  const events: CalItem[] = CALENDAR_EVENTS.filter((e) => e.kind !== "deadline" || role !== "student").map((e) => ({
    id: e.id, date: e.date, title: e.title.replace(/截止$/, ""), tone: e.kind, tag: CALENDAR_KIND_LABEL[e.kind], href: e.href, time: e.time,
  }));
  if (role === "student") {
    const due: CalItem[] = studentTodos().filter((t) => t.due).map((t) => ({
      id: t.id, date: t.due!, title: t.title,
      tone: t.status === "done" ? "done" : t.status === "overdue" ? "overdue" : "deadline",
      tag: t.status === "done" ? "已交" : t.status === "overdue" ? "逾期" : "截止",
      href: `/dashboard/student${t.href}`,
    }));
    return [...due, ...events];
  }
  const tasks: CalItem[] = SCHEDULE.flatMap((s) => s.tasks.filter((t) => t.role === role && t.due).map((t, i) => ({
    id: `${s.id}-${i}`, date: t.due!, title: t.label, tone: "deadline" as const, tag: "我的期限", href: t.href,
  })));
  return [...tasks, ...events];
}

export default async function TimelinePage() {
  const viewer = await getViewer();
  if (!viewer.isMember || viewer.role === "guest") return <NeedLogin returnTo="/timeline" what="專題時程" />;
  const year = `${SCHEDULE_YEAR.label}（${SCHEDULE_YEAR.from.slice(0, 4)}–${SCHEDULE_YEAR.to.slice(0, 4)}）`;
  return (
    <>
      <PageHead title="專題時程" description={year} crumbs={[{ label: "專題時程" }]} />
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-5 py-8 md:py-10">
        <StageRail stages={SCHEDULE} />
        <FullCalendar items={itemsFor(viewer.role)} today={TODAY_YMD} />
      </div>
    </>
  );
}
