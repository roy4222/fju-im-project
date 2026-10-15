import Link from "next/link";
import { IconArrowLeft, IconCheck, IconClock, IconSignature } from "@tabler/icons-react";
import { ApproveActions } from "@/components/dashboard/signoff-actions";
import { ConsentReader } from "@/components/dashboard/consent-reader";
import { GROUPS, SIGNOFF } from "@/lib/fixtures";
import { ME, TEACHER_BASE as base, approvedStudents, myConsents, shortTitle } from "@/lib/teacher-v2";
import { CONSENT_FILE } from "../../../signoff/consent-file";

/**
 * 老師：某組的同意書（作業區 → 同意書分頁點進來）。
 * 學生全同意後才輪到老師；收集中時「還沒回覆」只列學生，老師不在裡面。
 */
export function TeacherConsent({ groupId }: { groupId: string }) {
  const p = myConsents().find((x) => x.groupId === groupId)!;
  const g = GROUPS.find((x) => x.id === groupId)!;
  const approved = approvedStudents(groupId);
  const ok = new Set(approved.map((a) => a.name));
  const waiting = g.members.filter((m) => !ok.has(m.name));
  const chip = p.state === "teacher" ? { label: "待我同意", cls: "bg-brand text-white" } : p.state === "complete" ? { label: "已完成", cls: "bg-success-subtle text-success-on-subtle" } : { label: "學生收集中", cls: "bg-card text-muted-foreground" };

  return (
    <div className="flex flex-col gap-5">
      <Link href={`${base}/affairs?tab=consent`} className="inline-flex w-fit items-center gap-1 text-[13px] font-semibold text-muted-foreground transition-colors hover:text-foreground"><IconArrowLeft className="size-4" /> 同意書</Link>

      <header className="flex flex-wrap items-center gap-4 rounded-3xl bg-accent/70 p-5 md:p-6">
        <span className="inline-flex size-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground"><IconSignature className="size-6" /></span>
        <div className="min-w-0 flex-1">
          <p className="tabular text-[12px] font-bold text-muted-foreground">{p.groupNo}・{shortTitle(p.title)}</p>
          <h1 className="text-[22px] font-extrabold tracking-tight">{SIGNOFF.title}</h1>
        </div>
        <span className={`rounded-full px-3 py-1 text-[13px] font-bold ${chip.cls}`} data-consent-state={p.state}>{chip.label}</span>
      </header>

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_19rem]">
        <section aria-label="同意書全文" className="dash-card overflow-hidden">
          <ConsentReader file={CONSENT_FILE.file} version={CONSENT_FILE.version} updatedAt={CONSENT_FILE.updatedAt} alreadyDone={p.state !== "teacher"}>
            {p.state === "teacher" ? (
              <ApproveActions who={`${ME.name} 老師`} title={SIGNOFF.title} packageVersion={SIGNOFF.packageVersion} />
            ) : p.state === "complete" ? (
              <div className="flex items-center gap-2 rounded-lg bg-success-subtle px-4 py-3 text-sm font-semibold text-success-on-subtle"><IconCheck className="size-4" /> 你已同意</div>
            ) : (
              <div className="flex items-center gap-2 rounded-lg bg-muted px-4 py-3 text-sm font-semibold text-muted-foreground"><IconClock className="size-4" /> 學生都同意後才輪到你</div>
            )}
          </ConsentReader>
        </section>

        <aside aria-labelledby="who-title" className="dash-card p-5" data-consent-who>
          <h2 id="who-title" className="text-[15px] font-bold">學生 <span className="tabular ml-1 text-sm text-muted-foreground">{approved.length}／{g.members.length}</span></h2>
          {waiting.length ? (
            <>
              <h3 className="mt-4 text-[12px] font-bold text-muted-foreground">還沒回覆</h3>
              <ul className="mt-2 flex flex-col gap-2.5" data-waiting>
                {waiting.map((m) => (
                  <li key={m.id} className="flex items-center gap-3 text-sm">
                    <span className="inline-flex size-9 items-center justify-center rounded-full bg-muted text-[12px] font-bold text-muted-foreground">{m.name.slice(-2)}</span>
                    {m.name}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <h3 className="mt-4 text-[12px] font-bold text-muted-foreground">已同意</h3>
          <ul className="mt-2 flex flex-col gap-2.5">
            {approved.map((a) => (
              <li key={a.name} className="flex items-center gap-3 text-sm">
                <span className="relative inline-flex size-9 items-center justify-center rounded-full bg-success-subtle text-[12px] font-bold text-success-on-subtle">
                  {a.name.slice(-2)}
                  <span className="absolute -right-0.5 -bottom-0.5 inline-flex size-4 items-center justify-center rounded-full bg-success text-success-foreground ring-2 ring-card"><IconCheck className="size-2.5" strokeWidth={3} /></span>
                </span>
                {a.name}
                <span className="tabular ml-auto text-xs text-muted-foreground">{a.at?.slice(5)}</span>
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </div>
  );
}
