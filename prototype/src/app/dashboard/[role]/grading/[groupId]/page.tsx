import { notFound } from "next/navigation";
import { isValidRole } from "@/lib/nav-config";
import { GRADING_GROUPS } from "@/lib/teacher-v2";
import { GradingDesk } from "./grading-desk";

export default async function GradingGroupPage({ params }: PageProps<"/dashboard/[role]/grading/[groupId]">) {
  const { role, groupId } = await params;
  if (!isValidRole(role) || role !== "teacher") notFound();
  if (!GRADING_GROUPS.some((g) => g.groupId === groupId)) notFound();
  /* key：換組時整個評分卡重來，不帶上一組沒存的修改 */
  return <GradingDesk key={groupId} groupId={groupId} />;
}
