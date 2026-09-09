import Link from "next/link";
import { notFound } from "next/navigation";
import { IconAlertTriangle, IconBriefcase, IconCalendarDue, IconCheck, IconChecklist, IconClipboardText, IconClock, IconSignature, IconUpload, IconUserCheck, IconUsers, IconUsersGroup } from "@tabler/icons-react";
import { buttonVariants } from "@/components/ui/button";
import { ActionRow, Panel, Pill, ProgressBar, StateBadge } from "@/components/dashboard/primitives";
import { BarChart, HBar, Ring, SegmentBar } from "@/components/dashboard/charts";
import { HomeRenderer, type HomeModel, type Module } from "@/components/dashboard/home-variants";
import { isValidRole } from "@/lib/nav-config";
import { getDashVariant } from "@/lib/data/dash-variant-server";
import { ADMIN_STATS, AUDIT_EVENTS, CURRENT_USERS, EVALUATION_QUEUE, GRADING_PROGRESS, GROUPS, INDUSTRY, MANAGED_ITEMS, MY_GROUP, SIGNOFF, SIGNOFF_PROGRESS, SUBMISSION_TREND, TEACHERS, currentStage, daysUntil, formatDue, stageTasksFor, type Role } from "@/lib/fixtures";

/**
 * 後台首頁：問候 → 統計一條 → 本屆時程（現在這階段要做的事在裡面）→ 公告 → 有才出現的模組。
 * 版面由 cookie 的首頁時程做法決定（A 軌道／B 行程／C 甘特），見 home-variants.tsx。
 */
export default async function DashboardPage({ params }: PageProps<"/dashboard/[role]">) {
  const { role } = await params;
  if (!isValidRole(role)) notFound();
  const variant = await getDashVariant();
  const model = role === "student" ? studentHome(role) : role === "teacher" ? teacherHome(role) : adminHome(role);
  return <HomeRenderer model={model} variant={variant} />;
}

function Due({ dueAt }: { dueAt: string }) {
  const d = daysUntil(dueAt);
  return <span className={`tabular inline-flex items-center gap-1 text-xs font-semibold ${d < 0 ? "text-destructive" : d <= 10 ? "text-brand" : "text-muted-foreground"}`}><IconClock className="size-3.5" />{formatDue(dueAt)}・{dueAt.slice(5)}</span>;
}

