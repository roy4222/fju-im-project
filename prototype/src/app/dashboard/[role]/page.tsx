import Link from "next/link";
import { notFound } from "next/navigation";
import { IconCalendarDue, IconChecklist, IconClipboardText, IconHandGrab, IconPencilPlus, IconSchool, IconSignature, IconTrophy, IconUpload, IconUserCheck } from "@tabler/icons-react";
import { buttonVariants } from "@/components/ui/button";
import { Panel, Pill } from "@/components/dashboard/primitives";
import { Donut, StackedRows } from "@/components/dashboard/rc-charts";
import { HomeLayout, Spot, TintCard, type HomeModel } from "@/components/dashboard/home-widgets";
import { NewItemDialog } from "@/components/dashboard/new-item-dialog";
import { isValidRole } from "@/lib/nav-config";
import { ADMIN_STATS, CURRENT_USERS, EVALUATION_QUEUE, GRADING_PROGRESS, GROUPS, INDUSTRY, MANAGED_ITEMS, MY_GROUP, NEWS, SIGNOFF, SIGNOFF_PROGRESS, currentStage, daysUntil, type Role } from "@/lib/fixtures";

/**
 * 後台首頁（2026-09-09 第三輪）：
 * 歡迎回來色塊＋專題行事曆 → 公告＋接下來 → 專題時間軸 → 有才出現的色塊卡 → 統計一條。
 * 插圖現在是佔位（Spot），等 Roy 用 GPT 生 3D 圖再換。
 */
export default async function DashboardPage({ params }: PageProps<"/dashboard/[role]">) {
  const { role } = await params;
  if (!isValidRole(role)) notFound();
  const model = role === "student" ? studentHome(role) : role === "teacher" ? teacherHome(role) : adminHome(role);
  return <HomeLayout model={model} />;
}

/* ============================================================ 學生 */
function studentHome(role: Role): HomeModel {
  const base = `/dashboard/${role}`;
  const stage = currentStage();
  const open = MANAGED_ITEMS.filter((i) => i.myState && i.myState !== "submitted" && i.myState !== "locked").sort((a, b) => daysUntil(a.dueAt ?? "2099") - daysUntil(b.dueAt ?? "2099"));
  const overdue = open.filter((i) => i.myState === "overdue");
  const submitted = MANAGED_ITEMS.filter((i) => i.myState === "submitted");
  const confirmed = MY_GROUP.members.filter((m) => m.confirmed).length;
  const name = CURRENT_USERS.student.name;
  const approvals = SIGNOFF.studentApprovals.filter((a) => a.approved).length;
  const myPending = SIGNOFF.studentApprovals.some((a) => a.name === name && !a.approved);
  return {
    role,
    layout: "student",
    name,
    line: open.length ? `現在是「${stage.title}」。作業區還有 ${open.length} 件沒送出${overdue.length ? `，其中 ${overdue.length} 件已逾期` : ""}。` : `現在是「${stage.title}」。作業區沒有待繳的東西，做得好。`,
    cta: open.length ? { href: `${base}/affairs?tab=open`, label: "去作業區" } : undefined,
    heroIllustration: <Spot icon={<IconSchool className="size-16" strokeWidth={1.4} />} />,
    /* Roy 2026-09-10：作業區／我的組別／同意書不再各占一張卡，縮成歡迎色塊底部三格 */
    chips: [
      { label: "作業待繳", value: `${open.length} 件`, href: `${base}/affairs?tab=open`, hot: open.length > 0 },
      { label: "組員確認", value: `${confirmed}/5`, href: `${base}/groups` },
      { label: "同意書", value: myPending ? "等你同意" : `${approvals}/5`, href: `${base}/signoff` },
    ],
    stats: [
      { key: "open", label: "待繳", icon: <IconClipboardText />, value: open.length, unit: "件", tone: open.length ? "brand" : "default", href: `${base}/affairs?tab=open` },
      { key: "done", label: "已繳交", icon: <IconUpload />, value: submitted.length, unit: "件", href: `${base}/affairs?tab=done` },
    ],
    modules: [],
  };
}

