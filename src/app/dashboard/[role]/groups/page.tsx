import { notFound } from "next/navigation";
import { IconInfoCircle } from "@tabler/icons-react";
import { StatTile } from "@/components/dashboard/primitives";
import { isValidRole } from "@/lib/nav-config";
import { COHORT, GROUPS, UNGROUPED } from "@/lib/fixtures";
import { GroupsTable } from "./groups-table";

export default async function GroupsPage({
  params,
}: PageProps<"/dashboard/[role]/groups">) {
  const { role } = await params;
  if (!isValidRole(role)) notFound();

  const industry = GROUPS.filter((g) => g.type === "INDUSTRY");
  const unassigned = industry.filter((g) => g.advisorId === null);

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="本屆組別" value={GROUPS.length} unit="組" hint={COHORT.label} />
        <StatTile label="產學組" value={industry.length} unit="組" />
        <StatTile
          label="產學未指派老師"
          value={unassigned.length}
          unit="組"
          tone={unassigned.length > 0 ? "warning" : "default"}
        />
        <StatTile label="未分組學生" value={UNGROUPED.length} unit="人" />
      </div>

      <div className="flex items-start gap-2.5 rounded-lg border border-info/25 bg-info-subtle px-4 py-3 text-sm text-info-on-subtle">
        <IconInfoCircle className="mt-0.5 size-4 shrink-0" />
        <p className="leading-relaxed">
          分類只影響流程與標示，<strong>不限制老師看見哪些組別</strong>
          。所有老師都可查看一般與產學組別；產學組未指派時，老師可直接認領，同時操作只有一位會成功。
        </p>
      </div>

      <GroupsTable groups={GROUPS} role={role} />
    </div>
  );
}
