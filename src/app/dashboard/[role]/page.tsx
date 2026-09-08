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
  IconDatabase,
  IconHandGrab,
  IconInbox,
  IconSignature,
  IconSpeakerphone,
  IconUserCheck,
  IconUsers,
  IconUsersGroup,
  IconX,
} from "@tabler/icons-react";
import { buttonVariants } from "@/components/ui/button";
import { ActionRow, EmptyState, Greeting, Panel, Pill, ProgressBar, StatTile, StateBadge } from "@/components/dashboard/primitives";
import { BarChart, HBar, MiniBars, Ring, SegmentBar, Sparkline } from "@/components/dashboard/charts";
import { isValidRole } from "@/lib/nav-config";
import {
  ADMIN_STATS,
  AUDIT_EVENTS,
  CURRENT_USERS,
  EVALUATION_QUEUE,
  GRADING_PROGRESS,
  GROUPS,
  INDUSTRY,
  MANAGED_ITEMS,
  MY_GROUP,
  NEWS,
  SIGNOFF,
  SIGNOFF_PROGRESS,
  SUBMISSION_TREND,
  TEACHERS,
  UNGROUPED,
  daysUntil,
  formatDue,
  type Role,
} from "@/lib/fixtures";

export default async function DashboardPage({ params }: PageProps<"/dashboard/[role]">) {
  const { role } = await params;
  if (!isValidRole(role)) notFound();
  if (role === "student") return <StudentDashboard role={role} />;
  if (role === "teacher") return <TeacherDashboard role={role} />;
  return <AdminDashboard role={role} />;
}

function DueChip({ dueAt }: { dueAt: string }) {
  const d = daysUntil(dueAt);
  const tone = d < 0 ? "text-destructive" : d <= 10 ? "text-brand" : "text-muted-foreground";
  return (
    <span className={`tabular inline-flex items-center gap-1 text-xs font-semibold ${tone}`}>
      <IconClock className="size-3.5" />
      {formatDue(dueAt)}
    </span>
  );
}

/* ============================================================ 學生 */

