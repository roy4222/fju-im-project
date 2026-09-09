import Link from "next/link";
import { notFound } from "next/navigation";
import {
  IconAlertTriangle,
  IconBriefcase,
  IconCalendarDue,
  IconCheck,
  IconChecklist,
  IconClipboardText,
  IconClock,
  IconSignature,
  IconUpload,
  IconUserCheck,
  IconUsers,
  IconUsersGroup,
} from "@tabler/icons-react";
import { buttonVariants } from "@/components/ui/button";
import { Panel, Pill, ProgressBar, StateBadge } from "@/components/dashboard/primitives";
import { BarChart, HBar, Ring, SegmentBar } from "@/components/dashboard/charts";
import { HomeRenderer, type HomeModel, type Module } from "@/components/dashboard/home-variants";
import { isValidRole } from "@/lib/nav-config";
import { getDashVariant } from "@/lib/data/dash-variant-server";
import {
  ADMIN_STATS,
  AUDIT_EVENTS,
  CURRENT_USERS,
  EVALUATION_QUEUE,
  GRADING_PROGRESS,
  GROUPS,
  INDUSTRY,
  MANAGED_ITEMS,
  MILESTONES,
  MY_GROUP,
  NEWS,
  SIGNOFF,
  SIGNOFF_PROGRESS,
  SUBMISSION_TREND,
  TEACHERS,
  daysUntil,
  formatDue,
  type Role,
} from "@/lib/fixtures";

/**
 * 後台首頁。三個角色各組一份 HomeModel（問候、統計、現在要做、里程碑、有才出現的模組），
 * 版面由 cookie 的後台版本決定（V1 模組網格／V2 時間軸／V3 控制台／V4 系網深藍），見 home-variants.tsx。
 * 規則不變：先回答「我現在要做什麼」；只有現在要做與里程碑固定存在；其他模組有才出現。
 */
export default async function DashboardPage({ params }: PageProps<"/dashboard/[role]">) {
  const { role } = await params;
  if (!isValidRole(role)) notFound();
  const variant = await getDashVariant();
  const model = role === "student" ? studentHome(role) : role === "teacher" ? teacherHome(role) : adminHome(role);
  return <HomeRenderer model={model} variant={variant} />;
}

