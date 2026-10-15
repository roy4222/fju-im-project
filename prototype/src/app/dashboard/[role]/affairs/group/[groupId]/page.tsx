import Link from "next/link";
import { notFound } from "next/navigation";
import { IconArrowLeft, IconCalendarEvent, IconPaperclip } from "@tabler/icons-react";
import { MemberStack, WorkSquare } from "@/components/dashboard/teacher-v2";
import { FORM_SCHEMAS } from "@/lib/fixtures";
import { DOT_LABEL, TEACHER_BASE as base, groupWork, myGroups, shortTitle } from "@/lib/teacher-v2";

/** 老師：某組的作業（從作業區的組卡點進來）。每份作業一張卡：狀態、第幾次、誰交的、附件。 */
export default async function TeacherGroupWorkPage({ params }: PageProps<"/dashboard/[role]/affairs/group/[groupId]">) {
  const { role, groupId } = await params;
  if (role !== "teacher") notFound();
  const g = myGroups().find((x) => x.id === groupId);
  if (!g) notFound();
  const work = groupWork(g.id);

  return (
    <div className="flex flex-col gap-6">
      <Link href={`${base}/affairs`} className="inline-flex w-fit items-center gap-1 text-[13px] font-semibold text-muted-foreground transition-colors hover:text-foreground"><IconArrowLeft className="size-4" /> 作業區</Link>
      <header className="flex flex-wrap items-center justify-between gap-4 rounded-3xl bg-accent/70 p-5 md:p-6">
        <div className="min-w-0">
          <p className="tabular text-[13px] font-bold text-muted-foreground">{g.no}・{g.type === "INDUSTRY" ? "產學合作" : "一般專題"}</p>
          <h1 className="mt-0.5 text-[24px] leading-tight font-extrabold tracking-tight">{shortTitle(g.title)}</h1>
        </div>
        <MemberStack members={g.members} />
      </header>

      <ul className="grid gap-4 md:grid-cols-2" data-items>
        {work.map(({ item, sub, dot }) => {
          const files = (FORM_SCHEMAS[item.id] ?? []).filter((f) => f.type === "file").map((f) => `${f.label}.pdf`);
          return (
            <li key={item.id} className="dash-card flex flex-col gap-3 p-5" data-item={dot}>
              <div className="flex items-start gap-3">
                <WorkSquare state={dot} title={DOT_LABEL[dot]} />
                <div className="min-w-0 flex-1">
                  <h2 className="text-[16px] leading-snug font-extrabold">{item.title}</h2>
                  <p className="tabular mt-0.5 flex items-center gap-1 text-[13px] text-muted-foreground"><IconCalendarEvent className="size-3.5" />{item.dueAt ? `${Number(item.dueAt.slice(5, 7))}/${Number(item.dueAt.slice(8, 10))} 截止` : "沒有截止日"}</p>
                </div>
                <span className={`shrink-0 rounded-full px-2.5 py-1 text-[12px] font-bold ${dot === "done" ? "bg-success-subtle text-success-on-subtle" : dot === "overdue" ? "bg-destructive-subtle text-destructive-on-subtle" : "bg-muted text-muted-foreground"}`}>{sub?.state === "draft" ? "草稿中" : DOT_LABEL[dot]}</span>
              </div>
              {dot === "done" && sub?.version ? (
                <div className="rounded-2xl bg-muted/50 px-4 py-3">
                  <p className="tabular text-sm font-bold">第 {sub.version} 次・{sub.submittedBy}・{sub.at?.slice(5).replace("-", "/")}</p>
                  <ul className="mt-2 flex flex-wrap gap-2">
                    {(files.length ? files : [`${item.title}.pdf`]).map((f) => (
                      <li key={f}><a href="#" className="inline-flex items-center gap-1 rounded-full bg-card px-3 py-1 text-[13px] font-semibold text-primary ring-1 ring-border hover:bg-accent"><IconPaperclip className="size-3.5" />{f}</a></li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
