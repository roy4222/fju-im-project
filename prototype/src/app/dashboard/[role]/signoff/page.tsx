import { notFound } from "next/navigation";
import { IconCheck, IconClock, IconFileText, IconSignature, IconUsersGroup } from "@tabler/icons-react";
import { EmptyState, PageTitle, Panel, Pill, StatTile } from "@/components/dashboard/primitives";
import { Ring, SegmentBar } from "@/components/dashboard/charts";
import { Donut } from "@/components/dashboard/rc-charts";
import { buttonVariants } from "@/components/ui/button";
import { ApproveActions, ResetDialog } from "@/components/dashboard/signoff-actions";
import { ConsentReader, ConsentUpload } from "@/components/dashboard/consent-reader";
import { isValidRole } from "@/lib/nav-config";
import { CURRENT_USERS, GROUPS, SIGNOFF, SIGNOFF_PROGRESS } from "@/lib/fixtures";

/** 系辦上傳的同意書 PDF（原型：public/docs 的示範檔） */
const CONSENT_FILE = { file: "/docs/consent-2026.1.pdf", version: "2026.1", updatedAt: "2026-08-12" };

export default async function SignoffPage({ params }: PageProps<"/dashboard/[role]/signoff">) {
  const { role } = await params;
  if (!isValidRole(role)) notFound();
  if (role === "student") return <StudentSignoff />;
  if (role === "teacher") return <TeacherSignoff />;
  return <AdminSignoff />;
}

function Steps({ students, total, teacher }: { students: number; total: number; teacher: boolean }) {
  return <SegmentBar segments={[{ value: students, color: "var(--success)", label: "學生已同意" }, { value: total - students, color: "var(--muted)", label: "學生未同意" }, { value: 1, color: teacher ? "var(--brand)" : "color-mix(in oklch, var(--brand) 25%, transparent)", label: "老師" }]} />;
}

/* 學生：直接看系辦上傳的 PDF 原檔，看完再同意（Roy 2026-09-09） */
function StudentSignoff() {
  const me = CURRENT_USERS.student;
  const approved = SIGNOFF.studentApprovals.filter((a) => a.approved).length;
  const mine = SIGNOFF.studentApprovals.find((a) => a.name === me.name);
  return (
    <div className="flex flex-col gap-5">
      <PageTitle title="同意書" description="每個人只能提交自己的同意；五人全同意後才輪到指導老師。" />
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <Panel title={SIGNOFF.title} icon={<IconFileText />}>
          <ConsentReader file={CONSENT_FILE.file} version={CONSENT_FILE.version} updatedAt={CONSENT_FILE.updatedAt} alreadyDone={!!mine?.approved}>
            {mine && !mine.approved ? <ApproveActions who={me.name} title={SIGNOFF.title} packageVersion={SIGNOFF.packageVersion} /> : <div className="flex items-center gap-2 rounded-lg bg-success-subtle px-4 py-3 text-sm font-semibold text-success-on-subtle"><IconCheck className="size-4" /> 你已同意（{mine?.at}）</div>}
          </ConsentReader>
        </Panel>
        <Panel title="進度" icon={<IconUsersGroup />}>
          <div className="flex flex-col gap-4 p-5">
            <div className="flex items-center gap-4">
              <Ring value={(approved / 5) * 100} size={64} color="var(--success)"><span className="tabular text-sm font-extrabold">{approved}/5</span></Ring>
              <div className="text-sm"><p className="font-bold">學生同意</p><p className="text-xs text-muted-foreground">之後由指導老師 {SIGNOFF.teacherApproval.name} 同意</p></div>
            </div>
            <ul className="flex flex-col gap-2">
              {SIGNOFF.studentApprovals.map((a) => (
                <li key={a.name} className="flex items-center gap-2.5 text-sm">
                  {a.approved ? <IconCheck className="size-4 text-success" /> : <IconClock className="size-4 text-muted-foreground" />}
                  <span className={a.name === me.name ? "font-bold" : ""}>{a.name}</span>
                  <span className="tabular ml-auto text-xs text-muted-foreground">{a.at?.slice(5) ?? "—"}</span>
                </li>
              ))}
              <li className="flex items-center gap-2.5 border-t border-border pt-2 text-sm"><IconSignature className="size-4 text-muted-foreground" /><span>{SIGNOFF.teacherApproval.name} 老師</span><span className="ml-auto text-xs text-muted-foreground">尚未輪到</span></li>
            </ul>
          </div>
        </Panel>
      </div>
    </div>
  );
}

