import { IconCheck, IconClock, IconFileText, IconSignature, IconUsersGroup } from "@tabler/icons-react";
import { PageTitle, Panel } from "@/components/dashboard/primitives";
import { Ring } from "@/components/dashboard/charts";
import { ApproveActions } from "@/components/dashboard/signoff-actions";
import { ConsentReader } from "@/components/dashboard/consent-reader";
import { CURRENT_USERS, SIGNOFF } from "@/lib/fixtures";
import { CONSENT_FILE } from "./consent-file";

/* 學生：直接看系辦上傳的 PDF 原檔，看完再同意（Roy 2026-09-09） */
export function StudentSignoff() {
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
