import { notFound } from "next/navigation";
import { IconCheck, IconHandGrab, IconMail, IconUsers, IconUsersGroup } from "@tabler/icons-react";
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

/* 學生：我的組別＋找組員（規格 §5.1–5.3）。Roy 2026-09-09：不要像儀表板，像一張組員名單。 */
function StudentGroup() {
  const me = CURRENT_USERS.student;
  const confirmed = MY_GROUP.members.filter((m) => m.confirmed).length;
  const advisor = TEACHERS.find((t) => t.id === MY_GROUP.advisorId);
  const seats = [...MY_GROUP.members, ...Array.from({ length: Math.max(0, 5 - MY_GROUP.members.length) }, () => null)];
  return (
    <div className="flex flex-col gap-5">
      <PageTitle title="我的組別" description="五位成員各自確認後才正式成立。" />
      <section className="dash-card overflow-hidden">
        <div className="flex flex-wrap items-start justify-between gap-4 px-6 pt-6">
          <div className="min-w-0">
            <p className="tabular text-xs font-bold tracking-[0.06em] text-muted-foreground">{MY_GROUP.no}・{MY_GROUP.type === "INDUSTRY" ? "產學合作" : "一般專題"}</p>
            <h2 className="mt-1 text-[24px] font-extrabold tracking-tight">{MY_GROUP.title}</h2>
            <p className="mt-1 text-sm text-muted-foreground">指導老師 {advisor?.name ?? "尚未指派"}</p>
          </div>
          <Pill tone={MY_GROUP.status === "active" ? "success" : "brand"} className="text-xs">{MY_GROUP.status === "active" ? "已成立" : `成立中・還差 ${5 - confirmed} 人確認`}</Pill>
        </div>
        <ol className="grid grid-cols-5 gap-2 px-6 pt-7 pb-6 sm:gap-4">
          {seats.map((m, i) => (
            <li key={m?.id ?? `empty-${i}`} className="flex flex-col items-center text-center">
              <span className={`relative inline-flex size-14 items-center justify-center rounded-full text-[17px] font-bold sm:size-16 ${!m ? "border-2 border-dashed border-border text-muted-foreground/50" : m.confirmed ? "bg-primary text-primary-foreground" : "border-2 border-border bg-muted text-muted-foreground"}`}>
                {m ? m.name.slice(-2) : "?"}
                {m?.confirmed ? <span className="absolute -right-0.5 -bottom-0.5 inline-flex size-5 items-center justify-center rounded-full bg-success text-success-foreground ring-2 ring-card"><IconCheck className="size-3" strokeWidth={3} /></span> : null}
                {m?.isLeader ? <span className="absolute -top-1.5 left-1/2 -translate-x-1/2 rounded-full bg-brand px-1.5 text-[10px] font-bold text-brand-foreground ring-2 ring-card">組長</span> : null}
              </span>
              <span className={`mt-2 truncate text-sm ${m?.id === me.id ? "font-bold" : "font-medium"} ${!m ? "text-muted-foreground" : ""}`}>{m ? m.name : "空位"}</span>
              <span className="tabular text-[11px] text-muted-foreground">{m ? (m.confirmed ? "已確認" : "待確認") : "尚未加入"}</span>
            </li>
          ))}
        </ol>
        <div className="flex items-center gap-3 border-t border-border/70 px-6 py-3 text-xs text-muted-foreground">
          <span className="tabular font-semibold text-foreground">{confirmed}/5 已確認</span>
          <span>・每個人用自己的帳號按確認；全員確認後組別成立，之後才能抽籤與繳交。</span>
        </div>
      </section>

      <Panel title="找組員" icon={<IconUsers />} description="只顯示本人開啟公開的同屆未分組學生">
        <ul className="divide-y divide-border">
          {UNGROUPED.filter((u) => u.openToJoin).map((u) => (
            <li key={u.id} className="flex items-center gap-3 px-5 py-3 text-sm">
              <span className="inline-flex size-9 items-center justify-center rounded-full bg-muted text-xs font-bold text-foreground">{u.name.slice(-2)}</span>
              <span className="font-semibold">{u.name}</span>
              <span className="tabular text-xs text-muted-foreground">{u.studentNo}</span>
              <a href={`mailto:${u.studentNo}@m365.fju.edu.tw`} className="ml-auto inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline"><IconMail className="size-3.5" /> 聯絡</a>
            </li>
          ))}
        </ul>
        <p className="px-5 py-3 text-xs text-muted-foreground">電話不公開；完成分組後聯絡資訊立即隱藏。</p>
      </Panel>
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