function StudentDashboard({ role }: { role: Role }) {
  const base = `/dashboard/${role}`;
  const user = CURRENT_USERS.student;
  const todo = MANAGED_ITEMS.filter((i) => i.dueAt && i.myState && i.myState !== "submitted").sort((a, b) => daysUntil(a.dueAt!) - daysUntil(b.dueAt!));
  const submitted = MANAGED_ITEMS.filter((i) => i.myState === "submitted");
  const next = todo.find((i) => daysUntil(i.dueAt!) >= 0);
  const confirmed = MY_GROUP.members.filter((m) => m.confirmed).length;
  const approvals = SIGNOFF.studentApprovals.filter((a) => a.approved).length;
  const myPending = SIGNOFF.studentApprovals.find((a) => a.name === user.name && !a.approved);

  return (
    <div className="stagger flex flex-col gap-5">
      <Greeting
        name={user.name}
        line={next ? `下一個截止：${next.title}，${formatDue(next.dueAt!)}。` : "目前沒有即將截止的項目。"}
        cta={next ? { href: `${base}/affairs/${next.id}`, label: next.myState === "draft" ? "繼續填寫" : "開始填寫" } : { href: `${base}/affairs`, label: "查看專題事務" }}
        aside={
          next ? (
            <div className="flex items-center gap-4 rounded-xl border border-border bg-background/80 px-5 py-4">
              <Ring value={Math.max(0, Math.min(100, 100 - (daysUntil(next.dueAt!) / 30) * 100))} size={64} color="var(--brand)">
                <span className="tabular text-lg font-extrabold">{daysUntil(next.dueAt!)}</span>
              </Ring>
              <div className="text-sm">
                <p className="font-bold">天後截止</p>
                <p className="tabular text-muted-foreground">{next.dueAt}</p>
              </div>
            </div>
          ) : null
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="待完成" icon={<IconClipboardText />} value={todo.length} unit="項" tone={todo.length ? "warning" : "default"} href={`${base}/affairs`} chart={<MiniBars values={[1, 2, 2, 3, 3, 4, todo.length]} fill="var(--warning)" />} />
        <StatTile label="已繳交" icon={<IconCheck />} value={submitted.length} unit="項" tone="success" href={`${base}/affairs`} chart={<Sparkline values={[0, 0, 1, 1, 1, 1, submitted.length]} stroke="var(--success)" />} />
        <StatTile label="組員確認" icon={<IconUsersGroup />} value={`${confirmed}/5`} hint={confirmed < 5 ? `還差 ${5 - confirmed} 人` : "全員到齊"} tone={confirmed < 5 ? "warning" : "success"} href={`${base}/groups`} chart={<Ring value={(confirmed / 5) * 100} size={44} stroke={5} color={confirmed < 5 ? "var(--warning)" : "var(--success)"} />} />
        <StatTile label="同意書" icon={<IconSignature />} value={`${approvals}/5`} hint={myPending ? "等你同意" : "等其他組員"} tone="brand" href={`${base}/signoff`} chart={<Ring value={(approvals / 5) * 100} size={44} stroke={5} color="var(--brand)" />} />
      </div>

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Panel title="待完成事項" icon={<IconClipboardText />} description="依截止日排序" action={{ href: `${base}/affairs`, label: "全部" }}>
          {todo.length === 0 ? (
            <EmptyState icon={<IconInbox />} title="沒有待完成事項" />
          ) : (
            <ul className="divide-y divide-border">
              {todo.map((item) => (
                <li key={item.id} className="flex items-center gap-4 px-5 py-3.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <StateBadge state={item.myState!} />
                      <p className="truncate font-semibold">{item.title}</p>
                    </div>
                    <div className="mt-1.5 flex items-center gap-3 text-xs text-muted-foreground">
                      <DueChip dueAt={item.dueAt!} />
                      <span className="tabular">截止 {item.dueAt}</span>
                    </div>
                  </div>
                  <Link href={`${base}/affairs/${item.id}`} className={buttonVariants({ size: "lg", variant: item.myState === "overdue" ? "outline" : "default", className: "press shrink-0 rounded-lg" })}>
                    {item.myState === "draft" ? "繼續填寫" : item.myState === "overdue" ? "查看" : item.myState === "resubmit" ? "重送" : "開始"}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <div className="flex flex-col gap-5">
          <Panel title="我的組別" icon={<IconUsersGroup />} description={`${MY_GROUP.no}・${MY_GROUP.type === "INDUSTRY" ? "產學合作" : "一般專題"}`} action={{ href: `${base}/groups`, label: "詳情" }}>
            <div className="px-5 py-4">
              <p className="font-semibold leading-snug">{MY_GROUP.title}</p>
              <p className="mt-1 text-xs text-muted-foreground">指導老師 {TEACHERS.find((t) => t.id === MY_GROUP.advisorId)?.name ?? "尚未指派"}</p>
              <ul className="mt-4 flex flex-wrap gap-2">
                {MY_GROUP.members.map((m) => (
                  <li key={m.id} className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${m.confirmed ? "border-success/30 bg-success-subtle text-success-on-subtle" : "border-border bg-muted text-muted-foreground"}`}>
                    {m.confirmed ? <IconCheck className="size-3.5" /> : <IconClock className="size-3.5" />}
                    {m.name}
                    {m.isLeader ? <span className="opacity-70">組長</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          </Panel>

          <Panel title="待我同意" icon={<IconSignature />} action={{ href: `${base}/signoff`, label: "紀錄" }}>
            {myPending ? (
              <div className="px-5 py-4">
                <p className="font-semibold leading-snug">{SIGNOFF.title}</p>
                <div className="mt-3 flex items-center gap-3">
                  <SegmentBar segments={[{ value: approvals, color: "var(--success)", label: "已同意" }, { value: 5 - approvals, color: "var(--muted)", label: "未同意" }]} className="flex-1" />
                  <span className="tabular text-xs font-semibold text-muted-foreground">{approvals}/5</span>
                </div>
                <div className="mt-4 flex gap-2">
                  <Link href={`${base}/signoff`} className={buttonVariants({ size: "lg", className: "press rounded-lg" })}><IconCheck /> 閱讀並同意</Link>
                  <Link href={`${base}/signoff`} className={buttonVariants({ size: "lg", variant: "outline", className: "press rounded-lg" })}><IconX /> 不同意</Link>
                </div>
              </div>
            ) : (
              <EmptyState title="沒有待你同意的項目" />
            )}
          </Panel>
        </div>
      </div>

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Panel title="已繳交" icon={<IconCheck />} description="截止前仍可重送，每次送出保留版本" action={{ href: `${base}/affairs`, label: "全部" }}>
          {submitted.length === 0 ? (
            <EmptyState title="尚無已繳交項目" />
          ) : (
            <ul className="divide-y divide-border">
              {submitted.map((item) => (
                <li key={item.id} className="flex items-center gap-3 px-5 py-3.5">
                  <StateBadge state="submitted" />
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold">{item.title}</span>
                  <span className="tabular text-xs text-muted-foreground">v{item.schemaVersion}</span>
                  <Link href={`${base}/affairs/${item.id}`} className="link-ink text-[13px] font-semibold text-primary">版本</Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="近期公告" icon={<IconSpeakerphone />} action={{ href: "/news", label: "全部" }}>
          <ul className="divide-y divide-border">
            {NEWS.slice(0, 4).map((n) => (
              <li key={n.id}>
                <Link href={`/news/${n.id}`} className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-accent/60">
                  <time className="tabular shrink-0 text-xs text-muted-foreground">{n.date.slice(5)}</time>
                  <span className="truncate text-sm font-medium">{n.title}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </div>
  );
}

/* ============================================================ 老師 */

function TeacherDashboard({ role }: { role: Role }) {
  const base = `/dashboard/${role}`;
  const me = CURRENT_USERS.teacher;
  const myGroups = GROUPS.filter((g) => g.advisorId === me.id);
  const claimable = GROUPS.filter((g) => g.type === "INDUSTRY" && g.advisorId === null);
  const pending = EVALUATION_QUEUE.filter((e) => e.state === "pending");
  const staged = EVALUATION_QUEUE.filter((e) => e.state === "staged");
  const done = EVALUATION_QUEUE.filter((e) => e.state === "submitted");
  const teacherSign = SIGNOFF_PROGRESS.filter((s) => s.students === s.total && !s.teacher && GROUPS.find((g) => g.id === s.groupId)?.advisorId === me.id);

  return (
    <div className="stagger flex flex-col gap-5">
      <Greeting
        name={`${me.name} 老師`}
        line={pending.length ? `系統驗收還有 ${pending.length} 組待評分，送出後鎖定。` : "目前沒有待評分的組別。"}
        cta={{ href: `${base}/grading`, label: "開始評分" }}
        aside={
          <div className="flex items-center gap-4 rounded-xl border border-border bg-background/80 px-5 py-4">
            <Ring value={(done.length / EVALUATION_QUEUE.length) * 100} size={64} color="var(--success)">
              <span className="tabular text-sm font-extrabold">{done.length}/{EVALUATION_QUEUE.length}</span>
            </Ring>
            <div className="text-sm">
              <p className="font-bold">已送出評分</p>
              <p className="text-muted-foreground">系統驗收階段</p>
            </div>
          </div>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="待評分" icon={<IconChecklist />} value={pending.length} unit="組" tone={pending.length ? "warning" : "default"} href={`${base}/grading`} chart={<MiniBars values={[4, 4, 3, 3, 2, 2, pending.length]} fill="var(--warning)" />} />
        <StatTile label="已暫存" icon={<IconClock />} value={staged.length} unit="組" hint="尚未正式送出" href={`${base}/grading`} chart={<Ring value={(staged.length / EVALUATION_QUEUE.length) * 100} size={44} stroke={5} color="var(--info)" />} />
        <StatTile label="指導組別" icon={<IconUsersGroup />} value={myGroups.length} unit="組" hint={`${myGroups.filter((g) => g.type === "INDUSTRY").length} 組產學`} href={`${base}/groups`} chart={<Ring value={(myGroups.length / GROUPS.length) * 100} size={44} stroke={5} />} />
        <StatTile label="待我同意" icon={<IconSignature />} value={teacherSign.length} unit="件" tone={teacherSign.length ? "brand" : "default"} href={`${base}/signoff`} chart={<MiniBars values={[0, 1, 1, 0, 1, 1, teacherSign.length]} fill="var(--brand)" />} />
      </div>

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Panel title="評分佇列" icon={<IconChecklist />} description="只顯示你被指派的組別" action={{ href: `${base}/grading`, label: "工作台" }}>
          <ul className="divide-y divide-border">
            {EVALUATION_QUEUE.map((e) => (
              <li key={e.groupId} className="flex items-center gap-4 px-5 py-3.5">
                <span className="tabular w-16 shrink-0 text-xs font-semibold text-muted-foreground">{e.groupNo}</span>
                <span className="min-w-0 flex-1 truncate text-sm font-semibold">{e.title}</span>
                {e.state === "pending" ? <Pill tone="warning">未開始</Pill> : e.state === "staged" ? <Pill tone="info">已暫存</Pill> : <Pill tone="success">已送出</Pill>}
                <Link href={`${base}/grading/${e.groupId}`} className={buttonVariants({ size: "lg", variant: e.state === "submitted" ? "outline" : "default", className: "press shrink-0 rounded-lg" })}>
                  {e.state === "submitted" ? "檢視" : e.state === "staged" ? "繼續" : "評分"}
                </Link>
              </li>
            ))}
          </ul>
        </Panel>

        <div className="flex flex-col gap-5">
          <Panel title="可認領產學組" icon={<IconHandGrab />} description="先按先得" action={{ href: `${base}/groups`, label: "全部分組" }}>
            {claimable.length === 0 ? (
              <EmptyState title="沒有可認領的產學組" />
            ) : (
              <ul className="divide-y divide-border">
                {claimable.map((g) => (
                  <li key={g.id} className="flex items-center gap-3 px-5 py-3">
                    <span className="tabular shrink-0 text-xs font-semibold text-muted-foreground">{g.no}</span>
                    <span className="min-w-0 flex-1 truncate text-sm font-semibold">{g.title.replace(/（產學：.*）/, "")}</span>
                    <Link href={`${base}/groups?claim=${g.id}`} className={buttonVariants({ variant: "outline", size: "sm", className: "press shrink-0 rounded-lg" })}>認領</Link>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel title="待我同意" icon={<IconSignature />} action={{ href: `${base}/signoff`, label: "進度" }}>
            {teacherSign.length === 0 ? (
              <EmptyState title="沒有等待你同意的組別" hint="五位學生全數同意後才會輪到老師。" />
            ) : (
              <ul className="divide-y divide-border">
                {teacherSign.map((s) => (
                  <li key={s.groupId} className="flex items-center gap-3 px-5 py-3">
                    <span className="tabular shrink-0 text-xs font-semibold text-muted-foreground">{s.groupNo}</span>
                    <span className="min-w-0 flex-1 truncate text-sm font-semibold">{SIGNOFF.title}</span>
                    <Link href={`${base}/signoff`} className={buttonVariants({ size: "sm", className: "press shrink-0 rounded-lg" })}>同意</Link>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>

      <Panel title="指導組別繳交狀態" icon={<IconUsersGroup />} action={{ href: `${base}/affairs`, label: "各組狀態" }}>
        <ul className="divide-y divide-border">
          {myGroups.map((g, i) => (
            <li key={g.id} className="grid gap-2 px-5 py-3.5 sm:grid-cols-[minmax(0,1fr)_16rem] sm:items-center sm:gap-6">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="tabular text-xs font-semibold text-muted-foreground">{g.no}</span>
                  <Pill tone={g.type === "INDUSTRY" ? "brand" : "default"}>{g.type === "INDUSTRY" ? "產學" : "一般"}</Pill>
                  <p className="truncate text-sm font-semibold">{g.title.replace(/（產學：.*）/, "")}</p>
                </div>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">{g.members.map((m) => m.name).join("、")}</p>
              </div>
              <ProgressBar done={[3, 4][i % 2]} total={5} overdue={g.id === "g-07" ? 1 : 0} />
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}

/* ============================================================ 管理員 */

function AdminDashboard({ role }: { role: Role }) {
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

  return (
    <div className="stagger flex flex-col gap-5">
      <Greeting
        name="系辦"
        line={`${s.pendingAccounts} 筆帳號待審核、${overdueGroups} 組逾期、${missingTeachers} 位老師缺評。`}
        cta={{ href: `${base}/accounts?status=pending`, label: "先審核帳號" }}
        aside={
          <div className="flex items-center gap-4 rounded-xl border border-border bg-background/80 px-5 py-4">
            <Ring value={(s.groupedStudents / totalStudents) * 100} size={64}>
              <span className="tabular text-sm font-extrabold">{Math.round((s.groupedStudents / totalStudents) * 100)}%</span>
            </Ring>
            <div className="text-sm">
              <p className="font-bold">已分組</p>
              <p className="tabular text-muted-foreground">{s.groupedStudents}/{totalStudents} 人</p>
            </div>
          </div>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="待審核帳號" icon={<IconUserCheck />} value={s.pendingAccounts} unit="筆" tone="warning" href={`${base}/accounts?status=pending`} chart={<MiniBars values={[1, 0, 2, 1, 3, 2, s.pendingAccounts]} fill="var(--warning)" />} />
        <StatTile label="逾期組別" icon={<IconAlertTriangle />} value={overdueGroups} unit="組" tone={overdueGroups ? "danger" : "default"} href={`${base}/affairs/mi-011`} chart={<MiniBars values={[0, 0, 1, 1, 2, 3, overdueGroups]} fill="var(--destructive)" />} />
        <StatTile label="評分完成" icon={<IconChecklist />} value={`${gradingSubmitted}/${gradingAssigned}`} hint={`${missingTeachers} 位老師缺評`} href={`${base}/grading`} chart={<Ring value={(gradingSubmitted / gradingAssigned) * 100} size={44} stroke={5} color="var(--info)" />} />
        <StatTile label="簽核完成" icon={<IconSignature />} value={`${signComplete}/${GROUPS.length}`} unit="組" href={`${base}/signoff`} chart={<Ring value={(signComplete / GROUPS.length) * 100} size={44} stroke={5} color="var(--brand)" />} />
      </div>

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Panel title="需要處理" icon={<IconInbox />} description="有明確下一步的事項">
          <ul className="divide-y divide-border">
            <ActionRow tone="warning" icon={<IconUserCheck />} label="待審核帳號" detail="名單未命中或以 Email 註冊" count={s.pendingAccounts} href={`${base}/accounts?status=pending`} cta="審核" />
            <ActionRow tone="danger" icon={<IconAlertTriangle />} label="逾期未繳組別" detail="系統驗收簡報與說明文件" count={overdueGroups} href={`${base}/affairs/mi-011`} cta="重新開放" />
            <ActionRow tone="brand" icon={<IconBriefcase />} label="產學案未指派組別" detail="老師可認領，或由系辦指派" count={unassignedIndustry.length} href={`${base}/industry?status=open`} cta="查看" />
            <ActionRow tone="info" icon={<IconChecklist />} label="缺評老師" detail="系統驗收階段尚未送出" count={missingTeachers} href={`${base}/grading`} cta="催繳" />
            <ActionRow tone="default" icon={<IconUsers />} label="例外組別" detail="非五人組，已記錄理由" count={s.groupExceptions} href={`${base}/groups?status=exception`} cta="查看" />
          </ul>
        </Panel>

        <Panel title="近 7 天正式繳交" icon={<IconCalendarDue />} description={`共 ${SUBMISSION_TREND.reduce((a, d) => a + d.count, 0)} 件`}>
          <div className="px-5 pt-5 pb-3">
            <BarChart data={SUBMISSION_TREND.map((d) => ({ label: d.day.slice(3), value: d.count }))} highlight={SUBMISSION_TREND.length - 1} />
          </div>
        </Panel>
      </div>

      <div className="grid items-start gap-5 lg:grid-cols-2 xl:grid-cols-3">
        <Panel title="收件完成率" icon={<IconClipboardText />} action={{ href: `${base}/affairs`, label: "工作台" }}>
          <ul className="flex flex-col gap-4 px-5 py-4">
            {items.map((i) => (
              <li key={i.id}>
                <div className="mb-1.5 flex items-center justify-between gap-3">
                  <Link href={`${base}/affairs/${i.id}`} className="link-ink truncate text-sm font-semibold">{i.title}</Link>
                  <span className="tabular shrink-0 text-xs text-muted-foreground">{i.progress!.done}/{i.progress!.total}</span>
                </div>
                <SegmentBar segments={[{ value: i.progress!.done, color: "var(--success)", label: "已繳" }, { value: i.progress!.overdue, color: "var(--destructive)", label: "逾期" }, { value: i.progress!.total - i.progress!.done - i.progress!.overdue, color: "var(--muted)", label: "未繳" }]} />
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="老師評分進度" icon={<IconChecklist />} description="系統驗收階段" action={{ href: `${base}/grading`, label: "成績管理" }}>
          <ul className="flex flex-col gap-3.5 px-5 py-4">
            {GRADING_PROGRESS.map((t) => (
              <li key={t.teacher}>
                <HBar label={t.teacher} value={t.submitted} total={t.assigned} color={t.submitted === t.assigned ? "var(--success)" : t.submitted === 0 ? "var(--destructive)" : "var(--info)"} />
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="儲存與備份" icon={<IconDatabase />} action={{ href: `${base}/files`, label: "檔案管理" }}>
          <div className="flex items-center gap-5 px-5 py-4">
            <Ring value={(s.storageUsedGiB / s.storageTotalGiB) * 100} size={84} stroke={9}>
              <span className="tabular text-base font-extrabold">{Math.round((s.storageUsedGiB / s.storageTotalGiB) * 100)}%</span>
            </Ring>
            <dl className="grid flex-1 grid-cols-1 gap-2 text-sm">
              <div className="flex justify-between"><dt className="text-muted-foreground">已用</dt><dd className="tabular font-semibold">{s.storageUsedGiB} / {s.storageTotalGiB} GiB</dd></div>
              <div className="flex justify-between"><dt className="text-muted-foreground">最近備份</dt><dd className="tabular font-semibold">{s.lastBackupAt.slice(5)}</dd></div>
              <div className="flex justify-between"><dt className="text-muted-foreground">還原演練</dt><dd className="font-semibold text-warning-on-subtle">{s.lastRestoreDrillAt}</dd></div>
            </dl>
          </div>
        </Panel>
      </div>

      <Panel title="最近高權限操作" icon={<IconUsers />} action={{ href: `${base}/audit`, label: "操作紀錄" }}>
        <ul className="divide-y divide-border">
          {AUDIT_EVENTS.slice(0, 5).map((e) => (
            <li key={e.id} className="flex items-center gap-3 px-5 py-3 text-sm">
              <time className="tabular w-24 shrink-0 text-xs text-muted-foreground">{e.at.slice(5)}</time>
              <span className="w-20 shrink-0 truncate font-semibold">{e.actor}</span>
              <Pill tone={e.role === "admin" ? "brand" : e.role === "system" ? "default" : "info"}>{e.action}</Pill>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{e.target}</span>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
