import { notFound } from "next/navigation";
import { PageTitle } from "@/components/dashboard/primitives";
import { GradingWorkbench } from "@/components/dashboard/grading-workbench";
import { isValidRole } from "@/lib/nav-config";
import { EVALUATION_QUEUE } from "@/lib/fixtures";

export default async function GradingGroupPage({ params }: PageProps<"/dashboard/[role]/grading/[groupId]">) {
  const { role, groupId } = await params;
  if (!isValidRole(role) || role !== "teacher") notFound();
  if (!EVALUATION_QUEUE.some((e) => e.groupId === groupId)) notFound();
  return (
    <div className="flex flex-col gap-5">
      <PageTitle title="評分工作台" description="只顯示你被指派的組別。暫存只有你看得到，送出後鎖定。" />
      <GradingWorkbench role={role} initialGroupId={groupId} />
    </div>
  );
}
