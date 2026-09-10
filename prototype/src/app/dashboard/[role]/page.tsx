import Link from "next/link";
import { notFound } from "next/navigation";
import { IconAlertTriangle, IconBriefcase, IconCalendarDue, IconChecklist, IconClipboardText, IconHandGrab, IconPencilPlus, IconSchool, IconSignature, IconTrophy, IconUpload, IconUserCheck, IconUsers } from "@tabler/icons-react";
import { buttonVariants } from "@/components/ui/button";
import { ActionRow, Panel, Pill } from "@/components/dashboard/primitives";
import { Ring } from "@/components/dashboard/charts";
import { Bars, Donut, StackedRows, TrendArea } from "@/components/dashboard/rc-charts";
import { HomeLayout, Spot, TintCard, type HomeModel } from "@/components/dashboard/home-widgets";
import { isValidRole } from "@/lib/nav-config";
import { ADMIN_STATS, AUDIT_EVENTS, CURRENT_USERS, EVALUATION_QUEUE, GRADING_PROGRESS, GROUPS, INDUSTRY, MANAGED_ITEMS, MY_GROUP, SIGNOFF, SIGNOFF_PROGRESS, SUBMISSION_TREND, currentStage, daysUntil, type Role } from "@/lib/fixtures";

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

  return {
    role,
    name: "系辦",
    line: actions.length ? `現在是「${stage.title}」。今天有 ${actions.length} 件事需要你處理；本屆 ${GROUPS.length} 組、${totalStudents} 位學生。` : `現在是「${stage.title}」。沒有待處理事項。`,
    cta: { href: `${base}/editor/new`, label: "發布公告或收件" },
    heroIllustration: <Spot icon={<IconTrophy className="size-20" strokeWidth={1.4} />} size={168} className="tint tint-sky" />,
    newsAction: <Link href={`${base}/editor/new`} className="inline-flex items-center gap-1 text-[13px] font-semibold text-brand hover:underline"><IconPencilPlus className="size-4" />發布公告</Link>,
    stats: [
      { key: "accounts", label: "待審核帳號", icon: <IconUserCheck />, value: s.pendingAccounts, unit: "筆", tone: "brand", href: `${base}/accounts?status=pending` },
      { key: "overdue", label: "逾期組別", icon: <IconCalendarDue />, value: overdueGroups, unit: "組", tone: overdueGroups ? "danger" : "default", href: `${base}/affairs/mi-011` },
      { key: "grading", label: "評分完成", icon: <IconChecklist />, value: `${gradingSubmitted}/${gradingAssigned}`, hint: `${missingTeachers} 位老師缺評`, href: `${base}/grading` },
      { key: "sign", label: "簽核完成", icon: <IconSignature />, value: `${signComplete}/${GROUPS.length}`, unit: "組", href: `${base}/signoff` },
    ],
    modules: [
      {
        key: "actions", present: actions.length > 0,
        node: (
          <TintCard tint="peach" title="需要處理" description={`${actions.length} 件`}>
            <ul className="px-1 pb-2">{actions.map((a) => <ActionRow key={a.label} {...a} />)}</ul>
          </TintCard>
        ),
      },
      {
        key: "grouping", present: s.ungroupedStudents > 0,
        node: (
          <Panel title="本屆分組" action={{ href: `${base}/groups`, label: "總覽" }} className="h-full">
            <div className="flex items-center gap-5 px-5 pb-5">
              <Donut size={124} data={[{ name: "已分組", value: s.groupedStudents, color: "var(--brand)" }, { name: "未分組", value: s.ungroupedStudents, color: "var(--border)" }, { name: "例外組", value: s.groupExceptions, color: "var(--primary)" }]} center={<span className="text-center"><span className="tabular block text-[22px] font-extrabold leading-none">{Math.round((s.groupedStudents / totalStudents) * 100)}%</span><span className="text-[10px] text-muted-foreground">已分組</span></span>} />
              <ul className="flex flex-1 flex-col gap-2 text-sm">
                {[["已分組", s.groupedStudents, "bg-brand"], ["未分組", s.ungroupedStudents, "bg-border"], ["例外組", s.groupExceptions, "bg-primary"]].map(([l, v, c]) => (
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
            <div className="px-5 pb-5"><StackedRows rows={items.map((i) => ({ label: i.title, done: i.progress!.done, overdue: i.progress!.overdue, total: i.progress!.total }))} /></div>
          </Panel>
        ),
      },
      {
        key: "trend", present: SUBMISSION_TREND.some((d) => d.count > 0),
        node: (
          <Panel title="近 7 天正式繳交" description={`共 ${SUBMISSION_TREND.reduce((a, d) => a + d.count, 0)} 件`} className="h-full">
            <div className="px-3 pb-3"><TrendArea data={SUBMISSION_TREND.map((d) => ({ label: d.day.slice(3), value: d.count }))} /></div>
          </Panel>
        ),
      },
      {
        key: "grading", present: gradingSubmitted < gradingAssigned,
        node: (
          <Panel title="老師評分進度" description="系統驗收" action={{ href: `${base}/grading`, label: "成績" }} className="h-full">
            <div className="px-3 pb-3"><Bars data={GRADING_PROGRESS.map((t) => ({ label: t.teacher, value: t.submitted, hot: t.submitted === t.assigned }))} /></div>
          </Panel>
        ),
      },
      {
        key: "storage", present: true,
        node: (
          <TintCard tint="sky" title="儲存與備份" action={{ href: `${base}/files`, label: "檔案" }}>
            <div className="flex items-center gap-5 px-5 pt-3 pb-5">
              <Ring value={(s.storageUsedGiB / s.storageTotalGiB) * 100} size={72} stroke={8} color="var(--brand)" track="var(--card)"><span className="tabular text-sm font-extrabold">{Math.round((s.storageUsedGiB / s.storageTotalGiB) * 100)}%</span></Ring>
              <dl className="grid flex-1 gap-1.5 text-sm">
                <div className="flex justify-between"><dt className="text-muted-foreground">已用</dt><dd className="tabular font-semibold">{s.storageUsedGiB} / {s.storageTotalGiB} GiB</dd></div>
                <div className="flex justify-between"><dt className="text-muted-foreground">最近備份</dt><dd className="tabular font-semibold">{s.lastBackupAt.slice(5)}</dd></div>
                <div className="flex justify-between"><dt className="text-muted-foreground">還原演練</dt><dd className="font-semibold text-warning-on-subtle">{s.lastRestoreDrillAt}</dd></div>
              </dl>
            </div>
          </TintCard>
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
    ],
  };
}
