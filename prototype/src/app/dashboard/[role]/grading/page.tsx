import { notFound, redirect } from "next/navigation";
import { IconLock } from "@tabler/icons-react";
import { EmptyState, PageTitle, Panel } from "@/components/dashboard/primitives";
import { isValidRole } from "@/lib/nav-config";
import { EVALUATION_QUEUE } from "@/lib/fixtures";
import { AdminGrading } from "./admin-grading";

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
  if (role === "teacher") {
    /* T-03：目前組別是路由狀態，沒帶 id 就補上隊列第一組 */
    redirect(`/dashboard/${role}/grading/${EVALUATION_QUEUE[0].groupId}`);
  }
  return <AdminGrading role={role} />;
}
