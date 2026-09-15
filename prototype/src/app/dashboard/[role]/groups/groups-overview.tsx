import { IconUsers, IconUsersGroup } from "@tabler/icons-react";
import { PageTitle, Panel, Pill } from "@/components/dashboard/primitives";
import { ClaimPanel } from "@/components/dashboard/claim-panel";
import { JoinGroupDialog } from "@/components/dashboard/group-actions";
import { COHORT, GROUPS, UNGROUPED, type Role } from "@/lib/fixtures";
import { GroupsTable } from "./groups-table";

/**
 * 老師／管理員：分組總覽（Codex 09-10 A-04）。
 * 四個 StatTile 縮成標題下一行摘要；老師看可認領產學組（ClaimPanel）；管理員看未分組學生；表格點組別開詳情。
 */
export function GroupsOverview({ role }: { role: Role }) {
  const industry = GROUPS.filter((g) => g.type === "INDUSTRY");
  const unassigned = industry.filter((g) => g.advisorId === null);
  const exceptions = GROUPS.filter((g) => g.status === "exception");
  const forming = GROUPS.filter((g) => g.status === "forming");
  const grouped = GROUPS.reduce((a, g) => a + g.members.length, 0);
  const base = `/dashboard/${role}`;
  return (
    <div className="flex flex-col gap-5">
      <PageTitle title="分組總覽" description={`${COHORT.label}・${GROUPS.length} 組、${grouped} 人已分組、${UNGROUPED.length} 人未分組・產學 ${industry.length} 組（${unassigned.length} 組未指派老師）・成立中 ${forming.length}・例外 ${exceptions.length}。分類只影響流程與標示，不限制老師看見哪些組別。`} />
      {role === "teacher" ? <ClaimPanel groups={GROUPS} /> : null}
      {role === "admin" && UNGROUPED.length ? (
        <Panel title="未分組學生" icon={<IconUsers />} description={`${UNGROUPED.length} 人・${UNGROUPED.filter((u) => u.openToJoin).length} 人公開找組員`}>
          <table className="w-full text-sm">
            <thead><tr className="border-t border-border/70 bg-muted/40 text-left text-[12px] text-muted-foreground"><th className="px-5 py-2.5 font-semibold">姓名</th><th className="px-4 py-2.5 font-semibold">學號</th><th className="px-4 py-2.5 font-semibold">找組員</th><th className="px-5 py-2.5"></th></tr></thead>
            <tbody>
              {UNGROUPED.map((u) => (
                <tr key={u.id} className="border-t border-border/70">
                  <td className="px-5 py-2.5 font-semibold">{u.name}</td>
                  <td className="tabular px-4 py-2.5">{u.studentNo}</td>
                  <td className="px-4 py-2.5">{u.openToJoin ? <Pill tone="brand">公開找組員</Pill> : <Pill tone="default">未公開</Pill>}</td>
                  <td className="px-5 py-2.5 text-right"><JoinGroupDialog student={u} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      ) : null}
      <Panel title="全部組別" icon={<IconUsersGroup />} description={role === "admin" ? "點組別看成員、老師、繳交與例外處理" : "可搜尋、排序、篩選"} bodyClassName="p-4">
        <GroupsTable groups={GROUPS} role={role} base={base} />
      </Panel>
    </div>
  );
}