function teacherHome(role: Role): HomeModel {
  const base = `/dashboard/${role}`;
  const me = CURRENT_USERS.teacher;
  const myGroups = GROUPS.filter((g) => g.advisorId === me.id);
  const claimable = GROUPS.filter((g) => g.type === "INDUSTRY" && g.advisorId === null);
  const pending = EVALUATION_QUEUE.filter((e) => e.state === "pending");
  const staged = EVALUATION_QUEUE.filter((e) => e.state === "staged");
  const submittedQ = EVALUATION_QUEUE.filter((e) => e.state === "submitted");
  const teacherSign = SIGNOFF_PROGRESS.filter((s) => s.students === s.total && !s.teacher && myGroups.some((g) => g.id === s.groupId));
  const myCases = INDUSTRY.filter((i) => i.advisorName === me.name);
  const stage = currentStage();
  const gradingPct = Math.round((submittedQ.length / EVALUATION_QUEUE.length) * 100);

  return {
    role,
    layout: "teacher",
    name: `${me.name} 老師`,
    line: pending.length ? `現在是「${stage.title}」。系統驗收評分送出 ${submittedQ.length}/${EVALUATION_QUEUE.length} 組，還有 ${pending.length} 組沒開始。` : `現在是「${stage.title}」。評分都送出了。`,
    cta: pending.length ? { href: `${base}/grading`, label: "去評分" } : undefined,
    heroIllustration: <Spot icon={<IconChecklist className="size-20" strokeWidth={1.4} />} size={168} className="tint tint-sky" />,
    chips: [
      { label: "待評分", value: `${pending.length} 組`, href: `${base}/grading`, hot: pending.length > 0 },
      { label: "待我同意", value: `${teacherSign.length} 件`, href: `${base}/signoff`, hot: teacherSign.length > 0 },
      { label: "指導組別", value: `${myGroups.length} 組`, href: `${base}/groups` },
    ],
    /* 右上：評分進度（Minuto 的「今日目標」位置） */
    aside: (
      <Panel title="評分進度" description="系統驗收・占總成績 60%" className="h-full">
        <div className="flex items-center gap-5 px-5 pt-1 pb-4">
          <Donut size={116} thickness={14} data={[{ name: "已送出", value: submittedQ.length, color: "var(--success)" }, { name: "已暫存", value: staged.length, color: "var(--brand)" }, { name: "未開始", value: pending.length, color: "var(--border)" }]} center={<span className="text-center"><span className="tabular block text-[22px] font-extrabold leading-none">{gradingPct}%</span><span className="text-[10px] text-muted-foreground">已送出</span></span>} />
          <ul className="flex flex-1 flex-col gap-2 text-sm">
            <li className="flex items-center justify-between"><span className="inline-flex items-center gap-2"><span className="size-2 rounded-full bg-success" />已送出</span><b className="tabular">{submittedQ.length}</b></li>
            <li className="flex items-center justify-between"><span className="inline-flex items-center gap-2"><span className="size-2 rounded-full bg-brand" />已暫存</span><b className="tabular">{staged.length}</b></li>
            <li className="flex items-center justify-between"><span className="inline-flex items-center gap-2"><span className="size-2 rounded-full bg-border" />未開始</span><b className="tabular">{pending.length}</b></li>
          </ul>
        </div>
        <div className="border-t border-border/70 px-5 py-3 text-xs text-muted-foreground">送出後鎖定；要改請系辦退回。</div>
      </Panel>
    ),
    stats: [],
    modules: [
      {
        key: "grading", present: EVALUATION_QUEUE.length > 0, span: 2,
        node: (
          <Panel title="評分工作台" description="系統驗收" action={{ href: `${base}/grading`, label: "開啟" }} className="h-full">
            <ul className="flex flex-col gap-1 px-3 pb-3">
              {EVALUATION_QUEUE.map((e) => (
                <li key={e.groupId}>
                  <Link href={`${base}/grading/${e.groupId}`} className="dash-card-hover flex items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-accent/40">
                    <span className="tabular w-14 shrink-0 text-xs font-semibold text-muted-foreground">{e.groupNo}</span>
                    <span className="min-w-0 flex-1 truncate text-sm font-semibold">{e.title}</span>
                    {e.state === "pending" ? <Pill tone="brand">未開始</Pill> : e.state === "staged" ? <Pill tone="default">已暫存</Pill> : <Pill tone="success">已送出</Pill>}
                    <span className={buttonVariants({ size: "sm", variant: e.state === "submitted" ? "outline" : "default", className: "press rounded-lg" })}>{e.state === "pending" ? "開始" : e.state === "staged" ? "繼續" : "查看"}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>
        ),
      },
      {
        key: "claim", present: claimable.length > 0,
        node: (
          <TintCard tint="mint" title="可認領產學組" description="先按先得" action={{ href: `${base}/groups`, label: "全部" }} illustration={<Spot icon={<IconHandGrab className="size-9" strokeWidth={1.5} />} size={72} />}>
            <ul className="px-3 pt-2 pb-3">
              {claimable.map((g) => (
                <li key={g.id} className="flex items-center gap-3 rounded-xl px-2 py-2"><span className="tabular shrink-0 text-xs font-semibold text-muted-foreground">{g.no}</span><span className="min-w-0 flex-1 truncate text-sm font-semibold">{g.title.replace(/（產學：.*）/, "")}</span><Link href={`${base}/groups`} className={buttonVariants({ size: "sm", variant: "outline", className: "press rounded-lg bg-card" })}>認領</Link></li>
              ))}
            </ul>
          </TintCard>
        ),
      },
      {
        key: "sign", present: teacherSign.length > 0,
        node: (
          <TintCard tint="lilac" title="待我同意" description="學生已全數同意" action={{ href: `${base}/signoff`, label: "進度" }} illustration={<Spot icon={<IconSignature className="size-9" strokeWidth={1.5} />} size={72} />}>
            <ul className="px-3 pt-2 pb-3">
              {teacherSign.map((s) => (
                <li key={s.groupId} className="flex items-center gap-3 rounded-xl px-2 py-2"><span className="tabular shrink-0 text-xs font-semibold text-muted-foreground">{s.groupNo}</span><span className="min-w-0 flex-1 truncate text-sm font-semibold">{SIGNOFF.title}</span><Link href={`${base}/signoff`} className="btn-fju h-8 rounded-lg px-3 text-xs">同意</Link></li>
              ))}
            </ul>
          </TintCard>
        ),
      },
      {
        key: "groups", present: myGroups.length > 0,
        node: (
          <Panel title="指導組別" description={`${myGroups.length} 組`} action={{ href: `${base}/groups`, label: "總覽" }} className="h-full">
            <ul className="flex flex-col px-5 pb-4">
              {myGroups.map((g) => (
                <li key={g.id} className="flex items-center gap-3 border-t border-border/70 py-2.5 text-sm first:border-t-0">
                  <span className="tabular w-14 shrink-0 text-xs font-semibold text-muted-foreground">{g.no}</span>
                  <span className="min-w-0 flex-1 truncate font-semibold">{g.title.replace(/（產學：.*）/, "")}</span>
                  {g.type === "INDUSTRY" ? <Pill tone="info">產學</Pill> : null}
                </li>
              ))}
            </ul>
          </Panel>
        ),
      },
      {
        key: "industry", present: myCases.length > 0,
        node: (
          <Panel title="我的合作案" description={`${myCases.length} 件`} action={{ href: `${base}/industry`, label: "管理" }} className="h-full">
            <ul className="px-5 pb-4">
              {myCases.map((c) => (
                <li key={c.id} className="flex items-center gap-3 border-t border-border/70 py-2.5 first:border-t-0"><span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold">{c.company}</span><span className="block truncate text-xs text-muted-foreground">{c.title}</span></span>{c.status === "claimed" ? <Pill tone="default">已有 {c.linkedGroups} 組</Pill> : <Pill tone="brand">尚未指派</Pill>}</li>
              ))}
            </ul>
          </Panel>
        ),
      },
    ],
  };
}

function adminHome(role: Role): HomeModel {
  const base = `/dashboard/${role}`;
  const s = ADMIN_STATS;
  const stage = currentStage();
  const items = MANAGED_ITEMS.filter((i) => i.progress);
  const overdueGroups = items.reduce((a, i) => a + (i.progress?.overdue ?? 0), 0);
  const unassignedIndustry = INDUSTRY.filter((i) => i.status !== "claimed");
  const totalStudents = GROUPS.reduce((a, g) => a + g.members.length, 0);
  const gradingAssigned = GRADING_PROGRESS.reduce((a, t) => a + t.assigned, 0);
  const gradingSubmitted = GRADING_PROGRESS.reduce((a, t) => a + t.submitted, 0);
  const missingTeachers = GRADING_PROGRESS.filter((t) => t.submitted < t.assigned).length;
  const signComplete = SIGNOFF_PROGRESS.filter((p) => p.state === "complete").length;
  const signWaitTeacher = SIGNOFF_PROGRESS.filter((p) => p.students === p.total && !p.teacher).length;
  const todo = s.pendingAccounts + overdueGroups + missingTeachers + unassignedIndustry.length;
  const industryGroups = GROUPS.filter((g) => g.type === "INDUSTRY").length;

  return {
    role,
    layout: "admin",
    name: CURRENT_USERS.admin.name,
    line: `現在是「${stage.title}」。今天有 ${todo} 件事要處理；本屆 ${GROUPS.length} 組、${totalStudents} 位學生。`,
    cta: { href: `${base}/accounts?status=pending`, label: "處理待辦" },
    heroIllustration: <Spot icon={<IconTrophy className="size-20" strokeWidth={1.4} />} size={168} className="tint tint-sand" />,
    /* Roy 2026-09-10 選畫布 A（NextAdmin 分析型）：四磚 → 大圖＋甜甜圈 → 表格＋我發的公告 */
    stats: [
      { key: "accounts", label: "待審核帳號", icon: <IconUserCheck />, value: s.pendingAccounts, unit: "筆", hint: "本週新增 3 筆", tone: "brand", href: `${base}/accounts?status=pending` },
      { key: "overdue", label: "逾期組別", icon: <IconCalendarDue />, value: overdueGroups, unit: "組", hint: "系統驗收簡報", tone: overdueGroups ? "danger" : "default", href: `${base}/affairs/mi-011` },
      { key: "grading", label: "評分完成率", icon: <IconChecklist />, value: `${Math.round((gradingSubmitted / gradingAssigned) * 100)}%`, hint: `${gradingSubmitted}／${gradingAssigned} 份・${missingTeachers} 位缺評`, href: `${base}/grading` },
      { key: "sign", label: "簽核完成", icon: <IconSignature />, value: `${signComplete}／${GROUPS.length}`, unit: "組", hint: `${signWaitTeacher} 組等老師`, href: `${base}/signoff` },
    ],
    modules: [
      {
        key: "intake", present: true, span: 2,
        node: (
          <Panel title="各收件項目完成率" description="點一條看未繳組別並催繳" action={{ href: `${base}/affairs`, label: "工作台" }} className="h-full">
            <div className="px-5 pb-5"><StackedRows rows={items.map((i) => ({ label: i.title, done: i.progress!.done, overdue: i.progress!.overdue, total: i.progress!.total, href: `${base}/affairs/${i.id}` }))} /></div>
          </Panel>
        ),
      },
      {
        key: "groups", present: true,
        node: (
          <Panel title="本屆分組" description={`${GROUPS.length} 組・${totalStudents} 人・${s.ungroupedStudents} 位未分組`} action={{ href: `${base}/groups`, label: "總覽" }} className="h-full">
            <div className="flex items-center gap-5 px-5 pt-1 pb-5">
              <Donut size={132} thickness={18} data={[{ name: "一般專題", value: GROUPS.length - industryGroups, color: "var(--primary)" }, { name: "產學合作", value: industryGroups, color: "var(--brand)" }]} center={<span className="text-center"><span className="tabular block text-[24px] font-extrabold leading-none">{GROUPS.length}</span><span className="text-[10px] text-muted-foreground">組</span></span>} />
              <ul className="flex flex-1 flex-col gap-2 text-sm">
                <li className="flex items-center justify-between"><span className="inline-flex items-center gap-2"><span className="size-2.5 rounded-sm bg-primary" />一般專題</span><b className="tabular">{GROUPS.length - industryGroups}</b></li>
                <li className="flex items-center justify-between"><span className="inline-flex items-center gap-2"><span className="size-2.5 rounded-sm bg-brand" />產學合作</span><b className="tabular">{industryGroups}</b></li>
                <li className="flex items-center justify-between text-muted-foreground"><span>產學未指派</span><b className="tabular">{unassignedIndustry.length}</b></li>
                <li className="flex items-center justify-between text-muted-foreground"><span>例外組別</span><b className="tabular">{s.groupExceptions}</b></li>
              </ul>
            </div>
          </Panel>
        ),
      },
      {
        key: "teachers", present: true, span: 2,
        node: (
          <Panel title="老師評分進度" description="系統驗收" action={{ href: `${base}/grading`, label: "成績" }} className="h-full">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] text-muted-foreground"><th className="px-5 py-2 font-semibold">老師</th><th className="px-3 py-2 font-semibold">進度</th><th className="px-3 py-2 font-semibold">送出</th><th className="px-5 py-2"></th></tr></thead>
              <tbody>
                {GRADING_PROGRESS.map((t) => (
                  <tr key={t.teacher} className="border-t border-border/70">
                    <td className="px-5 py-2.5 font-semibold">{t.teacher}</td>
                    <td className="px-3 py-2.5"><div className="h-2.5 w-32 overflow-hidden rounded-full bg-muted"><span className={`block h-full rounded-full ${t.submitted === t.assigned ? "bg-success" : "bg-primary"}`} style={{ width: `${(t.submitted / t.assigned) * 100}%` }} /></div></td>
                    <td className="tabular px-3 py-2.5">{t.submitted}／{t.assigned}</td>
                    <td className="px-5 py-2.5 text-right">{t.submitted === t.assigned ? <Pill tone="success">完成</Pill> : <button type="button" className={buttonVariants({ size: "sm", variant: "outline", className: "press rounded-lg" })}>催繳</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        ),
      },
      {
        key: "news", present: true,
        node: (
          <Panel title="我發的公告" description={`${NEWS.length} 則`} action={<NewItemDialog base={base} trigger={<span className="inline-flex cursor-pointer items-center gap-1 text-[13px] font-semibold text-brand hover:underline"><IconPencilPlus className="size-4" />發布公告</span>} />} className="h-full">
            <ul className="px-2 pb-2">
              {NEWS.slice(0, 4).map((n) => (
                <li key={n.id}>
                  <Link href={`/news/${n.id}`} className="flex items-center gap-3 rounded-xl px-3 py-2 transition-colors hover:bg-accent/60">
                    <span className="tabular w-11 shrink-0 text-[11px] font-semibold text-muted-foreground">{n.date.slice(5).replace("-", "/")}</span>
                    <span className="min-w-0 flex-1 truncate text-sm font-semibold">{n.title}</span>
                    <span className="text-[11px] text-muted-foreground">{n.category}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>
        ),
      },
    ],
  };
}
