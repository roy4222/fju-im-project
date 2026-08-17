import Link from "next/link";
import { notFound } from "next/navigation";
import {
  IconAlertTriangle,
  IconArrowRight,
  IconCheck,
  IconChecklist,
  IconClock,
  IconDatabase,
  IconHandGrab,
  IconInbox,
  IconPaperclip,
  IconSignature,
  IconUserCheck,
  IconX,
} from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  EmptyState,
  Panel,
  ProgressBar,
  StateBadge,
  StatTile,
} from "@/components/dashboard/primitives";
import { isValidRole } from "@/lib/nav-config";
import {
  ADMIN_STATS,
  COHORT,
  CURRENT_USERS,
  EVALUATION_QUEUE,
  GROUPS,
  INDUSTRY,
  MANAGED_ITEMS,
  MY_GROUP,
  NEWS,
  SIGNOFF,
  TEACHERS,
  UNGROUPED,
  daysUntil,
  formatDue,
  type Role,
} from "@/lib/fixtures";

export default async function DashboardPage({
  params,
}: PageProps<"/dashboard/[role]">) {
  const { role } = await params;
  if (!isValidRole(role)) notFound();

  if (role === "student") return <StudentDashboard role={role} />;
  if (role === "teacher") return <TeacherDashboard role={role} />;
  return <AdminDashboard role={role} />;
}

/* -------------------------------------------------------------------------- */
/* 共用：待辦列                                                                */
/* -------------------------------------------------------------------------- */

