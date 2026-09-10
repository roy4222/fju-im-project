import Link from "next/link";
import { notFound } from "next/navigation";
import { IconArrowLeft, IconClock, IconFileText, IconHistory, IconPaperclip, IconUsersGroup } from "@tabler/icons-react";
import { buttonVariants } from "@/components/ui/button";
import { PageTitle, Panel, Pill, StateBadge } from "@/components/dashboard/primitives";
import { Ring, SegmentBar } from "@/components/dashboard/charts";
import { GroupForm } from "@/components/dashboard/group-form";
import { ReopenDialog } from "@/components/dashboard/reopen-dialog";
import { isValidRole } from "@/lib/nav-config";
import { CURRENT_USERS, FORM_SCHEMAS, GROUPS, GROUP_SUBMISSIONS, MANAGED_ITEMS, PLACEMENT_LABEL, SUBMISSION_VERSIONS, daysUntil, formatDue, type Role } from "@/lib/fixtures";

export default async function AffairItemPage({ params, searchParams }: PageProps<"/dashboard/[role]/affairs/[id]">) {
  const { role, id } = await params;
  const sp = await searchParams;
  if (!isValidRole(role)) notFound();
  const item = MANAGED_ITEMS.find((i) => i.id === id);
  if (!item) notFound();
  const base = `/dashboard/${role}`;
  const fields = FORM_SCHEMAS[item.id] ?? [];
  const rows = GROUP_SUBMISSIONS[item.id] ?? [];
  const versions = SUBMISSION_VERSIONS[item.id] ?? [];
  const due = item.dueAt ? daysUntil(item.dueAt) : null;

  const header = (
    <div className="flex flex-col gap-3">
      <Link href={`${base}/affairs`} className="inline-flex w-fit items-center gap-1 text-[13px] font-semibold text-muted-foreground transition-colors hover:text-foreground"><IconArrowLeft className="size-4" /> 專題事務</Link>
      <PageTitle
        title={item.title}
        description={item.summary}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone="default">{PLACEMENT_LABEL[item.placement]}</Pill>
            {item.dueAt ? <Pill tone={due! < 0 ? "danger" : due! <= 10 ? "brand" : "default"}><IconClock className="mr-1 size-3" />{formatDue(item.dueAt)}・{item.dueAt}</Pill> : null}
            {item.schemaVersion ? <Pill tone="info">v{item.schemaVersion}</Pill> : null}
            {role === "admin" ? <Link href={`${base}/editor/${item.id}`} className={buttonVariants({ size: "lg", className: "press rounded-lg" })}>編輯內容</Link> : null}
          </div>
        }
      />
    </div>
  );

  /* ---------------- 學生：組別共用表單 */
  if (role === "student") {
    const locked = item.myState === "overdue" || item.myState === "locked";
    return (
      <div className="flex flex-col gap-5">
        {header}
        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
          <Panel title={locked ? "已截止" : item.myState === "submitted" ? "已繳交・可重送" : "填寫"} icon={<IconFileText />} description="同組成員看到同一份草稿，均可編輯">
            <div className="p-5">
              <GroupForm fields={fields} state={item.myState ?? "todo"} locked={locked} backHref={`${base}/affairs`} itemTitle={item.title} />
            </div>
          </Panel>
          <div className="flex flex-col gap-5">
            <Panel title="狀態" icon={<IconUsersGroup />}>
              <div className="flex items-center gap-4 px-5 py-4">
                <StateBadge state={item.myState ?? "todo"} className="text-xs" />
                <span className="text-sm text-muted-foreground">第 07 組</span>
              </div>
            </Panel>
            <Panel title="歷次版本" icon={<IconHistory />} description="每次正式送出保留快照">
              {versions.length === 0 ? (
                <p className="px-5 py-4 text-sm text-muted-foreground">尚未送出</p>
              ) : (
                <ul className="divide-y divide-border">
                  {versions.map((v) => (
                    <li key={v.version} className="flex items-start gap-3 px-5 py-3 text-sm">
                      <span className="tabular rounded bg-muted px-1.5 py-0.5 text-xs font-bold">v{v.version}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block font-semibold">{v.by} 送出</span>
                        <span className="tabular block text-xs text-muted-foreground">{v.at}・欄位版本 {v.schemaVersion}</span>
                        {v.note ? <span className="block text-xs text-muted-foreground">{v.note}</span> : null}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        </div>
      </div>
    );
  }

  /* ---------------- 老師／管理員：各組狀態 */
  const me = CURRENT_USERS.teacher;
  const groups = role === "teacher" ? GROUPS.filter((g) => g.advisorId === me.id) : GROUPS;
  const focus = typeof sp.group === "string" ? sp.group : undefined;
  const done = rows.filter((r) => r.state === "submitted").length;
  const overdue = rows.filter((r) => r.state === "overdue").length;
  return (
    <div className="flex flex-col gap-5">
      {header}
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <Panel title={role === "teacher" ? "我的指導組別" : "各組狀態"} icon={<IconUsersGroup />} description={`${groups.length} 組`}>
          <ul className="divide-y divide-border">
            {groups.map((g) => {
              const r = rows.find((x) => x.groupId === g.id);
              return (
                <li key={g.id} className={`flex flex-wrap items-center gap-3 px-5 py-3.5 transition-colors ${focus === g.id ? "bg-brand-subtle/40" : ""}`}>
                  <span className="tabular w-16 shrink-0 text-xs font-semibold text-muted-foreground">{g.no}</span>
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold">{g.title.replace(/（產學：.*）/, "")}</span>
                  <StateBadge state={r?.state ?? "todo"} />
                  {r?.at ? <span className="tabular text-xs text-muted-foreground">v{r.version}・{r.submittedBy}・{r.at.slice(5)}</span> : <span className="text-xs text-muted-foreground">—</span>}
                  {r?.state === "submitted" ? <button type="button" className={buttonVariants({ size: "sm", variant: "outline", className: "press rounded-lg" })}><IconPaperclip /> 檢視</button> : null}
                  {role === "admin" && (r?.state === "overdue" || r?.state === "todo") ? <ReopenDialog groupNo={g.no} itemTitle={item.title} /> : null}
                </li>
              );
            })}
          </ul>
        </Panel>
        <div className="flex flex-col gap-5">
          <Panel title="收件進度" icon={<IconFileText />}>
            <div className="flex items-center gap-5 px-5 py-4">
              <Ring value={rows.length ? (done / rows.length) * 100 : 0} size={84} stroke={9} color="var(--success)">
                <span className="tabular text-base font-extrabold">{rows.length ? Math.round((done / rows.length) * 100) : 0}%</span>
              </Ring>
              <dl className="grid flex-1 grid-cols-1 gap-1.5 text-sm">
                <div className="flex justify-between"><dt className="text-muted-foreground">已繳</dt><dd className="tabular font-semibold">{done}</dd></div>
                <div className="flex justify-between"><dt className="text-muted-foreground">逾期</dt><dd className="tabular font-semibold text-destructive">{overdue}</dd></div>
                <div className="flex justify-between"><dt className="text-muted-foreground">未繳</dt><dd className="tabular font-semibold">{rows.length - done - overdue}</dd></div>
              </dl>
            </div>
            <div className="px-5 pb-4"><SegmentBar segments={[{ value: done, color: "var(--success)", label: "已繳" }, { value: overdue, color: "var(--destructive)", label: "逾期" }, { value: rows.length - done - overdue, color: "var(--muted)", label: "未繳" }]} /></div>
          </Panel>
          <Panel title="欄位" icon={<IconFileText />} description={`${fields.length} 個・版本 ${item.schemaVersion ?? 1}`}>
            <ul className="flex flex-col gap-1 px-5 py-3 text-sm">
              {fields.filter((f) => !["heading", "paragraph", "divider", "groupinfo"].includes(f.type)).map((f) => (
                <li key={f.id} className="flex items-center justify-between gap-2 py-1"><span className="truncate">{f.label}</span>{f.required ? <span className="text-[11px] text-destructive">必填</span> : null}</li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  );
}
