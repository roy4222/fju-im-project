import { IconCheck, IconClock, IconSignature, IconUsersGroup } from "@tabler/icons-react";
import { EmptyState, PageTitle, Panel, Pill, StatTile } from "@/components/dashboard/primitives";
import { SegmentBar } from "@/components/dashboard/charts";
import { ApproveActions } from "@/components/dashboard/signoff-actions";
import { CURRENT_USERS, GROUPS, SIGNOFF, SIGNOFF_PROGRESS } from "@/lib/fixtures";

function Steps({ students, total, teacher }: { students: number; total: number; teacher: boolean }) {
  return <SegmentBar segments={[{ value: students, color: "var(--success)", label: "學生已同意" }, { value: total - students, color: "var(--muted)", label: "學生未同意" }, { value: 1, color: teacher ? "var(--brand)" : "color-mix(in oklch, var(--brand) 25%, transparent)", label: "老師" }]} />;
}

/* 老師 */
export function TeacherSignoff() {
  const me = CURRENT_USERS.teacher;
  const mine = SIGNOFF_PROGRESS.filter((p) => GROUPS.find((g) => g.id === p.groupId)?.advisorId === me.id);
  const ready = mine.filter((p) => p.students === p.total && !p.teacher);
  return (
    <div className="flex flex-col gap-5">
      <PageTitle title="簽核進度" description="五位學生全數同意後，才輪到指導老師。" />
      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile label="待我同意" icon={<IconSignature />} value={ready.length} unit="組" tone={ready.length ? "brand" : "default"} />
        <StatTile label="已完成" icon={<IconCheck />} value={mine.filter((p) => p.state === "complete").length} unit="組" tone="success" />
        <StatTile label="學生同意中" icon={<IconClock />} value={mine.filter((p) => p.students < p.total).length} unit="組" />
      </div>
      <Panel title="我的指導組別" icon={<IconUsersGroup />} description={SIGNOFF.title}>
        {mine.length === 0 ? <EmptyState title="沒有指導組別" /> : (
          <ul className="divide-y divide-border">
            {mine.map((p) => (
              <li key={p.groupId} className="grid items-center gap-3 px-5 py-4 md:grid-cols-[minmax(0,1fr)_14rem_auto]">
                <div className="min-w-0"><span className="tabular text-xs font-semibold text-muted-foreground">{p.groupNo}</span><p className="truncate font-semibold">{p.title.replace(/（產學：.*）/, "")}</p></div>
                <div><Steps students={p.students} total={p.total} teacher={p.teacher} /><p className="tabular mt-1 text-[11px] text-muted-foreground">學生 {p.students}/{p.total}・老師 {p.teacher ? "已同意" : "—"}</p></div>
                <div className="md:justify-self-end">
                  {p.state === "complete" ? <Pill tone="success">完成</Pill> : p.students === p.total ? <ApproveActions who={`${me.name} 老師`} title={SIGNOFF.title} packageVersion={SIGNOFF.packageVersion} /> : <Pill tone="default">等學生</Pill>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
