import Link from "next/link";
import { IconChevronRight } from "@tabler/icons-react";
import { MemberStack, PageHead, TabBar, WorkLegend, WorkSquare } from "@/components/dashboard/teacher-v2";
import { GROUPS, SIGNOFF } from "@/lib/fixtures";
import { DOT_LABEL, TEACHER_BASE as base, approvedStudents, consentsWaitingForMe, groupWork, myConsents, myGroups, shortTitle, workItems } from "@/lib/teacher-v2";

/**
 * 老師：作業區 v2（Roy 2026-10-15，Q81）。分頁 各組繳交｜同意書。
 * 各組繳交不用表格：每組一張卡，每份作業一個小方塊（已交／缺交／逾期），點進去看該組版本與附件。
 * 同意書：待我同意的放最前，點進去同意／不同意。
 */
export function TeacherWork({ tab }: { tab?: string }) {
  const active = tab === "consent" ? "consent" : "work";
  return (
    <div className="flex flex-col gap-6">
      <PageHead title="作業區" />
      <TabBar
        label="作業區分頁"
        active={active}
        tabs={[
          { key: "work", label: "各組繳交", href: `${base}/affairs` },
          { key: "consent", label: "同意書", href: `${base}/affairs?tab=consent`, count: consentsWaitingForMe().length },
        ]}
      />
      {active === "work" ? <WorkTab /> : <ConsentTab />}
    </div>
  );
}

function WorkTab() {
  const items = workItems();
  return (
    <>
      <WorkLegend />
      <ul className="grid gap-4 md:grid-cols-2" data-cards>
        {myGroups().map((g) => {
          const work = groupWork(g.id);
          const done = work.filter((w) => w.dot === "done").length;
          const overdue = work.some((w) => w.dot === "overdue");
          return (
            <li key={g.id}>
              <Link href={`${base}/affairs/group/${g.id}`} data-group-card={g.id} className="dash-card-hover group flex h-full flex-col gap-4 rounded-3xl border border-border/80 bg-card p-5 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ring/40">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="tabular text-[12px] font-bold text-muted-foreground">{g.no}</p>
                    <h2 className="mt-0.5 truncate text-[17px] font-extrabold">{shortTitle(g.title)}</h2>
                  </div>
                  <IconChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex gap-1.5">
                    {work.map((w) => <WorkSquare key={w.item.id} state={w.dot} title={`${w.item.title}：${DOT_LABEL[w.dot]}`} />)}
                  </div>
                  <span className={`tabular text-sm font-bold ${overdue ? "text-destructive" : done === items.length ? "text-success-on-subtle" : "text-muted-foreground"}`}>已交 {done}／{items.length}</span>
                </div>
                <MemberStack members={g.members} />
              </Link>
            </li>
          );
        })}
      </ul>
    </>
  );
}

const CONSENT_CHIP = {
  teacher: { label: "待我同意", cls: "bg-brand text-white" },
  students: { label: "學生收集中", cls: "bg-muted text-muted-foreground" },
  revision: { label: "退回修正", cls: "bg-destructive-subtle text-destructive-on-subtle" },
  complete: { label: "已完成", cls: "bg-success-subtle text-success-on-subtle" },
} as const;

function ConsentTab() {
  return (
    <ul className="grid gap-4 md:grid-cols-2" data-consents>
      {myConsents().map((p) => {
        const g = GROUPS.find((x) => x.id === p.groupId)!;
        const approved = new Set(approvedStudents(p.groupId).map((a) => a.name));
        const chip = CONSENT_CHIP[p.state];
        const ready = p.state === "teacher";
        return (
          <li key={p.groupId}>
            <Link href={`${base}/affairs/signoff/${p.groupId}`} data-consent-card={p.state} className={`dash-card-hover group flex h-full flex-col gap-4 rounded-3xl border p-5 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ring/40 ${ready ? "border-brand/40 bg-brand-subtle/60" : "border-border/80 bg-card"}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="tabular text-[12px] font-bold text-muted-foreground">{p.groupNo}・{SIGNOFF.title}</p>
                  <h2 className="mt-0.5 truncate text-[17px] font-extrabold">{shortTitle(p.title)}</h2>
                </div>
                <span className={`shrink-0 rounded-full px-2.5 py-1 text-[12px] font-bold ${chip.cls}`}>{chip.label}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <MemberStack members={g.members} approved={approved} />
                <span className="tabular text-sm font-bold text-muted-foreground">學生 {p.students}／{p.total}</span>
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
