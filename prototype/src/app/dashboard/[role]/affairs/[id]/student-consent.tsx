import Link from "next/link";
import { IconArrowLeft, IconCheck, IconSignature } from "@tabler/icons-react";
import { ApproveActions } from "@/components/dashboard/signoff-actions";
import { ConsentReader } from "@/components/dashboard/consent-reader";
import { TodoTag } from "@/components/dashboard/student-v1";
import { CURRENT_USERS, SIGNOFF } from "@/lib/fixtures";
import { CONSENT_ID, studentTodos } from "@/lib/student-v1";
import { CONSENT_FILE } from "../../signoff/consent-file";

/**
 * 學生 v1：同意書詳情（從交作業的同意書卡點進來）。全文＋同意／不同意；右邊是全組表態。
 * 規則照舊：每個人只能提交自己的同意；五人全同意後才輪到指導老師。
 */
export function StudentConsent() {
  const me = CURRENT_USERS.student;
  const mine = SIGNOFF.studentApprovals.find((a) => a.name === me.name);
  const approved = SIGNOFF.studentApprovals.filter((a) => a.approved).length;
  const todo = studentTodos().find((t) => t.id === CONSENT_ID)!;

  return (
    <div className="flex flex-col gap-5">
      <Link href="/dashboard/student/affairs" className="inline-flex w-fit items-center gap-1 rounded-md text-[13px] font-semibold text-muted-foreground transition-colors hover:text-foreground"><IconArrowLeft className="size-4" /> 交作業</Link>

      <header className="flex flex-wrap items-center gap-4 rounded-3xl bg-accent/70 p-5 md:p-6">
        <span className="inline-flex size-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground"><IconSignature className="size-6" /></span>
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-bold tracking-[0.06em] text-muted-foreground">同意書・沒有截止日</p>
          <h1 className="text-[22px] font-extrabold tracking-tight">{SIGNOFF.title}</h1>
        </div>
        <TodoTag todo={todo} />
      </header>

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_19rem]">
        <section aria-label="同意書全文" className="dash-card overflow-hidden">
          <ConsentReader file={CONSENT_FILE.file} version={CONSENT_FILE.version} updatedAt={CONSENT_FILE.updatedAt} alreadyDone={!!mine?.approved}>
            {mine && !mine.approved ? <ApproveActions who={me.name} title={SIGNOFF.title} packageVersion={SIGNOFF.packageVersion} /> : <div className="flex items-center gap-2 rounded-lg bg-success-subtle px-4 py-3 text-sm font-semibold text-success-on-subtle"><IconCheck className="size-4" /> 你已同意（{mine?.at}）</div>}
          </ConsentReader>
        </section>

        <aside aria-labelledby="consent-who" className="dash-card p-5">
          <h2 id="consent-who" className="text-[15px] font-bold">全組表態 <span className="tabular ml-1 text-sm text-muted-foreground">{approved}/5</span></h2>
          <ul className="mt-4 flex flex-col gap-3">
            {SIGNOFF.studentApprovals.map((a) => (
              <li key={a.name} className="flex items-center gap-3 text-sm">
                <span className={`relative inline-flex size-9 shrink-0 items-center justify-center rounded-full text-[12px] font-bold ${a.approved ? "bg-success-subtle text-success-on-subtle" : "bg-muted text-muted-foreground"}`}>
                  {a.name.slice(-2)}
                  {a.approved ? <span className="absolute -right-0.5 -bottom-0.5 inline-flex size-4 items-center justify-center rounded-full bg-success text-success-foreground ring-2 ring-card"><IconCheck className="size-2.5" strokeWidth={3} /></span> : null}
                </span>
                <span className={a.name === me.name ? "font-bold" : ""}>{a.name}{a.name === me.name ? "（你）" : ""}</span>
                <span className="tabular ml-auto text-xs text-muted-foreground">{a.approved ? a.at?.slice(5) : "還沒表態"}</span>
              </li>
            ))}
          </ul>
          <p className="mt-4 border-t border-border pt-3 text-xs leading-relaxed text-muted-foreground">五位都同意後輪到 {SIGNOFF.teacherApproval.name} 老師簽核。老師簽核前可以改變表態。</p>
        </aside>
      </div>
    </div>
  );
}
