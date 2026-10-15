import { notFound } from "next/navigation";
import { IconLock } from "@tabler/icons-react";
import { EmptyState, PageTitle, Panel } from "@/components/dashboard/primitives";
import { isValidRole } from "@/lib/nav-config";
import { AdminGrading } from "./admin-grading";
import { TeacherGrading } from "./teacher-grading";

export default async function GradingPage({ params }: PageProps<"/dashboard/[role]/grading">) {
  const { role } = await params;
  if (!isValidRole(role)) notFound();
  if (role === "student") {
    return (
      <div className="flex flex-col gap-5">
        <PageTitle title="成績" />
        <Panel title="v1 學生看不到成績" icon={<IconLock />}><EmptyState icon={<IconLock />} title="成績只有老師與系辦看得到" hint="規格 §7.6：學生所有頁面與 API 都取得不到分數、評語或排名。" /></Panel>
      </div>
    );
  }
  /* 老師 v2：評分總覽（Roy 2026-10-15） */
  if (role === "teacher") return <TeacherGrading />;
  return <AdminGrading role={role} />;
}
