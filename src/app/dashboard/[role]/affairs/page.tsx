import Link from "next/link";
import { notFound } from "next/navigation";
import { IconClipboardText, IconClock, IconPencilPlus, IconPaperclip } from "@tabler/icons-react";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState, PageTitle, Panel, Pill, ProgressBar, StatTile, StateBadge } from "@/components/dashboard/primitives";
import { Ring, SegmentBar } from "@/components/dashboard/charts";
import { PillLink } from "@/components/public/pill-link";
import { isValidRole } from "@/lib/nav-config";
import { CURRENT_USERS, GROUPS, GROUP_SUBMISSIONS, MANAGED_ITEMS, PLACEMENT_LABEL, daysUntil, formatDue, type Placement, type Role } from "@/lib/fixtures";

export default async function AffairsPage({ params, searchParams }: PageProps<"/dashboard/[role]/affairs">) {
  const { role } = await params;
  const sp = await searchParams;
  if (!isValidRole(role)) notFound();
  if (role === "student") return <StudentAffairs role={role} />;
  if (role === "teacher") return <TeacherAffairs role={role} />;
  return <AdminAffairs role={role} placement={typeof sp.placement === "string" ? sp.placement : "all"} />;
}

/* ---------------------------------------------------------------- 學生 */
function StudentAffairs({ role }: { role: Role }) {
  const base = `/dashboard/${role}`;
  const items = MANAGED_ITEMS.filter((i) => i.myState).sort((a, b) => daysUntil(a.dueAt ?? "2099-01-01") - daysUntil(b.dueAt ?? "2099-01-01"));
  const groups: { key: string; title: string; filter: (s: string) => boolean }[] = [
    { key: "open", title: "待完成", filter: (s) => s === "todo" || s === "draft" || s === "resubmit" },
    { key: "overdue", title: "已逾期", filter: (s) => s === "overdue" },
    { key: "done", title: "已繳交", filter: (s) => s === "submitted" || s === "locked" },
  ];
  return (
    <div className="flex flex-col gap-5">
      <PageTitle title="我的專題事務" description="整組共用一份，任一組員送出即代表全組完成。" />
      {groups.map((g) => {
        const list = items.filter((i) => g.filter(i.myState!));
        return (
          <Panel key={g.key} title={g.title} icon={<IconClipboardText />} description={`${list.length} 項`}>
            {list.length === 0 ? (
              <EmptyState title={`沒有${g.title}的項目`} />
            ) : (
              <ul className="grid gap-4 p-4 md:grid-cols-2 xl:grid-cols-3">
                {list.map((item) => (
                  <li key={item.id}>
                    <Link href={`${base}/affairs/${item.id}`} className="card-lift flex h-full flex-col gap-3 rounded-xl border border-border bg-background p-4">
                      <div className="flex items-center justify-between gap-2">
                        <Pill tone="default">{PLACEMENT_LABEL[item.placement]}</Pill>
                        <StateBadge state={item.myState!} />
                      </div>
                      <p className="text-[15px] font-bold leading-snug">{item.title}</p>
                      <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">{item.summary}</p>
                      <div className="mt-auto flex items-center justify-between pt-1 text-xs text-muted-foreground">
                        {item.dueAt ? (
                          <span className={`tabular inline-flex items-center gap-1 font-semibold ${daysUntil(item.dueAt) < 0 ? "text-destructive" : daysUntil(item.dueAt) <= 10 ? "text-brand" : ""}`}>
                            <IconClock className="size-3.5" /> {formatDue(item.dueAt)}・{item.dueAt.slice(5)}
                          </span>
                        ) : <span />}
                        {item.attachments ? <span className="inline-flex items-center gap-1"><IconPaperclip className="size-3.5" />{item.attachments}</span> : null}
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------------- 老師 */
function TeacherAffairs({ role }: { role: Role }) {
  const base = `/dashboard/${role}`;
  const me = CURRENT_USERS.teacher;
  const myGroups = GROUPS.filter((g) => g.advisorId === me.id);
  const items = MANAGED_ITEMS.filter((i) => i.progress);
  return (
    <div className="flex flex-col gap-5">
      <PageTitle title="各組繳交狀態" description={`我的 ${myGroups.length} 個指導組別 × ${items.length} 個收件項目`} />
      <Panel title="繳交矩陣" icon={<IconClipboardText />} description="點狀態看版本與內容">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-muted/60 text-xs text-muted-foreground">
              <tr>
                <th className="sticky left-0 bg-muted/60 px-5 py-2.5 text-left font-semibold">組別</th>
                {items.map((i) => (
                  <th key={i.id} className="px-3 py-2.5 text-left font-semibold">
                    <span className="block truncate">{i.title}</span>
                    <span className="tabular font-normal">截止 {i.dueAt?.slice(5)}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {myGroups.map((g) => (
                <tr key={g.id} className="transition-colors hover:bg-accent/40">
                  <td className="sticky left-0 bg-card px-5 py-3">
                    <span className="tabular text-xs font-semibold text-muted-foreground">{g.no}</span>
                    <span className="block truncate font-semibold">{g.title.replace(/（產學：.*）/, "")}</span>
                  </td>
                  {items.map((i) => {
                    const s = GROUP_SUBMISSIONS[i.id]?.find((r) => r.groupId === g.id);
                    return (
                      <td key={i.id} className="px-3 py-3">
                        <Link href={`${base}/affairs/${i.id}?group=${g.id}`} className="inline-flex flex-col gap-1">
                          <StateBadge state={s?.state ?? "todo"} />
                          {s?.at ? <span className="tabular text-[11px] text-muted-foreground">v{s.version}・{s.at.slice(5, 10)}</span> : null}
                        </Link>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

/* ---------------------------------------------------------------- 管理員 */
function AdminAffairs({ role, placement }: { role: Role; placement: string }) {
  const base = `/dashboard/${role}`;
  const all = MANAGED_ITEMS;
  const items = placement === "all" ? all : all.filter((i) => i.placement === placement);
  const placements = [...new Set(all.map((i) => i.placement))] as Placement[];
  const published = all.filter((i) => i.status === "published").length;
  const totalDone = all.reduce((a, i) => a + (i.progress?.done ?? 0), 0);
  const totalAll = all.reduce((a, i) => a + (i.progress?.total ?? 0), 0);
  const overdue = all.reduce((a, i) => a + (i.progress?.overdue ?? 0), 0);
  return (
    <div className="flex flex-col gap-5">
      <PageTitle title="專題事務工作台" description="公告、資源、文件繳交、專題需求共用同一個編輯器與生命週期。" actions={<Link href={`${base}/editor/new`} className="btn-fju h-10 px-4 text-sm"><IconPencilPlus className="size-4" /> 新增項目</Link>} />
      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile label="發布中" value={published} unit="項" hint={`共 ${all.length} 項`} chart={<Ring value={(published / all.length) * 100} size={44} stroke={5} />} />
        <StatTile label="整體收件" value={`${totalDone}/${totalAll}`} tone="success" chart={<Ring value={(totalDone / totalAll) * 100} size={44} stroke={5} color="var(--success)" />} />
        <StatTile label="逾期組別" value={overdue} unit="組" tone={overdue ? "danger" : "default"} hint="需個別重新開放" chart={<Ring value={(overdue / totalAll) * 100} size={44} stroke={5} color="var(--destructive)" />} />
      </div>
      <Panel
        title="全部項目"
        icon={<IconClipboardText />}
        action={
          <nav className="flex flex-wrap gap-1.5" aria-label="發布位置">
            <PillLink href={`${base}/affairs`} active={placement === "all"}>全部</PillLink>
            {placements.map((p) => (
              <PillLink key={p} href={`${base}/affairs?placement=${p}`} active={placement === p}>{PLACEMENT_LABEL[p]}</PillLink>
            ))}
          </nav>
        }
      >
        <ul className="divide-y divide-border">
          {items.map((i) => (
            <li key={i.id} className="grid items-center gap-3 px-5 py-3.5 md:grid-cols-[minmax(0,1.5fr)_10rem_14rem_auto]">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Pill tone="default">{PLACEMENT_LABEL[i.placement]}</Pill>
                  <Pill tone={i.status === "published" ? "success" : i.status === "draft" ? "info" : "default"}>{i.status === "published" ? "發布中" : i.status === "draft" ? "草稿" : "已下架"}</Pill>
                  {i.schemaVersion ? <span className="tabular text-[11px] text-muted-foreground">v{i.schemaVersion}</span> : null}
                </div>
                <Link href={`${base}/affairs/${i.id}`} className="link-ink mt-1 block truncate text-[15px] font-bold">{i.title}</Link>
                <p className="truncate text-xs text-muted-foreground">{i.audience}</p>
              </div>
              <div className="text-xs text-muted-foreground">
                {i.dueAt ? <span className={`tabular inline-flex items-center gap-1 font-semibold ${daysUntil(i.dueAt) < 0 ? "text-destructive" : "text-foreground"}`}><IconClock className="size-3.5" />{i.dueAt}</span> : <span>無截止</span>}
              </div>
              <div>{i.progress ? <ProgressBar done={i.progress.done} total={i.progress.total} overdue={i.progress.overdue} /> : <span className="text-xs text-muted-foreground">不收件</span>}</div>
              <div className="flex gap-2">
                <Link href={`${base}/affairs/${i.id}`} className={buttonVariants({ size: "sm", variant: "outline", className: "press rounded-lg" })}>狀態</Link>
                <Link href={`${base}/editor/${i.id}`} className={buttonVariants({ size: "sm", className: "press rounded-lg" })}>編輯</Link>
              </div>
            </li>
          ))}
        </ul>
        {items.length === 0 ? <EmptyState title="這個位置沒有項目" /> : null}
      </Panel>
      {placement === "all" ? (
        <Panel title="各位置收件概況" icon={<IconClipboardText />}>
          <ul className="grid gap-4 p-5 md:grid-cols-2">
            {all.filter((i) => i.progress).map((i) => (
              <li key={i.id} className="flex flex-col gap-2">
                <div className="flex items-center justify-between text-sm"><span className="truncate font-semibold">{i.title}</span><span className="tabular text-xs text-muted-foreground">{i.progress!.done}/{i.progress!.total}</span></div>
                <SegmentBar segments={[{ value: i.progress!.done, color: "var(--success)", label: "已繳" }, { value: i.progress!.overdue, color: "var(--destructive)", label: "逾期" }, { value: i.progress!.total - i.progress!.done - i.progress!.overdue, color: "var(--muted)", label: "未繳" }]} />
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </div>
  );
}
