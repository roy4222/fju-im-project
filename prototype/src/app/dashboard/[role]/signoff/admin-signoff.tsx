import { IconFileText, IconSignature, IconUsersGroup } from "@tabler/icons-react";
import { PageTitle, Panel } from "@/components/dashboard/primitives";
import { Donut } from "@/components/dashboard/rc-charts";
import { buttonVariants } from "@/components/ui/button";
import { ResetDialog } from "@/components/dashboard/reset-dialog";
import { ConsentUpload } from "@/components/dashboard/consent-upload";
import { GROUPS, SIGNOFF, SIGNOFF_PROGRESS } from "@/lib/fixtures";
import { CONSENT_FILE } from "./consent-file";

/* 管理員（Roy 2026-09-10 選畫布 A，但左邊漏斗換成圓形圖）：左圓形圖＋右各組六格條；同意書檔案在下 */
export function AdminSignoff() {
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
