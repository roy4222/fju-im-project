import Link from "next/link";
import { IconHandGrab } from "@tabler/icons-react";
import { Panel, Pill } from "@/components/dashboard/primitives";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ClaimDialog } from "@/components/dashboard/group-actions";
import { CURRENT_USERS, INDUSTRY, TEACHERS, type Group } from "@/lib/fixtures";

type ClaimState = "open" | "mine" | "taken";

/** 老師：可認領的產學組（T-06）。一張表，狀態各有欄位：可認領／已指導／已被認領。 */
export function ClaimPanel({ groups }: { groups: Group[] }) {
  const me = CURRENT_USERS.teacher;
  const rows = groups
    .filter((g) => g.type === "INDUSTRY")
    .map((g) => {
      const state: ClaimState = g.advisorId === null ? "open" : g.advisorId === me.id ? "mine" : "taken";
      const advisor = TEACHERS.find((t) => t.id === g.advisorId)?.name;
      const company = INDUSTRY.find((i) => i.id === g.industryId)?.company ?? g.title.match(/（產學：(.*)）/)?.[1] ?? "—";
      return { g, state, advisor, company };
    })
    .sort((a, b) => order(a.state) - order(b.state));
  const open = rows.filter((r) => r.state === "open").length;

  return (
    <Panel title="產學組認領" icon={<IconHandGrab />} description={`可認領 ${open} 組・先按先得，同時操作只有一位會成功`}>
      <div className="px-3 pb-3">
        <Table>
          <TableHeader>
            <TableRow className="hover:[&>td]:bg-transparent">
              <TableHead className="w-20">組別</TableHead>
              <TableHead>題目</TableHead>
              <TableHead className="hidden md:table-cell">合作單位</TableHead>
              <TableHead className="w-28">狀態</TableHead>
              <TableHead className="w-28 text-right">動作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(({ g, state, advisor, company }) => (
              <TableRow key={g.id} className={state === "open" ? "" : "text-muted-foreground"}>
                <TableCell className="tabular text-xs font-semibold">{g.no}</TableCell>
                <TableCell className="max-w-[18rem] truncate whitespace-normal font-semibold text-foreground md:whitespace-nowrap">{g.title.replace(/（產學：.*）/, "")}<span className="block text-xs font-normal text-muted-foreground md:hidden">{company}</span></TableCell>
                <TableCell className="hidden md:table-cell">{company}</TableCell>
                <TableCell>{state === "open" ? <Pill tone="brand">可認領</Pill> : state === "mine" ? <Pill tone="success">已指導</Pill> : <Pill tone="default">已被認領・{advisor}</Pill>}</TableCell>
                <TableCell className="text-right">
                  {state === "open" ? <ClaimDialog groupNo={g.no} title={g.title} /> : state === "mine" ? <Link href={`/dashboard/teacher/grading/${g.id}`} className="text-xs font-semibold text-primary underline-offset-2 hover:underline">開啟評分</Link> : <span className="text-xs">—</span>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Panel>
  );
}

function order(s: ClaimState) {
  return s === "open" ? 0 : s === "mine" ? 1 : 2;
}
