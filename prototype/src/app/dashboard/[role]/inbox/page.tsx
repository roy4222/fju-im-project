import Link from "next/link";
import { notFound } from "next/navigation";
import { IconBell, IconCalendarDue, IconChecklist, IconSettings, IconSignature, IconUpload, IconUserCheck } from "@tabler/icons-react";
import { EmptyState, PageTitle, Panel } from "@/components/dashboard/primitives";
import { buttonVariants } from "@/components/ui/button";
import { isValidRole } from "@/lib/nav-config";
import { NOTIFICATIONS, type Notification } from "@/lib/fixtures";

const KIND_ICON: Record<Notification["kind"], typeof IconBell> = { due: IconCalendarDue, submission: IconUpload, signoff: IconSignature, grading: IconChecklist, account: IconUserCheck, system: IconSettings };
const KIND_TONE: Record<Notification["kind"], string> = { due: "bg-muted text-foreground", submission: "bg-muted text-foreground", signoff: "bg-muted text-foreground", grading: "bg-muted text-foreground", account: "bg-muted text-foreground", system: "bg-muted text-muted-foreground" };
const KIND_LABEL: Record<Notification["kind"], string> = { due: "截止", submission: "繳交", signoff: "簽核", grading: "評分", account: "帳號", system: "系統" };

/** 通知列表（規格：通知放後台，前台不做；Roy 2026-09-07） */
export default async function InboxPage({ params }: PageProps<"/dashboard/[role]/inbox">) {
  const { role } = await params;
  if (!isValidRole(role)) notFound();
  const notes = NOTIFICATIONS[role];
  const unread = notes.filter((n) => !n.read);
  return (
    <div className="flex flex-col gap-5">
      <PageTitle title="通知" description={unread.length ? `${unread.length} 則未讀` : "全部已讀"} actions={<button type="button" className={buttonVariants({ variant: "outline", size: "lg", className: "press rounded-lg" })}>全部標為已讀</button>} />
      <Panel title="全部" icon={<IconBell />}>
        {notes.length === 0 ? (
          <EmptyState icon={<IconBell />} title="沒有通知" />
        ) : (
          <ul className="divide-y divide-border">
            {notes.map((n) => {
              const Icon = KIND_ICON[n.kind];
              return (
                <li key={n.id}>
                  <Link href={n.href} className={`flex items-start gap-4 px-5 py-4 transition-colors hover:bg-accent/60 ${n.read ? "" : "bg-accent/40"}`}>
                    <span className={`mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-lg ${KIND_TONE[n.kind]}`}><Icon className="size-4.5" /></span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-muted-foreground">{KIND_LABEL[n.kind]}</span>
                        <span className={`truncate text-[15px] ${n.read ? "font-medium" : "font-bold"}`}>{n.title}</span>
                      </span>
                      <span className="mt-0.5 block text-sm text-muted-foreground">{n.body}</span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-1.5">
                      <time className="tabular text-xs text-muted-foreground">{n.at}</time>
                      {!n.read ? <span className="size-2 rounded-full bg-brand" aria-label="未讀" /> : null}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}