/* ============================================================ 學生 */
function studentHome(role: Role): HomeModel {
  const base = `/dashboard/${role}`;
  const user = CURRENT_USERS.student;
  const todo = MANAGED_ITEMS.filter((i) => i.dueAt && i.myState && i.myState !== "submitted").sort((a, b) => daysUntil(a.dueAt!) - daysUntil(b.dueAt!));
  const submitted = MANAGED_ITEMS.filter((i) => i.myState === "submitted");
  const next = todo.find((i) => daysUntil(i.dueAt!) >= 0);
  const confirmed = MY_GROUP.members.filter((m) => m.confirmed).length;
  const approvals = SIGNOFF.studentApprovals.filter((a) => a.approved).length;
  const myPending = SIGNOFF.studentApprovals.some((a) => a.name === user.name && !a.approved);

  const modules: Module[] = [
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
        <Panel title="同意書" description={`${approvals}/5 已同意`} action={{ href: `${base}/signoff`, label: "紀錄" }} className="h-full">
          <div className="px-5 pb-5">
            <p className="text-sm font-semibold">{SIGNOFF.title}</p>
            <SegmentBar className="mt-3" segments={[{ value: approvals, color: "var(--brand)", label: "已同意" }, { value: 5 - approvals, color: "var(--muted)", label: "未同意" }]} />
            <div className="mt-3.5 flex gap-2">
              <Link href={`${base}/signoff`} className="btn-fju h-9 rounded-md px-3.5 text-xs">閱讀並同意</Link>
              <Link href={`${base}/signoff`} className={buttonVariants({ size: "sm", variant: "outline", className: "press rounded-lg" })}>不同意</Link>
            </div>
          </div>
        </Panel>
      ),
    },
    {
      key: "news", present: true,
      node: (
        <Panel title="近期公告" action={{ href: "/news", label: "全部" }} className="h-full">
          <ul>
            {NEWS.slice(0, 4).map((n) => (
              <li key={n.id}><Link href={`/news/${n.id}`} className="flex items-center gap-3 border-t border-border/70 px-5 py-2.5 transition-colors hover:bg-accent/50"><time className="tabular shrink-0 text-xs text-muted-foreground">{n.date.slice(5)}</time><span className="truncate text-sm font-medium">{n.title}</span></Link></li>
            ))}
          </ul>
        </Panel>
      ),
    },
    {
      key: "done", present: submitted.length > 0,
      node: (
        <Panel title="已繳交" description="截止前可重送" action={{ href: `${base}/affairs`, label: "版本" }} className="h-full">
          <ul>
            {submitted.map((i) => (
              <li key={i.id} className="flex items-center gap-3 border-t border-border/70 px-5 py-2.5"><IconCheck className="size-4 text-success" /><span className="min-w-0 flex-1 truncate text-sm font-medium">{i.title}</span><span className="tabular text-xs text-muted-foreground">v{i.schemaVersion}</span></li>
            ))}
          </ul>
        </Panel>
      ),
    },
  ];

  return {
    greeting: { name: user.name, line: next ? `下一個截止：${next.title}，${formatDue(next.dueAt!)}。` : "目前沒有即將截止的項目。" },
    stats: [
      { key: "todo", label: "待完成", icon: <IconClipboardText />, value: todo.length, unit: "項", tone: todo.length ? "brand" : "default", href: `${base}/affairs`, bars: [1, 2, 2, 3, 3, 4, todo.length] },
      { key: "done", label: "已繳交", icon: <IconUpload />, value: submitted.length, unit: "項", href: `${base}/affairs`, bars: [0, 0, 1, 1, 1, 1, submitted.length] },
      { key: "group", label: "組員確認", icon: <IconUsers />, value: `${confirmed}/5`, hint: confirmed < 5 ? `還差 ${5 - confirmed} 人` : "全員到齊", href: `${base}/groups`, ring: (confirmed / 5) * 100 },
      { key: "sign", label: "同意書", icon: <IconSignature />, value: `${approvals}/5`, hint: myPending ? "等你同意" : "等其他組員", href: `${base}/signoff`, ring: (approvals / 5) * 100 },
    ],
    focus: {
      title: "現在要做",
      description: `${todo.length} 件`,
      action: { href: `${base}/affairs`, label: "全部" },
      rows: todo.map((item) => ({
        id: item.id,
        title: item.title,
        dueAt: item.dueAt!,
        dot: item.myState === "overdue" ? "danger" : item.myState === "draft" ? "brand" : "muted",
        badge: <StateBadge state={item.myState!} />,
        cta: { href: `${base}/affairs/${item.id}`, primary: item.myState === "draft", label: item.myState === "draft" ? "繼續填寫" : item.myState === "overdue" ? "查看" : item.myState === "resubmit" ? "重送" : "開始" },
      })),
      empty: { title: "今天沒有待辦", hint: "達成的項目記在里程碑；有新項目會出現在這裡。" },
    },
    milestones: { items: MILESTONES.student, title: "本學期里程碑" },
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

  const modules: Module[] = [
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
    greeting: { name: `${me.name} 老師`, line: pending.length ? `系統驗收還有 ${pending.length} 組待評分，送出後鎖定。` : "目前沒有待評分的組別。" },
    stats: [
      { key: "pending", label: "待評分", icon: <IconChecklist />, value: pending.length, unit: "組", tone: pending.length ? "brand" : "default", href: `${base}/grading`, bars: [4, 4, 3, 3, 2, 2, pending.length] },
      { key: "staged", label: "已暫存", icon: <IconClock />, value: staged.length, unit: "組", hint: "尚未送出", href: `${base}/grading`, bars: [0, 0, 1, 1, 1, 1, staged.length] },
      { key: "groups", label: "指導組別", icon: <IconUsersGroup />, value: myGroups.length, unit: "組", hint: `${myGroups.filter((g) => g.type === "INDUSTRY").length} 組產學`, href: `${base}/groups`, ring: (myGroups.length / GROUPS.length) * 100 },
      { key: "sign", label: "待我同意", icon: <IconSignature />, value: teacherSign.length, unit: "件", tone: teacherSign.length ? "brand" : "default", href: `${base}/signoff`, bars: [0, 1, 1, 0, 1, 1, teacherSign.length] },
    ],
    focus: {
      title: "現在要做",
      description: "系統驗收・占總成績 60%",
      action: { href: `${base}/grading`, label: "工作台" },
      rows: work.length === 0 ? [] : EVALUATION_QUEUE.map((e) => ({
        id: e.groupId,
        leading: e.groupNo,
        title: e.title,
        detail: e.state === "pending" ? "系統驗收・尚未開始" : e.state === "staged" ? "系統驗收・已暫存" : "系統驗收・已送出",
        badge: e.state === "pending" ? <Pill tone="brand">未開始</Pill> : e.state === "staged" ? <Pill tone="default">已暫存</Pill> : <Pill tone="success">已送出</Pill>,
        cta: { href: `${base}/grading/${e.groupId}`, primary: e.state === "pending", label: e.state === "submitted" ? "檢視" : e.state === "staged" ? "繼續" : "評分" },
      })),
      empty: { title: "評分都送出了", hint: "有新的評分指派或簽核會出現在這裡。" },
    },
    milestones: { items: MILESTONES.teacher, title: "本學期里程碑" },
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
  const actions = [
    { iconTone: "brand" as const, icon: <IconUserCheck />, title: "待審核帳號", detail: "名單未命中或以 Email 註冊", count: s.pendingAccounts, href: `${base}/accounts?status=pending`, cta: "審核" },
    { iconTone: "danger" as const, icon: <IconAlertTriangle />, title: "逾期未繳組別", detail: "系統驗收簡報與說明文件", count: overdueGroups, href: `${base}/affairs/mi-011`, cta: "重新開放" },
    { iconTone: "default" as const, icon: <IconBriefcase />, title: "產學案未指派組別", detail: "老師可認領，或由系辦指派", count: unassignedIndustry.length, href: `${base}/industry`, cta: "查看" },
    { iconTone: "default" as const, icon: <IconChecklist />, title: "缺評老師", detail: "系統驗收階段尚未送出", count: missingTeachers, href: `${base}/grading`, cta: "催繳" },
    { iconTone: "default" as const, icon: <IconUsers />, title: "例外組別", detail: "非五人組，已記錄理由", count: s.groupExceptions, href: `${base}/groups`, cta: "查看" },
  ].filter((a) => a.count > 0);

  const modules: Module[] = [
    {
      key: "grouping", present: true,
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
      key: "trend", present: true,
      node: (
        <Panel title="近 7 天正式繳交" description={`共 ${SUBMISSION_TREND.reduce((a, d) => a + d.count, 0)} 件`} className="h-full">
          <div className="px-5 pt-1 pb-4 text-foreground"><BarChart data={SUBMISSION_TREND.map((d) => ({ label: d.day.slice(3), value: d.count }))} highlight={SUBMISSION_TREND.length - 1} color="currentColor" /></div>
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
    greeting: { name: "系辦", line: actions.length ? `今天有 ${actions.length} 件事需要你處理。` : "沒有待處理事項，本屆進度正常。" },
    stats: [
      { key: "accounts", label: "待審核帳號", icon: <IconUserCheck />, value: s.pendingAccounts, unit: "筆", tone: "brand", href: `${base}/accounts?status=pending`, bars: [1, 0, 2, 1, 3, 2, s.pendingAccounts] },
      { key: "overdue", label: "逾期組別", icon: <IconCalendarDue />, value: overdueGroups, unit: "組", tone: overdueGroups ? "danger" : "default", href: `${base}/affairs/mi-011`, bars: [0, 0, 1, 1, 2, 3, overdueGroups] },
      { key: "grading", label: "評分完成", icon: <IconChecklist />, value: `${gradingSubmitted}/${gradingAssigned}`, hint: `${missingTeachers} 位老師缺評`, href: `${base}/grading`, bars: [1, 2, 3, 4, 4, 5, gradingSubmitted] },
      { key: "sign", label: "簽核完成", icon: <IconSignature />, value: `${signComplete}/${GROUPS.length}`, unit: "組", href: `${base}/signoff`, bars: [0, 1, 1, 2, 2, 3, signComplete] },
    ],
    focus: {
      title: "需要處理",
      description: `${actions.length} 件`,
      rows: actions.map((a) => ({ id: a.title, icon: a.icon, iconTone: a.iconTone, title: a.title, detail: a.detail, count: a.count, cta: { href: a.href, label: a.cta } })),
      empty: { title: "沒有待處理事項", hint: "有新的審核、逾期或缺評會出現在這裡。" },
    },
    milestones: { items: MILESTONES.admin, title: "本屆里程碑" },
    modules,
  };
}