function DueChip({ dueAt }: { dueAt: string }) {
  const d = daysUntil(dueAt);
  const tone =
    d < 0
      ? "text-destructive"
      : d <= 10
        ? "text-brand"
        : "text-muted-foreground";
  return (
    <span className={`tabular inline-flex items-center gap-1 text-xs font-semibold ${tone}`}>
      <IconClock className="size-3.5" />
      {formatDue(dueAt)}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* 學生                                                                        */
/* -------------------------------------------------------------------------- */

function StudentDashboard({ role }: { role: Role }) {
  const base = `/dashboard/${role}`;
  const user = CURRENT_USERS.student;
  const todo = MANAGED_ITEMS.filter(
    (i) => i.dueAt && i.myState && i.myState !== "submitted",
  ).sort((a, b) => daysUntil(a.dueAt!) - daysUntil(b.dueAt!));
  const submitted = MANAGED_ITEMS.filter((i) => i.myState === "submitted");
  const myPendingApproval = SIGNOFF.studentApprovals.find(
    (a) => a.name === user.name && !a.approved,
  );
  const confirmedCount = MY_GROUP.members.filter((m) => m.confirmed).length;

  return (
    <div className="space-y-6">
      {/* 第一眼就是「我現在要做什麼」 */}
      <Panel
        title="待完成事項"
        description={`${todo.length} 項未完成，依截止日排序`}
        action={{ href: `${base}/affairs`, label: "全部專題事務" }}
      >
        {todo.length === 0 ? (
          <EmptyState
            title="目前沒有待完成事項"
            hint="有新的繳交項目時會出現在這裡，並寄送通知。"
            icon={<IconInbox className="size-8" />}
          />
        ) : (
          <ul className="divide-y divide-border">
            {todo.map((item) => (
              <li
                key={item.id}
                className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:gap-4"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <StateBadge state={item.myState!} />
                    <p className="min-w-0 font-medium leading-snug">{item.title}</p>
                  </div>
                  <p className="mt-1 line-clamp-1 text-sm text-muted-foreground">
                    {item.summary}
                  </p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                    <DueChip dueAt={item.dueAt!} />
                    <span className="text-xs text-muted-foreground">
                      截止 {item.dueAt}
                    </span>
                    {item.attachments ? (
                      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                        <IconPaperclip className="size-3.5" />
                        {item.attachments} 個附件
                      </span>
                    ) : null}
                  </div>
                </div>
                <Link
                  href={`${base}/affairs/${item.id}`}
                  className={buttonVariants({
                    size: "lg",
                    variant: item.myState === "overdue" ? "outline" : "default",
                    className: "shrink-0",
                  })}
                >
                  {item.myState === "draft"
                    ? "繼續填寫"
                    : item.myState === "overdue"
                      ? "查看逾期處理"
                      : item.myState === "resubmit"
                        ? "修正後重送"
                        : "開始填寫"}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <div className="grid items-start gap-6 lg:grid-cols-2">
        {/* 我的組別 */}
        <Panel
          title="我的組別"
          description={`${MY_GROUP.no}・${MY_GROUP.type === "INDUSTRY" ? "產學合作" : "一般專題"}`}
          action={{ href: `${base}/groups`, label: "組別詳情" }}
        >
          <div className="border-b border-border px-4 py-3">
            <p className="font-medium leading-snug">{MY_GROUP.title}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              指導老師：
              {TEACHERS.find((t) => t.id === MY_GROUP.advisorId)?.name ?? "尚未指派"}
            </p>
          </div>
          <div className="px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                成員確認進度 {confirmedCount}/5
              </p>
              {confirmedCount < 5 ? (
                <Badge
                  variant="outline"
                  className="border-warning/35 bg-warning-subtle text-[11px] text-warning-on-subtle"
                >
                  等待 {5 - confirmedCount} 人確認
                </Badge>
              ) : (
                <Badge
                  variant="outline"
                  className="border-success/30 bg-success-subtle text-[11px] text-success-on-subtle"
                >
                  全員已確認
                </Badge>
              )}
            </div>
            <ul className="mt-3 space-y-2">
              {MY_GROUP.members.map((m) => (
                <li key={m.id} className="flex items-center gap-2.5">
                  {m.confirmed ? (
                    <IconCheck className="size-4 shrink-0 text-success" aria-label="已確認" />
                  ) : (
                    <IconClock
                      className="size-4 shrink-0 text-muted-foreground"
                      aria-label="尚未確認"
                    />
                  )}
                  <span className="text-sm font-medium">{m.name}</span>
                  <span className="tabular text-xs text-muted-foreground">
                    {m.studentNo}
                  </span>
                  {m.isLeader ? (
                    <Badge variant="outline" className="text-[10px]">
                      組長
                    </Badge>
                  ) : null}
                  {m.id === CURRENT_USERS.student.id ? (
                    <Badge variant="outline" className="text-[10px] text-primary">
                      我
                    </Badge>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        </Panel>

        {/* 待我同意 */}
        <Panel
          title="待我同意"
          description="每個人只能提交自己的同意，不能代替他人"
          action={{ href: `${base}/signoff`, label: "簽核紀錄" }}
        >
          {myPendingApproval ? (
            <div className="px-4 py-3">
              <p className="font-medium leading-snug">{SIGNOFF.title}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                五位組員需各自同意，全部同意後才輪到指導老師。
              </p>

              <ul className="mt-3 space-y-2">
                {SIGNOFF.studentApprovals.map((a) => (
                  <li key={a.name} className="flex items-center gap-2.5">
                    {a.approved ? (
                      <IconCheck className="size-4 shrink-0 text-success" aria-label="已同意" />
                    ) : (
                      <IconClock
                        className="size-4 shrink-0 text-muted-foreground"
                        aria-label="尚未同意"
                      />
                    )}
                    <span className="text-sm">{a.name}</span>
                    <span className="tabular ml-auto text-xs text-muted-foreground">
                      {a.at ?? "—"}
                    </span>
                  </li>
                ))}
                <li className="flex items-center gap-2.5 border-t border-border pt-2">
                  <IconSignature
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <span className="text-sm">
                    指導老師 {SIGNOFF.teacherApproval.name}
                  </span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    尚未輪到
                  </span>
                </li>
              </ul>

              <div className="mt-4 flex flex-wrap gap-2">
                <button className={buttonVariants({ size: "lg" })}>
                  <IconCheck /> 我已閱讀並同意
                </button>
                <button className={buttonVariants({ variant: "outline", size: "lg" })}>
                  <IconX /> 不同意並填寫原因
                </button>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                同意後會記錄你的帳號、時間與內容版本；內容或組員變更時舊同意自動失效。
              </p>
            </div>
          ) : (
            <EmptyState title="沒有待你同意的項目" />
          )}
        </Panel>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[1fr_20rem]">
        <Panel
          title="已完成"
          description={`${submitted.length} 項已繳交，截止前仍可重送`}
        >
          {submitted.length === 0 ? (
            <EmptyState title="尚無已完成項目" />
          ) : (
            <ul className="divide-y divide-border">
              {submitted.map((item) => (
                <li
                  key={item.id}
                  className="flex items-center gap-3 px-4 py-3"
                >
                  <StateBadge state="submitted" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {item.title}
                  </span>
                  <Link
                    href={`${base}/affairs/${item.id}`}
                    className="shrink-0 text-xs font-medium text-primary hover:underline"
                  >
                    查看版本
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="近期公告" action={{ href: "/news", label: "全部" }}>
          <ul className="divide-y divide-border">
            {NEWS.slice(0, 4).map((n) => (
              <li key={n.id} className="px-4 py-3">
                <time className="tabular text-xs text-muted-foreground">{n.date}</time>
                <p className="mt-0.5 line-clamp-2 text-sm font-medium leading-snug">
                  {n.title}
                </p>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 老師                                                                        */
/* -------------------------------------------------------------------------- */

function TeacherDashboard({ role }: { role: Role }) {
  const base = `/dashboard/${role}`;
  const me = CURRENT_USERS.teacher;
  const myGroups = GROUPS.filter((g) => g.advisorId === me.id);
  const claimable = GROUPS.filter(
    (g) => g.type === "INDUSTRY" && g.advisorId === null,
  );
  const pending = EVALUATION_QUEUE.filter((e) => e.state === "pending");
  const staged = EVALUATION_QUEUE.filter((e) => e.state === "staged");

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="待評分組別"
          value={pending.length}
          unit="組"
          tone={pending.length > 0 ? "warning" : "default"}
          href={`${base}/grading`}
        />
        <StatTile label="已暫存未送出" value={staged.length} unit="組" href={`${base}/grading`} />
        <StatTile label="我的指導組別" value={myGroups.length} unit="組" href={`${base}/groups`} />
        <StatTile
          label="可認領產學組"
          value={claimable.length}
          unit="組"
          tone={claimable.length > 0 ? "warning" : "default"}
          href={`${base}/groups`}
        />
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-2">
        <Panel
          title="待評分"
          description="只顯示你被指派的組別與階段"
          action={{ href: `${base}/grading`, label: "評分工作台" }}
        >
          <ul className="divide-y divide-border">
            {EVALUATION_QUEUE.map((e) => (
              <li key={e.groupId} className="flex items-center gap-3 px-4 py-3.5">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="tabular text-xs text-muted-foreground">
                      {e.groupNo}
                    </span>
                    {e.state === "pending" ? (
                      <Badge
                        variant="outline"
                        className="border-warning/35 bg-warning-subtle text-[11px] text-warning-on-subtle"
                      >
                        未開始
                      </Badge>
                    ) : e.state === "staged" ? (
                      <Badge
                        variant="outline"
                        className="border-info/30 bg-info-subtle text-[11px] text-info-on-subtle"
                      >
                        已暫存
                      </Badge>
                    ) : (
                      <Badge
                        variant="outline"
                        className="border-success/30 bg-success-subtle text-[11px] text-success-on-subtle"
                      >
                        已送出・鎖定
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1 truncate text-sm font-medium">{e.title}</p>
                </div>
                <Link
                  href={`${base}/grading/${e.groupId}`}
                  className={buttonVariants({
                    size: "lg",
                    variant: e.state === "submitted" ? "outline" : "default",
                    className: "shrink-0",
                  })}
                >
                  {e.state === "submitted" ? "檢視" : e.state === "staged" ? "繼續" : "開始評分"}
                </Link>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel
          title="尚未指派的產學組"
          description="先按先得；同時操作時只有一位會成功"
          action={{ href: `${base}/groups`, label: "全體分組" }}
        >
          {claimable.length === 0 ? (
            <EmptyState title="目前沒有可認領的產學組" />
          ) : (
            <ul className="divide-y divide-border">
              {claimable.map((g) => (
                <li key={g.id} className="flex items-center gap-3 px-4 py-3.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="tabular text-xs text-muted-foreground">{g.no}</span>
                      <Badge
                        variant="outline"
                        className="border-brand/30 bg-brand-subtle text-[11px] text-brand-on-subtle"
                      >
                        產學合作
                      </Badge>
                    </div>
                    <p className="mt-1 truncate text-sm font-medium">{g.title}</p>
                  </div>
                  <button
                    className={buttonVariants({
                      variant: "outline",
                      size: "lg",
                      className: "shrink-0",
                    })}
                  >
                    <IconHandGrab /> 指定為我的組別
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel
        title="我的指導組別與繳交狀態"
        action={{ href: `${base}/affairs`, label: "各組繳交狀態" }}
      >
        <ul className="divide-y divide-border">
          {myGroups.map((g) => (
            <li key={g.id} className="grid gap-2 px-4 py-3.5 sm:grid-cols-[1fr_14rem] sm:items-center sm:gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="tabular text-xs text-muted-foreground">{g.no}</span>
                  <Badge variant="outline" className="text-[11px] text-muted-foreground">
                    {g.type === "INDUSTRY" ? "產學合作" : "一般專題"}
                  </Badge>
                </div>
                <p className="mt-1 truncate text-sm font-medium">{g.title}</p>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {g.members.map((m) => m.name).join("、")}
                </p>
              </div>
              <div>
                <p className="mb-1.5 text-xs text-muted-foreground">本屆收件完成度</p>
                <ProgressBar done={3} total={5} overdue={g.id === "g-07" ? 1 : 0} />
              </div>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 管理員                                                                      */
/* -------------------------------------------------------------------------- */

function AdminDashboard({ role }: { role: Role }) {
  const base = `/dashboard/${role}`;
  const s = ADMIN_STATS;
  const submissionItems = MANAGED_ITEMS.filter((i) => i.progress);
  const unassignedIndustry = INDUSTRY.filter((i) => i.status === "open");

  return (
    <div className="space-y-6">
      {/* 需要處理的事情排在統計前面 */}
      <Panel title="需要處理" description="有明確下一步的事項">
        <ul className="divide-y divide-border">
          <ActionRow
            icon={<IconUserCheck className="size-4 text-warning" />}
            label="待審核帳號"
            detail="CSV 名單未命中或以 Email 註冊，需人工核准"
            count={s.pendingAccounts}
            href={`${base}/accounts?status=pending`}
            cta="前往審核"
          />
          <ActionRow
            icon={<IconAlertTriangle className="size-4 text-destructive" />}
            label="逾期未繳組別"
            detail="系統驗收簡報與說明文件，需個別重新開放並填理由"
            count={3}
            href={`${base}/affairs/mi-011`}
            cta="處理逾期"
          />
          <ActionRow
            icon={<IconHandGrab className="size-4 text-brand" />}
            label="產學案未指派組別"
            detail="老師可自行認領，亦可由系辦直接指派"
            count={unassignedIndustry.length}
            href={`${base}/industry?status=open`}
            cta="查看產學案"
          />
          <ActionRow
            icon={<IconChecklist className="size-4 text-info" />}
            label="缺評老師"
            detail="系統驗收階段尚有老師未送出正式評分"
            count={2}
            href={`${base}/grading`}
            cta="查看評分進度"
          />
        </ul>
      </Panel>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="本屆已分組學生"
          value={s.groupedStudents}
          unit="人"
          hint={`未分組 ${s.ungroupedStudents} 人・例外組 ${s.groupExceptions} 組`}
          href={`${base}/groups`}
        />
        <StatTile
          label="組別總數"
          value={GROUPS.length}
          unit="組"
          hint={`產學 ${GROUPS.filter((g) => g.type === "INDUSTRY").length} 組`}
          href={`${base}/groups`}
        />
        <StatTile
          label="檔案儲存量"
          value={s.storageUsedGiB}
          unit={`/ ${s.storageTotalGiB} GiB`}
          hint="校內 VM persistent volume"
        />
        <StatTile
          label="最近成功備份"
          value={s.lastBackupAt.slice(5)}
          tone="default"
          hint={`還原演練：${s.lastRestoreDrillAt}`}
        />
      </div>

      {s.lastRestoreDrillAt === "尚未執行" ? (
        <div className="flex items-start gap-3 rounded-lg border border-warning/35 bg-warning-subtle px-4 py-3">
          <IconAlertTriangle className="mt-0.5 size-4 shrink-0 text-warning-on-subtle" />
          <div className="text-sm text-warning-on-subtle">
            <p className="font-medium">尚未完成任何還原演練</p>
            <p className="mt-0.5 text-xs leading-relaxed opacity-90">
              上線前必須在全新環境完成至少一次 restore drill，並記錄時間、版本與檔案抽查結果。
              失敗紀錄不得覆蓋最後成功時間。
            </p>
          </div>
        </div>
      ) : null}

      <div className="grid items-start gap-6 lg:grid-cols-[1fr_20rem]">
        <Panel
          title="收件項目完成率"
          description={`${COHORT.label}・共 ${GROUPS.length} 組`}
          action={{ href: `${base}/affairs`, label: "專題事務工作台" }}
        >
          <ul className="divide-y divide-border">
            {submissionItems.map((item) => (
              <li
                key={item.id}
                className="grid gap-2 px-4 py-3.5 sm:grid-cols-[1fr_13rem] sm:items-center sm:gap-4"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{item.title}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                    <Badge variant="outline" className="text-[10px] text-muted-foreground">
                      v{item.schemaVersion ?? 1}
                    </Badge>
                    {item.dueAt ? <DueChip dueAt={item.dueAt} /> : null}
                    {item.progress!.overdue > 0 ? (
                      <span className="text-xs font-medium text-destructive">
                        逾期 {item.progress!.overdue} 組
                      </span>
                    ) : null}
                  </div>
                </div>
                <ProgressBar
                  done={item.progress!.done}
                  total={item.progress!.total}
                  overdue={item.progress!.overdue}
                />
              </li>
            ))}
          </ul>
        </Panel>

        <div className="space-y-6">
          <Panel title="未分組學生" action={{ href: `${base}/groups`, label: "分組總覽" }}>
            <ul className="divide-y divide-border">
              {UNGROUPED.map((u) => (
                <li key={u.id} className="flex items-center gap-2 px-4 py-2.5">
                  <span className="text-sm font-medium">{u.name}</span>
                  <span className="tabular text-xs text-muted-foreground">
                    {u.studentNo}
                  </span>
                  {u.openToJoin ? (
                    <Badge
                      variant="outline"
                      className="ml-auto border-success/30 bg-success-subtle text-[10px] text-success-on-subtle"
                    >
                      公開找組員
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="ml-auto text-[10px] text-muted-foreground">
                      未公開
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
          </Panel>

          <Panel title="系統狀態">
            <ul className="divide-y divide-border text-sm">
              <li className="flex items-center gap-2 px-4 py-2.5">
                <IconDatabase className="size-4 text-muted-foreground" />
                <span>PostgreSQL</span>
                <Badge
                  variant="outline"
                  className="ml-auto border-success/30 bg-success-subtle text-[10px] text-success-on-subtle"
                >
                  正常
                </Badge>
              </li>
              <li className="flex items-center gap-2 px-4 py-2.5">
                <IconDatabase className="size-4 text-muted-foreground" />
                <span>檔案 volume</span>
                <Badge
                  variant="outline"
                  className="ml-auto border-success/30 bg-success-subtle text-[10px] text-success-on-subtle"
                >
                  正常
                </Badge>
              </li>
              <li className="flex items-center gap-2 px-4 py-2.5">
                <IconAlertTriangle className="size-4 text-warning" />
                <span>VM 外部備份目的地</span>
                <Badge
                  variant="outline"
                  className="ml-auto border-warning/35 bg-warning-subtle text-[10px] text-warning-on-subtle"
                >
                  未設定
                </Badge>
              </li>
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  );
}

function ActionRow({
  icon,
  label,
  detail,
  count,
  href,
  cta,
}: {
  icon: React.ReactNode;
  label: string;
  detail: string;
  count: number;
  href: string;
  cta: string;
}) {
  return (
    <li className="flex flex-col gap-2 px-4 py-3.5 sm:flex-row sm:items-center sm:gap-4">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {label}
          <span className="tabular ml-2 text-base font-semibold">{count}</span>
        </p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{detail}</p>
      </div>
      <Link
        href={href}
        className={buttonVariants({ variant: "outline", size: "lg", className: "shrink-0" })}
      >
        {cta}
        <IconArrowRight />
      </Link>
    </li>
  );
}