/* 老師 */
function TeacherSignoff() {
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

/* 管理員（Roy 2026-09-10 選畫布 A，但左邊漏斗換成圓形圖）：左圓形圖＋右各組六格條；同意書檔案在下 */
function AdminSignoff() {
  const complete = SIGNOFF_PROGRESS.filter((p) => p.state === "complete").length;
  const waitingTeacher = SIGNOFF_PROGRESS.filter((p) => p.students === p.total && !p.teacher).length;
  const waitingStudents = SIGNOFF_PROGRESS.filter((p) => p.students < p.total).length;
  const total = GROUPS.length;
  return (
    <div className="flex flex-col gap-5">
      <PageTitle title="簽核管理" description={`${SIGNOFF.title}・${total} 組。系辦只能重開或重置，不能代替任何人同意。`} actions={<button type="button" className="btn-fju h-10 px-4 text-sm">新增簽核</button>} />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Panel title="整體進度" icon={<IconSignature />} description={`${complete}／${total} 組完成`}>
          <div className="flex flex-col gap-4 px-5 pt-1 pb-5">
            <div className="flex items-center gap-6">
              <Donut size={150} thickness={20} data={[{ name: "完成", value: complete, color: "var(--success)" }, { name: "等老師", value: waitingTeacher, color: "var(--brand)" }, { name: "等學生", value: waitingStudents, color: "var(--border)" }]} center={<span className="text-center"><span className="tabular block text-[26px] font-extrabold leading-none">{Math.round((complete / total) * 100)}%</span><span className="text-[10px] text-muted-foreground">完成</span></span>} />
              <ul className="flex flex-1 flex-col gap-2.5 text-sm">
                <li className="flex items-center justify-between"><span className="inline-flex items-center gap-2"><span className="size-2.5 rounded-sm bg-success" />完成</span><b className="tabular">{complete} 組</b></li>
                <li className="flex items-center justify-between"><span className="inline-flex items-center gap-2"><span className="size-2.5 rounded-sm bg-brand" />等老師同意</span><b className="tabular">{waitingTeacher} 組</b></li>
                <li className="flex items-center justify-between"><span className="inline-flex items-center gap-2"><span className="size-2.5 rounded-sm bg-border" />學生未齊</span><b className="tabular">{waitingStudents} 組</b></li>
              </ul>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl bg-muted/50 px-4 py-3"><p className="text-[11px] font-bold text-muted-foreground">學生五人同意</p><p className="tabular text-[22px] font-extrabold leading-tight">{SIGNOFF_PROGRESS.filter((p) => p.students === p.total).length}<span className="text-xs font-semibold text-muted-foreground">／{total} 組</span></p></div>
              <div className="rounded-xl bg-muted/50 px-4 py-3"><p className="text-[11px] font-bold text-muted-foreground">老師同意</p><p className="tabular text-[22px] font-extrabold leading-tight">{complete}<span className="text-xs font-semibold text-muted-foreground">／{total} 組</span></p></div>
            </div>
            <button type="button" className={buttonVariants({ variant: "outline", className: "press rounded-lg" })}>提醒未同意者</button>
          </div>
        </Panel>
        <Panel title="各組進度" icon={<IconUsersGroup />} description="五格＝學生、最後一格＝老師">
          <ul className="flex flex-col gap-3 px-5 py-4">
            {SIGNOFF_PROGRESS.map((p) => {
              const g = GROUPS.find((x) => x.id === p.groupId)!;
              const missing = g.members.slice(p.students).map((m) => m.name);
              const label = p.state === "complete" ? "完成" : p.students === p.total ? "等老師" : `缺 ${p.total - p.students} 位學生`;
              return (
                <li key={p.groupId} className="grid items-center gap-3 md:grid-cols-[4.5rem_minmax(0,1fr)_7rem_auto]">
                  <span className="tabular text-sm font-bold">{p.groupNo}</span>
                  <div className="flex gap-0.5" title={missing.length ? `缺：${missing.join("、")}` : undefined}>
                    {Array.from({ length: p.total }, (_, k) => <span key={k} className={`h-3 flex-1 rounded-sm ${k < p.students ? "bg-primary" : "bg-muted"}`} />)}
                    <span className={`ml-1 h-3 flex-1 rounded-sm ${p.teacher ? "bg-success" : "bg-muted"}`} />
                  </div>
                  <span className={`text-xs ${p.state === "complete" ? "font-semibold text-success" : p.students === p.total ? "font-semibold text-brand" : "text-muted-foreground"}`}>{label}</span>
                  <div className="md:justify-self-end"><ResetDialog groupNo={p.groupNo} /></div>
                </li>
              );
            })}
          </ul>
        </Panel>
      </div>
      <Panel title="同意書檔案" icon={<IconFileText />} description="學生在後台直接看這份 PDF；換新版會重置所有人的同意">
        <ConsentUpload current={CONSENT_FILE} />
      </Panel>
    </div>
  );
}
