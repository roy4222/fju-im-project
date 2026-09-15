import { notFound } from "next/navigation";
import { IconClipboardText } from "@tabler/icons-react";
import { PageTitle, Panel } from "@/components/dashboard/primitives";
import { isValidRole } from "@/lib/nav-config";
import { TeacherMatrix } from "./teacher-matrix";
import { StudentAffairs } from "./student-affairs";
import { AdminAffairs } from "./admin-affairs";
import { CURRENT_USERS, GROUPS, MANAGED_ITEMS, type Role } from "@/lib/fixtures";

export default async function AffairsPage({ params, searchParams }: PageProps<"/dashboard/[role]/affairs">) {
  const { role } = await params;
  const sp = await searchParams;
  if (!isValidRole(role)) notFound();
  if (role === "student") return <StudentAffairs role={role} tab={typeof sp.tab === "string" ? sp.tab : "all"} />;
  if (role === "teacher") return <TeacherAffairs role={role} />;
  return <AdminAffairs role={role} placement={typeof sp.placement === "string" ? sp.placement : "all"} />;
}

/* ---------------------------------------------------------------- 老師 */
function TeacherAffairs({ role }: { role: Role }) {
  const base = `/dashboard/${role}`;
  const me = CURRENT_USERS.teacher;
  const myGroups = GROUPS.filter((g) => g.advisorId === me.id);
  const items = MANAGED_ITEMS.filter((i) => i.progress);
  return (
    <div className="flex flex-col gap-5">
      <PageTitle title="各組繳交狀態" description={`我的 ${myGroups.length} 個指導組別 × ${items.length} 個收件項目`} />
      <Panel title="繳交矩陣" icon={<IconClipboardText />} description="點狀態看版本與內容" bodyClassName="p-4">
        <TeacherMatrix groups={myGroups} items={items} base={base} />
      </Panel>
    </div>
  );
}
