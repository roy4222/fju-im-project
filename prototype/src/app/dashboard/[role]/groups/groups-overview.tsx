import { IconHandGrab, IconUsers, IconUsersGroup } from "@tabler/icons-react";
import { PageTitle, Panel, Pill, StatTile } from "@/components/dashboard/primitives";
import { Ring } from "@/components/dashboard/charts";
import { ClaimDialog } from "@/components/dashboard/group-actions";
import { COHORT, GROUPS, UNGROUPED, type Role } from "@/lib/fixtures";
import { GroupsTable } from "./groups-table";

/* 老師／管理員：分組總覽 */
export function GroupsOverview({ role }: { role: Role }) {
  const industry = GROUPS.filter((g) => g.type === "INDUSTRY");
  const unassigned = industry.filter((g) => g.advisorId === null);
  const exceptions = GROUPS.filter((g) => g.status === "exception");
  const grouped = GROUPS.reduce((a, g) => a + g.members.length, 0);
  return (
    <div className="flex flex-col gap-5">
      <PageTitle title="分組總覽" description={`${COHORT.label}・分類只影響流程與標示，不限制老師看見哪些組別。`} />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="本屆組別" icon={<IconUsersGroup />} value={GROUPS.length} unit="組" hint={`${grouped} 人已分組`} chart={<Ring value={(grouped / (grouped + UNGROUPED.length)) * 100} size={44} stroke={5} />} />
        <StatTile label="產學組" icon={<IconHandGrab />} value={industry.length} unit="組" hint={`${unassigned.length} 組未指派`} tone={unassigned.length ? "warning" : "default"} chart={<Ring value={((industry.length - unassigned.length) / Math.max(industry.length, 1)) * 100} size={44} stroke={5} color="var(--brand)" />} />
        <StatTile label="未分組學生" icon={<IconUsers />} value={UNGROUPED.length} unit="人" hint={`${UNGROUPED.filter((u) => u.openToJoin).length} 人公開找組員`} />
        <StatTile label="例外組別" icon={<IconUsersGroup />} value={exceptions.length} unit="組" hint="非五人，已記錄理由" tone={exceptions.length ? "warning" : "default"} />
      </div>
      {role === "teacher" && unassigned.length ? (
        <Panel title="可認領的產學組" icon={<IconHandGrab />} description="先按先得；同時操作只有一位會成功">
          <ul className="grid gap-4 p-4 md:grid-cols-2">
            {unassigned.map((g) => (
              <li key={g.id} className="card-lift flex items-center gap-4 rounded-xl border border-border bg-background p-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2"><span className="tabular text-xs font-semibold text-muted-foreground">{g.no}</span><Pill tone="brand">產學</Pill></div>
                  <p className="truncate font-semibold">{g.title.replace(/（產學：.*）/, "")}</p>
                  <p className="truncate text-xs text-muted-foreground">{g.members.map((m) => m.name).join("、")}</p>
                </div>
                <ClaimDialog groupNo={g.no} title={g.title} size="lg" />
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
      <Panel title="全部組別" icon={<IconUsersGroup />} description="可搜尋、排序、篩選、勾選匯出" bodyClassName="p-4">
        <GroupsTable groups={GROUPS} role={role} />
      </Panel>
    </div>
  );
}
