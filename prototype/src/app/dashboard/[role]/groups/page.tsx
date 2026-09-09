import { notFound } from "next/navigation";
import { IconCheck, IconClock, IconCrown, IconHandGrab, IconMail, IconUsers, IconUsersGroup } from "@tabler/icons-react";
import { PageTitle, Panel, Pill, StatTile } from "@/components/dashboard/primitives";
import { Ring } from "@/components/dashboard/charts";
import { ClaimDialog } from "@/components/dashboard/group-actions";
import { isValidRole } from "@/lib/nav-config";
import { COHORT, CURRENT_USERS, GROUPS, MY_GROUP, TEACHERS, UNGROUPED, type Role } from "@/lib/fixtures";
import { GroupsTable } from "./groups-table";

export default async function GroupsPage({ params }: PageProps<"/dashboard/[role]/groups">) {
  const { role } = await params;
  if (!isValidRole(role)) notFound();
  if (role === "student") return <StudentGroup />;
  return <GroupsOverview role={role} />;
}

/* 學生：我的組別＋找組員（規格 §5.1–5.3） */
function StudentGroup() {
  const me = CURRENT_USERS.student;
  const confirmed = MY_GROUP.members.filter((m) => m.confirmed).length;
  const advisor = TEACHERS.find((t) => t.id === MY_GROUP.advisorId);
  return (
    <div className="flex flex-col gap-5">
      <PageTitle title="我的組別" description="五位成員各自確認後才正式成立。" />
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Panel title={MY_GROUP.no} icon={<IconUsersGroup />} description={MY_GROUP.title} action={<Pill tone={MY_GROUP.status === "active" ? "success" : "warning"}>{MY_GROUP.status === "active" ? "已成立" : "成立中"}</Pill>}>
          <div className="flex items-center gap-5 border-b border-border px-5 py-4">
            <Ring value={(confirmed / 5) * 100} size={72} color={confirmed === 5 ? "var(--success)" : "var(--warning)"}><span className="tabular text-base font-extrabold">{confirmed}/5</span></Ring>
            <div className="text-sm">
              <p className="font-bold">{confirmed === 5 ? "全員已確認" : `還差 ${5 - confirmed} 人確認`}</p>
              <p className="text-xs text-muted-foreground">類型 {MY_GROUP.type === "INDUSTRY" ? "產學合作" : "一般專題"}・指導老師 {advisor?.name ?? "尚未指派"}</p>
            </div>
          </div>
          <ul className="divide-y divide-border">
            {MY_GROUP.members.map((m) => (
              <li key={m.id} className="flex items-center gap-3 px-5 py-3 text-sm">
                {m.confirmed ? <span className="inline-flex size-7 items-center justify-center rounded-full bg-success-subtle text-success-on-subtle"><IconCheck className="size-4" /></span> : <span className="inline-flex size-7 items-center justify-center rounded-full bg-muted text-muted-foreground"><IconClock className="size-4" /></span>}
                <span className={`font-semibold ${m.id === me.id ? "text-primary" : ""}`}>{m.name}</span>
                <span className="tabular text-xs text-muted-foreground">{m.studentNo}</span>
                {m.isLeader ? <Pill tone="brand"><IconCrown className="mr-1 size-3" />組長</Pill> : null}
                <span className="ml-auto text-xs text-muted-foreground">{m.confirmed ? "已確認" : "待確認"}</span>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title="找組員" icon={<IconUsers />} description="只顯示本人開啟公開的同屆未分組學生">
          <ul className="divide-y divide-border">
            {UNGROUPED.filter((u) => u.openToJoin).map((u) => (
              <li key={u.id} className="flex items-center gap-3 px-5 py-3 text-sm">
                <span className="inline-flex size-8 items-center justify-center rounded-full bg-brand-subtle text-xs font-bold text-brand-on-subtle">{u.name.slice(0, 1)}</span>
                <span className="font-semibold">{u.name}</span>
                <span className="tabular text-xs text-muted-foreground">{u.studentNo}</span>
                <a href={`mailto:${u.studentNo}@m365.fju.edu.tw`} className="ml-auto inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline"><IconMail className="size-3.5" /> 聯絡</a>
              </li>
            ))}
          </ul>
          <p className="px-5 py-3 text-xs text-muted-foreground">電話不公開；完成分組後聯絡資訊立即隱藏。</p>
        </Panel>
      </div>
    </div>
  );
}

/* 老師／管理員：分組總覽 */
function GroupsOverview({ role }: { role: Role }) {
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
