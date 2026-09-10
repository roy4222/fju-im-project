import { IconCheck, IconClock, IconFileText, IconSignature, IconUsersGroup } from "@tabler/icons-react";
import { PageTitle, Panel } from "@/components/dashboard/primitives";
import { Ring } from "@/components/dashboard/charts";
import { ApproveActions } from "@/components/dashboard/signoff-actions";
import { ConsentReader } from "@/components/dashboard/consent-reader";
import { CURRENT_USERS, SIGNOFF } from "@/lib/fixtures";
import { CONSENT_FILE } from "./consent-file";

/* 學生：先讀摘要與 PDF，再表態（Roy 2026-09-09；Codex 09-10 S-06：列出誰尚未表態、可重送說明） */
export function StudentSignoff() {
  const me = CURRENT_USERS.student;
  const approved = SIGNOFF.studentApprovals.filter((a) => a.approved).length;
  const mine = SIGNOFF.studentApprovals.find((a) => a.name === me.name);
  const waiting = SIGNOFF.studentApprovals.filter((a) => !a.approved).map((a) => (a.name === me.name ? `${a.name}（你）` : a.name));
  return (
    <div className="flex flex-col gap-5">
      <PageTitle title="同意書" description="每個人只能提交自己的同意；五人全同意後才輪到指導老師。" />
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <Panel title={SIGNOFF.title} icon={<IconFileText />}>
          <ConsentReader file={CONSENT_FILE.file} version={CONSENT_FILE.version} updatedAt={CONSENT_FILE.updatedAt} alreadyDone={!!mine?.approved}>
            {mine && !mine.approved ? <ApproveActions who={me.name} title={SIGNOFF.title} packageVersion={SIGNOFF.packageVersion} /> : <div className="flex items-center gap-2 rounded-lg bg-success-subtle px-4 py-3 text-sm font-semibold text-success-on-subtle"><IconCheck className="size-4" /> 你已同意（{mine?.at}）</div>}
          </ConsentReader>
        </Panel>
        <Panel title="進度" icon={<IconUsersGroup />}>
          <div className="flex flex-col gap-4 p-5">
            <div className="flex items-center gap-4">
              <Ring value={(approved / 5) * 100} size={64} color="var(--success)"><span className="tabular text-sm font-extrabold">{approved}/5</span></Ring>
              <div className="text-sm">
                <p className="font-bold">學生同意</p>
                <p className="text-xs text-muted-foreground">{waiting.length ? `尚未表態：${waiting.join("、")}` : "五位都已同意"}</p>
              </div>
            </div>
            <ul className="flex flex-col gap-2">
              {SIGNOFF.studentApprovals.map((a) => (
                <li key={a.name} className="flex items-center gap-2.5 text-sm">
                  {a.approved ? <IconCheck className="size-4 text-success" /> : <IconClock className="size-4 text-muted-foreground" />}
                  <span className={a.name === me.name ? "font-bold" : ""}>{a.name}{a.name === me.name ? "（你）" : ""}</span>
                  <span className="tabular ml-auto text-xs text-muted-foreground">{a.approved ? a.at?.slice(5) : "尚未表態"}</span>
                </li>
              ))}
              <li className="flex items-start gap-2.5 border-t border-border pt-2 text-sm">
                <IconSignature className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0"><span className="block">{SIGNOFF.teacherApproval.name} 老師</span><span className="block text-xs text-muted-foreground">等五位都同意後輪到 {SIGNOFF.teacherApproval.name} 老師</span></span>
              </li>
            </ul>
            <p className="border-t border-border pt-3 text-xs leading-relaxed text-muted-foreground">表態後在老師簽核前可以重送：改成不同意會退回修正，改回同意會覆蓋上一筆並重新記錄時間與版本。</p>
          </div>
        </Panel>
      </div>
    </div>
  );
}