/* ============================================================ 學生 */
function studentHome(role: Role): HomeModel {
  const base = `/dashboard/${role}`;
  const user = CURRENT_USERS.student;
  const open = MANAGED_ITEMS.filter((i) => i.dueAt && i.myState && i.myState !== "submitted" && i.myState !== "overdue");
  const overdue = MANAGED_ITEMS.filter((i) => i.myState === "overdue");
  const submitted = MANAGED_ITEMS.filter((i) => i.myState === "submitted");
  const confirmed = MY_GROUP.members.filter((m) => m.confirmed).length;
  const approvals = SIGNOFF.studentApprovals.filter((a) => a.approved).length;
  const myPending = SIGNOFF.studentApprovals.some((a) => a.name === user.name && !a.approved);
  const stage = currentStage();
  const nextTask = stageTasksFor(stage, role).find((t) => !t.done);

  const modules: Module[] = [
    {
      key: "overdue", present: overdue.length > 0,
      node: (
        <Panel title="已逾期" description={`${overdue.length} 件`} action={{ href: `${base}/affairs?tab=overdue`, label: "作業區" }} className="h-full">
          <ul>
            {overdue.map((i) => (
              <li key={i.id} className="flex items-center gap-3 border-t border-border/70 px-5 py-3">
                <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{i.title}</p><Due dueAt={i.dueAt!} /></div>
                <StateBadge state="overdue" />
                <Link href={`${base}/affairs/${i.id}`} className={buttonVariants({ size: "sm", variant: "outline", className: "press rounded-lg" })}>查看</Link>
              </li>
            ))}
          </ul>
        </Panel>
      ),
    },
    {
      key: "group", present: confirmed < 5,
      node: (
        <Panel title="我的組別" description={`${confirmed}/5 確認`} action={{ href: `${base}/groups`, label: "詳情" }} className="h-full">
          <div className="px-5 pb-5">
            <p className="text-sm font-semibold">{MY_GROUP.title}</p>
            <p className="text-xs text-muted-foreground">指導老師 {TEACHERS.find((t) => t.id === MY_GROUP.advisorId)?.name ?? "尚未指派"}</p>
            <ul className="mt-3 flex flex-wrap gap-2">
              {MY_GROUP.members.map((m) => (
                <li key={m.id} className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${m.confirmed ? "bg-success-subtle text-success-on-subtle" : "bg-muted text-muted-foreground"}`}>
                  {m.confirmed ? <IconCheck className="size-3.5" /> : <IconClock className="size-3.5" />}{m.name}
                </li>
              ))}
            </ul>
          </div>
        </Panel>
      ),
    },
    {
      key: "sign", present: myPending,
      node: (
        <Panel title="同意書" description={`${approvals}/5 已同意`} action={{ href: `${base}/signoff`, label: "全文" }} className="h-full">
          <div className="px-5 pb-5">
            <p className="text-sm font-semibold">{SIGNOFF.title}</p>
            <SegmentBar className="mt-3" segments={[{ value: approvals, color: "var(--brand)", label: "已同意" }, { value: 5 - approvals, color: "var(--muted)", label: "未同意" }]} />
            <div className="mt-3.5 flex gap-2">
              <Link href={`${base}/signoff`} className="btn-fju h-9 rounded-md px-3.5 text-xs">閱讀全文</Link>
            </div>
          </div>
        </Panel>
      ),
    },
  ];

  return {
    role,
    greeting: { name: user.name, line: nextTask ? `${stage.title}進行中，下一步：${nextTask.label}${nextTask.due ? `，${formatDue(nextTask.due)}截止` : ""}。` : `${stage.title}進行中，這階段沒有你要做的事。` },
    stats: [
      { key: "open", label: "待繳", icon: <IconClipboardText />, value: open.length, unit: "件", tone: open.length ? "brand" : "default", href: `${base}/affairs?tab=open` },
      { key: "done", label: "已繳交", icon: <IconUpload />, value: submitted.length, unit: "件", hint: overdue.length ? `${overdue.length} 件逾期` : undefined, tone: "default", href: `${base}/affairs?tab=done` },
      { key: "group", label: "組員確認", icon: <IconUsers />, value: `${confirmed}/5`, hint: confirmed < 5 ? `還差 ${5 - confirmed} 人` : "全員到齊", href: `${base}/groups` },
      { key: "sign", label: "同意書", icon: <IconSignature />, value: `${approvals}/5`, hint: myPending ? "等你同意" : "等其他組員", href: `${base}/signoff` },
    ],
    modules,
  };
}

/* ============================================================ 老師 */
function teacherHome(role: Role): HomeModel {
  const base = `/dashboard/${role}`;
  const me = CURRENT_USERS.teacher;
  const myGroups = GROUPS.filter((g) => g.advisorId === me.id);
  const claimable = GROUPS.filter((g) => g.type === "INDUSTRY" && g.advisorId === null);
  const pending = EVALUATION_QUEUE.filter((e) => e.state === "pending");
  const staged = EVALUATION_QUEUE.filter((e) => e.state === "staged");
  const teacherSign = SIGNOFF_PROGRESS.filter((s) => s.students === s.total && !s.teacher && myGroups.some((g) => g.id === s.groupId));
  const myCases = INDUSTRY.filter((i) => i.advisorName === me.name);
  const work = EVALUATION_QUEUE.filter((e) => e.state !== "submitted");
  const stage = currentStage();

  const modules: Module[] = [
    {
      key: "queue", present: work.length > 0, span: 2,
      node: (
        <Panel title="待評分" description="系統驗收・占總成績 60%" action={{ href: `${base}/grading`, label: "工作台" }} className="h-full">
          <ul>
            {EVALUATION_QUEUE.map((e) => (
              <li key={e.groupId} className="flex items-center gap-4 border-t border-border/70 px-5 py-3">
                <span className="tabular w-14 shrink-0 text-xs font-semibold text-muted-foreground">{e.groupNo}</span>
                <span className="min-w-0 flex-1 truncate text-sm font-semibold">{e.title}</span>
                {e.state === "pending" ? <Pill tone="brand">未開始</Pill> : e.state === "staged" ? <Pill tone="default">已暫存</Pill> : <Pill tone="success">已送出</Pill>}
                <Link href={`${base}/grading/${e.groupId}`} className={buttonVariants({ size: "sm", variant: e.state === "pending" ? "default" : "outline", className: "press rounded-lg" })}>{e.state === "submitted" ? "檢視" : e.state === "staged" ? "繼續" : "評分"}</Link>
              </li>
            ))}
          </ul>
        </Panel>
      ),
    },
    {
      key: "claim", present: claimable.length > 0,
      node: (
        <Panel title="可認領產學組" description="先按先得" action={{ href: `${base}/groups`, label: "全部" }} className="h-full">
          <ul>
            {claimable.map((g) => (
              <li key={g.id} className="flex items-center gap-3 border-t border-border/70 px-5 py-3"><span className="tabular shrink-0 text-xs font-semibold text-muted-foreground">{g.no}</span><span className="min-w-0 flex-1 truncate text-sm font-semibold">{g.title.replace(/（產學：.*）/, "")}</span><Link href={`${base}/groups`} className={buttonVariants({ size: "sm", variant: "outline", className: "press rounded-lg" })}>認領</Link></li>
            ))}
          </ul>
        </Panel>
      ),
    },
    {
      key: "sign", present: teacherSign.length > 0,
      node: (
        <Panel title="待我同意" description="學生已全數同意" action={{ href: `${base}/signoff`, label: "進度" }} className="h-full">
          <ul>
            {teacherSign.map((s) => (
              <li key={s.groupId} className="flex items-center gap-3 border-t border-border/70 px-5 py-3"><span className="tabular shrink-0 text-xs font-semibold text-muted-foreground">{s.groupNo}</span><span className="min-w-0 flex-1 truncate text-sm font-semibold">{SIGNOFF.title}</span><Link href={`${base}/signoff`} className="btn-fju h-8 rounded-md px-3 text-xs">同意</Link></li>
            ))}
          </ul>
        </Panel>
      ),
    },
    {
      key: "progress", present: myGroups.length > 0,
      node: (
        <Panel title="指導組別繳交狀態" action={{ href: `${base}/affairs`, label: "各組" }} className="h-full">
          <ul>
            {myGroups.map((g, i) => (
              <li key={g.id} className="flex items-center gap-3 border-t border-border/70 px-5 py-3"><span className="tabular shrink-0 text-xs font-semibold text-muted-foreground">{g.no}</span><span className="min-w-0 flex-1 truncate text-sm font-semibold">{g.title.replace(/（產學：.*）/, "")}</span><div className="w-28"><ProgressBar done={[3, 4][i % 2]} total={5} overdue={g.id === "g-07" ? 1 : 0} /></div></li>
            ))}
          </ul>
        </Panel>
      ),
    },
    {
      key: "industry", present: myCases.length > 0,
      node: (
        <Panel title="我的合作案" description={`${myCases.length} 件`} action={{ href: `${base}/industry`, label: "管理" }} className="h-full">
          <ul>
            {myCases.map((c) => (
              <li key={c.id} className="flex items-center gap-3 border-t border-border/70 px-5 py-3"><span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold">{c.company}</span><span className="block truncate text-xs text-muted-foreground">{c.title}</span></span>{c.status === "claimed" ? <Pill tone="default">已有 {c.linkedGroups} 組</Pill> : <Pill tone="brand">尚未指派</Pill>}</li>
            ))}
          </ul>
        </Panel>
      ),
    },
  ];

  return {
    role,
    greeting: { name: `${me.name} 老師`, line: pending.length ? `${stage.title}進行中；系統驗收還有 ${pending.length} 組待評分。` : `${stage.title}進行中，目前沒有待評分的組別。` },
    stats: [
      { key: "pending", label: "待評分", icon: <IconChecklist />, value: pending.length, unit: "組", tone: pending.length ? "brand" : "default", href: `${base}/grading` },
      { key: "staged", label: "已暫存", icon: <IconClock />, value: staged.length, unit: "組", hint: "尚未送出", href: `${base}/grading` },
      { key: "groups", label: "指導組別", icon: <IconUsersGroup />, value: myGroups.length, unit: "組", hint: `${myGroups.filter((g) => g.type === "INDUSTRY").length} 組產學`, href: `${base}/groups` },
      { key: "sign", label: "待我同意", icon: <IconSignature />, value: teacherSign.length, unit: "件", tone: teacherSign.length ? "brand" : "default", href: `${base}/signoff` },
    ],
    modules,
  };
}

/* ============================================================ 管理員 */
function adminHome(role: Role): HomeModel {
  const base = `/dashboard/${role}`;
  const s = ADMIN_STATS;
  const items = MANAGED_ITEMS.filter((i) => i.progress);
  const unassignedIndustry = INDUSTRY.filter((i) => i.status === "open");
  const totalStudents = s.groupedStudents + s.ungroupedStudents;
  const gradingSubmitted = GRADING_PROGRESS.reduce((a, t) => a + t.submitted, 0);
  const gradingAssigned = GRADING_PROGRESS.reduce((a, t) => a + t.assigned, 0);
  const signComplete = SIGNOFF_PROGRESS.filter((p) => p.state === "complete").length;
  const missingTeachers = GRADING_PROGRESS.filter((t) => t.submitted < t.assigned).length;
  const overdueGroups = items.reduce((a, i) => a + (i.progress?.overdue ?? 0), 0);
  const stage = currentStage();
  const actions = [
    { tone: "brand" as const, icon: <IconUserCheck />, label: "待審核帳號", detail: "名單未命中或以 Email 註冊", count: s.pendingAccounts, href: `${base}/accounts?status=pending`, cta: "審核" },
    { tone: "danger" as const, icon: <IconAlertTriangle />, label: "逾期未繳組別", detail: "系統驗收簡報與說明文件", count: overdueGroups, href: `${base}/affairs/mi-011`, cta: "重新開放" },
    { tone: "default" as const, icon: <IconBriefcase />, label: "產學案未指派組別", detail: "老師可認領，或由系辦指派", count: unassignedIndustry.length, href: `${base}/industry`, cta: "查看" },
    { tone: "default" as const, icon: <IconChecklist />, label: "缺評老師", detail: "系統驗收階段尚未送出", count: missingTeachers, href: `${base}/grading`, cta: "催繳" },
    { tone: "default" as const, icon: <IconUsers />, label: "例外組別", detail: "非五人組，已記錄理由", count: s.groupExceptions, href: `${base}/groups`, cta: "查看" },
  ].filter((a) => a.count > 0);

  const modules: Module[] = [
    {
      key: "actions", present: actions.length > 0,
      node: (
        <Panel title="需要處理" description={`${actions.length} 件`} className="h-full">
          <ul>{actions.map((a) => <ActionRow key={a.label} {...a} />)}</ul>
        </Panel>
      ),
    },
    {
      key: "grouping", present: s.ungroupedStudents > 0,
      node: (
        <Panel title="本屆分組" action={{ href: `${base}/groups`, label: "總覽" }} className="h-full">
          <div className="flex items-center gap-5 px-5 pb-5">
            <Ring value={(s.groupedStudents / totalStudents) * 100} size={96} stroke={11} color="var(--brand)"><span className="tabular text-base font-extrabold">{Math.round((s.groupedStudents / totalStudents) * 100)}%</span></Ring>
            <ul className="flex flex-1 flex-col gap-2 text-sm">
              {[["已分組", s.groupedStudents, "bg-brand"], ["未分組", s.ungroupedStudents, "bg-muted-foreground/40"], ["例外組", s.groupExceptions, "bg-border"]].map(([l, v, c]) => (
                <li key={String(l)} className="flex items-center gap-2"><span className={`size-2.5 rounded-[3px] ${c}`} /><span className="text-muted-foreground">{l}</span><span className="tabular ml-auto font-bold">{v}</span></li>
              ))}
            </ul>
          </div>
        </Panel>
      ),
    },
    {
      key: "intake", present: items.length > 0,
      node: (
        <Panel title="收件完成率" action={{ href: `${base}/affairs`, label: "工作台" }} className="h-full">
          <ul className="flex flex-col gap-3 px-5 pb-5">
            {items.map((i) => (
              <li key={i.id}><div className="mb-1.5 flex items-center justify-between gap-3"><Link href={`${base}/affairs/${i.id}`} className="truncate text-sm font-semibold hover:text-brand">{i.title}</Link><span className="tabular shrink-0 text-xs text-muted-foreground">{i.progress!.done}/{i.progress!.total}</span></div><SegmentBar segments={[{ value: i.progress!.done, color: "var(--brand)", label: "已繳" }, { value: i.progress!.overdue, color: "var(--destructive)", label: "逾期" }, { value: i.progress!.total - i.progress!.done - i.progress!.overdue, color: "var(--muted)", label: "未繳" }]} /></li>
            ))}
          </ul>
        </Panel>
      ),
    },
    {
      key: "grading", present: gradingSubmitted < gradingAssigned,
      node: (
        <Panel title="老師評分進度" description="系統驗收" action={{ href: `${base}/grading`, label: "成績" }} className="h-full">
          <ul className="flex flex-col gap-3 px-5 pb-5">
            {GRADING_PROGRESS.map((t) => <li key={t.teacher}><HBar label={t.teacher} value={t.submitted} total={t.assigned} color={t.submitted === t.assigned ? "var(--success)" : t.submitted === 0 ? "var(--destructive)" : "var(--brand)"} /></li>)}
          </ul>
        </Panel>
      ),
    },
    {
      key: "trend", present: SUBMISSION_TREND.some((d) => d.count > 0),
      node: (
        <Panel title="近 7 天正式繳交" description={`共 ${SUBMISSION_TREND.reduce((a, d) => a + d.count, 0)} 件`} className="h-full">
          <div className="px-5 pt-1 pb-4 text-foreground"><BarChart data={SUBMISSION_TREND.map((d) => ({ label: d.day.slice(3), value: d.count }))} highlight={SUBMISSION_TREND.length - 1} color="currentColor" /></div>
        </Panel>
      ),
    },
    {
      key: "storage", present: true,
      node: (
        <Panel title="儲存與備份" action={{ href: `${base}/files`, label: "檔案" }} className="h-full">
          <div className="flex items-center gap-5 px-5 pb-5">
            <Ring value={(s.storageUsedGiB / s.storageTotalGiB) * 100} size={72} stroke={8} color="var(--brand)"><span className="tabular text-sm font-extrabold">{Math.round((s.storageUsedGiB / s.storageTotalGiB) * 100)}%</span></Ring>
            <dl className="grid flex-1 gap-1.5 text-sm">
              <div className="flex justify-between"><dt className="text-muted-foreground">已用</dt><dd className="tabular font-semibold">{s.storageUsedGiB} / {s.storageTotalGiB} GiB</dd></div>
              <div className="flex justify-between"><dt className="text-muted-foreground">最近備份</dt><dd className="tabular font-semibold">{s.lastBackupAt.slice(5)}</dd></div>
              <div className="flex justify-between"><dt className="text-muted-foreground">還原演練</dt><dd className="font-semibold text-warning-on-subtle">{s.lastRestoreDrillAt}</dd></div>
            </dl>
          </div>
        </Panel>
      ),
    },
    {
      key: "audit", present: true, span: 2,
      node: (
        <Panel title="最近操作" action={{ href: `${base}/audit`, label: "紀錄" }} className="h-full">
          <ul>
            {AUDIT_EVENTS.slice(0, 4).map((e) => (
              <li key={e.id} className="flex items-center gap-3 border-t border-border/70 px-5 py-2.5 text-sm"><time className="tabular w-20 shrink-0 text-xs text-muted-foreground">{e.at.slice(5)}</time><span className="w-20 shrink-0 truncate font-semibold">{e.actor}</span><Pill tone="default">{e.action}</Pill><span className="min-w-0 flex-1 truncate text-muted-foreground">{e.target}</span></li>
            ))}
          </ul>
        </Panel>
      ),
    },
  ];

  return {
    role,
    greeting: { name: "系辦", line: actions.length ? `${stage.title}進行中；今天有 ${actions.length} 件事需要你處理。` : `${stage.title}進行中，沒有待處理事項。` },
    stats: [
      { key: "accounts", label: "待審核帳號", icon: <IconUserCheck />, value: s.pendingAccounts, unit: "筆", tone: "brand", href: `${base}/accounts?status=pending` },
      { key: "overdue", label: "逾期組別", icon: <IconCalendarDue />, value: overdueGroups, unit: "組", tone: overdueGroups ? "danger" : "default", href: `${base}/affairs/mi-011` },
      { key: "grading", label: "評分完成", icon: <IconChecklist />, value: `${gradingSubmitted}/${gradingAssigned}`, hint: `${missingTeachers} 位老師缺評`, href: `${base}/grading` },
      { key: "sign", label: "簽核完成", icon: <IconSignature />, value: `${signComplete}/${GROUPS.length}`, unit: "組", href: `${base}/signoff` },
    ],
    modules,
  };
}
