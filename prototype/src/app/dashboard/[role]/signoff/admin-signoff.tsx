import { Suspense } from "react";
import { IconFileText, IconSignature, IconUsersGroup } from "@tabler/icons-react";
import { PageTitle, Panel } from "@/components/dashboard/primitives";
import { Donut } from "@/components/dashboard/rc-charts";
import { ConsentUpload } from "@/components/dashboard/consent-upload";
import { NewSignoffDialog } from "@/components/dashboard/new-signoff-dialog";
import { RemindDialog } from "@/components/dashboard/remind-dialog";
import { SignoffGroups } from "@/components/dashboard/signoff-groups";
import { GROUPS, SIGNOFF, SIGNOFF_PROGRESS, TEACHERS } from "@/lib/fixtures";
import { CONSENT_FILE } from "./consent-file";

/**
 * 管理員簽核（Roy 2026-09-10 選畫布 A，左圓形圖）。
 * Codex 09-10 A-06：口徑改成「完成／學生已齊、等老師／學生未齊」母數 9；拿掉重複小磚；缺誰可展開；重置先列影響。
 */
export function AdminSignoff({ base = "/dashboard/admin/signoff" }: { base?: string }) {
  const complete = SIGNOFF_PROGRESS.filter((p) => p.state === "complete").length;
  const waitingTeacher = SIGNOFF_PROGRESS.filter((p) => p.state === "teacher").length;
  const waitingStudents = SIGNOFF_PROGRESS.filter((p) => p.state === "students").length;
  const total = GROUPS.length;
  const recipients = SIGNOFF_PROGRESS.flatMap((p) => {
    const g = GROUPS.find((x) => x.id === p.groupId)!;
    const students = p.missing.map((name) => ({ name, detail: `${p.groupNo}・學生` }));
    const advisor = TEACHERS.find((t) => t.id === g.advisorId);
    const teacher = p.state === "teacher" && advisor ? [{ name: advisor.name, detail: `${p.groupNo}・指導老師` }] : [];
    return [...students, ...teacher];
  });
  return (
    <div className="flex flex-col gap-5">
      <PageTitle title="簽核管理" description={`${SIGNOFF.title} v${SIGNOFF.packageVersion}・${total} 組。系辦只能發布、重開或重置，不能代替任何人同意。`} actions={<NewSignoffDialog />} />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Panel title="整體進度" icon={<IconSignature />} description={`完成 ${complete}／${total} 組`}>
          <div className="flex flex-col gap-4 px-5 pt-1 pb-5">
            <div className="flex items-center gap-6">
              <Donut size={150} thickness={20} data={[{ name: "完成", value: complete, color: "var(--success)" }, { name: "學生已齊、等老師", value: waitingTeacher, color: "var(--brand)" }, { name: "學生未齊", value: waitingStudents, color: "var(--border)" }]} center={<span className="text-center"><span className="tabular block text-[26px] font-extrabold leading-none">{Math.round((complete / total) * 100)}%</span><span className="text-[10px] text-muted-foreground">完成</span></span>} />
              <ul className="flex flex-1 flex-col gap-2.5 text-sm">
                <li className="flex items-center justify-between"><span className="inline-flex items-center gap-2"><span className="size-2.5 rounded-sm bg-success" />完成</span><b className="tabular">{complete} 組</b></li>
                <li className="flex items-center justify-between"><span className="inline-flex items-center gap-2"><span className="size-2.5 rounded-sm bg-brand" />學生已齊、等老師</span><b className="tabular">{waitingTeacher} 組</b></li>
                <li className="flex items-center justify-between"><span className="inline-flex items-center gap-2"><span className="size-2.5 rounded-sm bg-border" />學生未齊</span><b className="tabular">{waitingStudents} 組</b></li>
                <li className="flex items-center justify-between border-t border-border/70 pt-2 text-muted-foreground"><span>母數</span><b className="tabular">{total} 組</b></li>
              </ul>
            </div>
            <RemindDialog recipients={recipients} subject={`【專題】${SIGNOFF.title} v${SIGNOFF.packageVersion} 等你同意`} context={`${recipients.length} 位還沒同意：學生 ${recipients.filter((r) => r.detail?.endsWith("學生")).length}、老師 ${recipients.filter((r) => r.detail?.endsWith("老師")).length}。`} label={`提醒未同意者（${recipients.length}）`} />
          </div>
        </Panel>
        <Panel title="各組進度" icon={<IconUsersGroup />} description="每格＝一位學生、右邊短格＝老師；點「缺 N 位」看是誰">
          <Suspense fallback={<div className="px-5 py-8 text-sm text-muted-foreground">載入中…</div>}>
            <SignoffGroups base={base} />
          </Suspense>
        </Panel>
      </div>
      <Panel title="同意書檔案" icon={<IconFileText />} description="學生在後台直接看這份 PDF；換新版會重置所有人的同意">
        <ConsentUpload current={CONSENT_FILE} />
      </Panel>
    </div>
  );
}
